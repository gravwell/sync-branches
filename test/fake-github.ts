import { Octokit } from '@octokit/action';

/** A pull request in the fake repo. */
export type FakePR = {
	number: number;
	head: string;
	base: string;
	title: string;
	body: string;
	state: 'open' | 'closed';
	labels: string[];
};

/** One call to the fake API, for assertions. */
export type Call = { method: string; params: Record<string, unknown> };

const httpError = (status: number, message: string): Error => Object.assign(new Error(message), { status });

/**
 * A tiny in-memory GitHub repo: commits, branches, merges, and pull requests.
 *
 * Commits are ids with their full ancestry, so "is X already merged into Y" and "how far ahead is X" work like git.
 * Like GitHub's merge API, a merge always makes a merge commit. It never fast-forwards.
 */
export class FakeGitHub {
	readonly branches = new Map<string, string>();
	readonly prs: FakePR[] = [];
	readonly comments: { issue_number: number; body: string }[] = [];
	readonly calls: Call[] = [];

	private readonly ancestry = new Map<string, Set<string>>();
	private readonly conflicts = new Set<string>();
	private commitCount = 0;
	private prCount = 100;

	/** Creates a branch with one new commit, on top of `from` or as a new root. */
	branch(name: string, from?: string): this {
		this.branches.set(name, this.commit(from === undefined ? [] : [this.head(from)]));
		return this;
	}

	/** Adds a commit to a branch, like a push. */
	push(name: string): this {
		this.branches.set(name, this.commit([this.head(name)]));
		return this;
	}

	/** Merges `head` into `base` with a merge commit, like merging a pull request. */
	mergeInto(base: string, head: string): this {
		this.branches.set(base, this.commit([this.head(base), this.head(head)]));
		return this;
	}

	/** Makes the merge API report a conflict when merging `head` into `base`. */
	conflict(base: string, head: string): this {
		this.conflicts.add(`${base} <- ${head}`);
		return this;
	}

	head(name: string): string {
		const sha = this.branches.get(name);
		if (sha === undefined) {
			throw new Error(`No branch ${name}`);
		}
		return sha;
	}

	/** True if every commit on `head` is on `base`. */
	contains(base: string, head: string): boolean {
		return this.aheadBy(base, head) === 0;
	}

	/** The number of commits on `head` that aren't on `base`. */
	aheadBy(base: string, head: string): number {
		const onBase = this.ancestors(this.head(base));
		return [...this.ancestors(this.head(head))].filter(c => !onBase.has(c)).length;
	}

	openPRs(): FakePR[] {
		return this.prs.filter(pr => pr.state === 'open');
	}

	/** Calls to the given methods, in order. */
	callsTo(...methods: string[]): Call[] {
		return this.calls.filter(c => methods.includes(c.method));
	}

	/** An Octokit stand-in with only the methods the action uses. */
	octokit(): Octokit {
		const record = (method: string, params: Record<string, unknown>): void => {
			this.calls.push({ method, params });
		};
		const toApi = (pr: FakePR) => ({
			number: pr.number,
			html_url: `https://github.com/owner/repo/pull/${pr.number}`,
			head: { ref: pr.head },
			base: { ref: pr.base },
			labels: pr.labels.map(name => ({ name })),
		});
		const findPR = (n: number): FakePR => {
			const pr = this.prs.find(p => p.number === n);
			if (pr === undefined) {
				throw httpError(404, `No PR ${n}`);
			}
			return pr;
		};

		const fake = {
			repos: {
				getBranch: async (p: { branch: string }) => {
					record('repos.getBranch', p);
					const sha = this.branches.get(p.branch);
					if (sha === undefined) {
						throw httpError(404, 'Branch not found');
					}
					return { data: { name: p.branch, commit: { sha } } };
				},
				listBranches: async (p: { per_page?: number; page?: number }) => {
					record('repos.listBranches', p);
					const perPage = p.per_page ?? 30;
					const page = p.page ?? 1;
					const all = [...this.branches].map(([name, sha]) => ({ name, commit: { sha } }));
					return { data: all.slice((page - 1) * perPage, page * perPage) };
				},
				merge: async (p: { base: string; head: string }) => {
					record('repos.merge', p);
					if (this.conflicts.has(`${p.base} <- ${p.head}`)) {
						throw httpError(409, 'Merge conflict');
					}
					if (this.contains(p.base, p.head)) {
						return { status: 204 };
					}
					this.mergeInto(p.base, p.head);
					return { status: 201 };
				},
				compareCommitsWithBasehead: async (p: { basehead: string }) => {
					record('repos.compareCommitsWithBasehead', p);
					const [base = '', head = ''] = p.basehead.split('...');
					return { data: { ahead_by: this.aheadBy(base, head), behind_by: this.aheadBy(head, base) } };
				},
			},
			git: {
				createRef: async (p: { ref: string; sha: string }) => {
					record('git.createRef', p);
					const name = p.ref.replace(/^refs\/heads\//, '');
					if (this.branches.has(name)) {
						throw httpError(422, 'Reference already exists');
					}
					this.branches.set(name, p.sha);
					return { data: { object: { sha: p.sha } } };
				},
			},
			pulls: {
				list: async (p: { base: string; state: string }) => {
					record('pulls.list', p);
					return { data: this.prs.filter(pr => pr.state === p.state && pr.base === p.base).map(toApi) };
				},
				create: async (p: { head: string; base: string; title: string; body: string }) => {
					record('pulls.create', p);
					if (this.contains(p.base, p.head)) {
						throw httpError(422, `No commits between ${p.base} and ${p.head}`);
					}
					const pr: FakePR = { number: ++this.prCount, ...p, state: 'open', labels: [] };
					this.prs.push(pr);
					return { data: toApi(pr) };
				},
				update: async (p: { pull_number: number; state: 'open' | 'closed' }) => {
					record('pulls.update', p);
					const pr = findPR(p.pull_number);
					pr.state = p.state;
					return { data: toApi(pr) };
				},
			},
			issues: {
				createComment: async (p: { issue_number: number; body: string }) => {
					record('issues.createComment', p);
					this.comments.push(p);
					return { data: {} };
				},
				addLabels: async (p: { issue_number: number; labels: string[] }) => {
					record('issues.addLabels', p);
					findPR(p.issue_number).labels.push(...p.labels);
					return { data: {} };
				},
				removeLabel: async (p: { issue_number: number; name: string }) => {
					record('issues.removeLabel', p);
					const pr = findPR(p.issue_number);
					pr.labels = pr.labels.filter(l => l !== p.name);
					return { data: {} };
				},
			},
		};
		return fake as unknown as Octokit;
	}

	private commit(parents: string[]): string {
		const id = `c${++this.commitCount}`;
		const ancestors = new Set([id]);
		for (const parent of parents) {
			for (const c of this.ancestors(parent)) {
				ancestors.add(c);
			}
		}
		this.ancestry.set(id, ancestors);
		return id;
	}

	private ancestors(sha: string): Set<string> {
		const a = this.ancestry.get(sha);
		if (a === undefined) {
			throw new Error(`No commit ${sha}`);
		}
		return a;
	}
}
