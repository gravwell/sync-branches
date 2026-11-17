import * as core from '@actions/core';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { load } from 'js-yaml';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/sync';
import { FakeGitHub } from './fake-github';

vi.mock('@actions/core', async importOriginal => ({
	...(await importOriginal<typeof import('@actions/core')>()),
	setFailed: vi.fn(),
	setOutput: vi.fn(),
	info: vi.fn(),
	debug: vi.fn(),
	warning: vi.fn(),
	error: vi.fn(),
}));

type ActionYaml = { inputs: Record<string, { default?: string }> };
const inputs = (load(readFileSync(join(__dirname, '..', 'action.yml'), 'utf8')) as ActionYaml).inputs;

type RunOptions = {
	event: 'push' | 'workflow_dispatch' | 'schedule' | 'pull_request';
	/** The branch the run is on: the pushed branch, or the branch a schedule or dispatch ran on. */
	branch: string;
	source: string;
	target: string;
	intermediate?: boolean;
};

/** Runs the action against the fake repo, the way a workflow step would. */
const runAction = async (gh: FakeGitHub, o: RunOptions): Promise<void> => {
	const ref = `refs/heads/${o.branch}`;
	// A schedule event's payload has no ref or repository.
	const payload =
		o.event === 'schedule'
			? { schedule: '47 17 * * 1-5' }
			: { ref, repository: { name: 'repo', owner: { login: 'owner' } } };
	const eventPath = join(mkdtempSync(join(tmpdir(), 'sync-branches-')), 'event.json');
	writeFileSync(eventPath, JSON.stringify(payload));

	const env: Record<string, string> = {
		GITHUB_EVENT_NAME: o.event,
		GITHUB_EVENT_PATH: eventPath,
		GITHUB_REPOSITORY: 'owner/repo',
		GITHUB_REF: ref,
		INPUT_GITHUB_TOKEN: 'token',
		INPUT_PR_CREATE_TOKEN: '',
		INPUT_SOURCE_PATTERN: o.source,
		INPUT_TARGET_PATTERN: o.target,
		INPUT_USE_INTERMEDIATE_BRANCH: String(o.intermediate ?? true),
		INPUT_PR_TITLE: inputs.pr_title?.default ?? '',
		INPUT_PR_BODY: inputs.pr_body?.default ?? '',
		INPUT_SOURCE_CONFLICT_LABEL: 'src conflict',
		INPUT_TARGET_CONFLICT_LABEL: 'conflict',
	};
	for (const [name, value] of Object.entries(env)) {
		vi.stubEnv(name, value);
	}

	await run(() => gh.octokit());
	// The action adds and removes labels without awaiting them. Let them land.
	await new Promise(resolve => setImmediate(resolve));
};

/** The states the action set on PRs, in order. ['closed', 'open'] is one CI kick. */
const kicks = (gh: FakeGitHub): unknown[] => gh.callsTo('pulls.update').map(c => c.params.state);

/** Calls that change the repo. */
const writes = (gh: FakeGitHub) =>
	gh.callsTo('git.createRef', 'repos.merge', 'pulls.create', 'pulls.update', 'issues.createComment');

const mainToNextPatch = { source: 'main', target: 'next-patch' };

/** A repo where main has one commit that next-patch doesn't. */
const mainAhead = (): FakeGitHub => new FakeGitHub().branch('main').branch('next-patch', 'main').push('main');

/** mainAhead, after a push to main opened the main => next-patch sync PR. */
const withSyncPR = async (): Promise<FakeGitHub> => {
	const gh = mainAhead();
	await runAction(gh, { event: 'push', branch: 'main', ...mainToNextPatch });
	gh.calls.length = 0;
	return gh;
};

beforeEach(() => {
	// Skip the 5 second pause between closing and reopening a PR.
	vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
		fn();
		return 0;
	}) as unknown as typeof setTimeout);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe('push', () => {
	it('opens a sync PR through a new intermediate branch when the source moves', async () => {
		const gh = mainAhead();

		await runAction(gh, { event: 'push', branch: 'main', ...mainToNextPatch });

		// One open PR from merge/main_to_next-patch with the default title.
		expect(gh.openPRs()).toMatchObject([
			{ head: 'merge/main_to_next-patch', base: 'next-patch', title: 'chore: Merge main into next-patch' },
		]);
		// The intermediate branch holds both main and next-patch.
		expect(gh.contains('merge/main_to_next-patch', 'main')).toBe(true);
		expect(gh.contains('merge/main_to_next-patch', 'next-patch')).toBe(true);
		// A new PR needs no close and reopen.
		expect(kicks(gh)).toEqual([]);
	});

	it('merges new source commits into the open sync PR and restarts its CI', async () => {
		const gh = await withSyncPR();
		gh.push('main');

		await runAction(gh, { event: 'push', branch: 'main', ...mainToNextPatch });

		// Still one PR; it has the new commit and was closed and reopened.
		expect(gh.openPRs()).toHaveLength(1);
		expect(gh.contains('merge/main_to_next-patch', 'main')).toBe(true);
		expect(kicks(gh)).toEqual(['closed', 'open']);
	});

	it('merges new target commits into the open sync PR and restarts its CI', async () => {
		const gh = await withSyncPR();
		gh.push('next-patch');

		await runAction(gh, { event: 'push', branch: 'next-patch', ...mainToNextPatch });

		// The intermediate branch has the new next-patch commit, and the PR was closed and reopened.
		expect(gh.contains('merge/main_to_next-patch', 'next-patch')).toBe(true);
		expect(kicks(gh)).toEqual(['closed', 'open']);
	});

	it('leaves the open sync PR alone when nothing changed', async () => {
		const gh = await withSyncPR();

		await runAction(gh, { event: 'push', branch: 'main', ...mainToNextPatch });
		await runAction(gh, { event: 'push', branch: 'next-patch', ...mainToNextPatch });

		// No close and reopen, and no new PR.
		expect(kicks(gh)).toEqual([]);
		expect(gh.prs).toHaveLength(1);
	});

	it('does nothing when the target moves and no sync PR is open', async () => {
		const gh = new FakeGitHub().branch('main').branch('next-patch', 'main').push('next-patch');

		await runAction(gh, { event: 'push', branch: 'next-patch', ...mainToNextPatch });

		// No branches, merges, PRs or comments.
		expect(writes(gh)).toEqual([]);
	});

	it('does nothing on a push to a branch that matches neither pattern', async () => {
		const gh = mainAhead().branch('feature', 'main');

		await runAction(gh, { event: 'push', branch: 'feature', ...mainToNextPatch });

		// No branches, merges, PRs or comments.
		expect(writes(gh)).toEqual([]);
	});

	it('opens a sync PR for each branch that matches the target pattern', async () => {
		const gh = new FakeGitHub()
			.branch('next-major')
			.branch('preview/major/a', 'next-major')
			.branch('preview/major/b', 'next-major')
			.push('next-major');

		await runAction(gh, { event: 'push', branch: 'next-major', source: 'next-major', target: 'preview/major/*' });

		// One PR per preview branch, with slashes in the branch name turned into dashes.
		expect(gh.openPRs().map(pr => [pr.head, pr.base])).toEqual([
			['merge/next-major_to_preview-major-a', 'preview/major/a'],
			['merge/next-major_to_preview-major-b', 'preview/major/b'],
		]);
	});

	it('labels the sync PR and comments when the source conflicts with the intermediate branch', async () => {
		const gh = await withSyncPR();
		gh.push('main').conflict('merge/main_to_next-patch', 'main');

		await runAction(gh, { event: 'push', branch: 'main', ...mainToNextPatch });

		// The PR has the source conflict label and a comment naming the failed merge.
		expect(gh.openPRs()[0]?.labels).toEqual(['src conflict']);
		expect(gh.comments[0]?.body).toContain('Failed to merge `main` into `merge/main_to_next-patch`');
	});

	it('labels the sync PR when the target conflicts with the intermediate branch', async () => {
		const gh = await withSyncPR();
		gh.push('next-patch').conflict('merge/main_to_next-patch', 'next-patch');

		await runAction(gh, { event: 'push', branch: 'next-patch', ...mainToNextPatch });

		// The PR has the target conflict label.
		expect(gh.openPRs()[0]?.labels).toEqual(['conflict']);
	});

	it('opens a PR straight from the source without an intermediate branch', async () => {
		const gh = mainAhead();

		await runAction(gh, { event: 'push', branch: 'main', ...mainToNextPatch, intermediate: false });

		// The PR's head is main itself, and no branch was created.
		expect(gh.openPRs()).toMatchObject([{ head: 'main', base: 'next-patch' }]);
		expect(gh.callsTo('git.createRef')).toEqual([]);
	});

	it('skips the sync when the source has nothing new for the target and no sync PR is open', async () => {
		const gh = new FakeGitHub().branch('main').branch('next-patch', 'main');

		await runAction(gh, { event: 'push', branch: 'main', ...mainToNextPatch });

		// No intermediate branch, merges, PRs or comments.
		expect(writes(gh)).toEqual([]);
	});
});

describe.each(['schedule', 'workflow_dispatch'] as const)('%s', event => {
	const nextPatchToNextMinor = { source: 'next-patch', target: 'next-minor' };

	/** A repo where next-patch has one commit that next-minor doesn't. */
	const nextPatchAhead = (): FakeGitHub =>
		new FakeGitHub().branch('main').branch('next-patch', 'main').branch('next-minor', 'next-patch').push('next-patch');

	/** nextPatchAhead, after a run opened the next-patch => next-minor sync PR. */
	const withNextMinorSyncPR = async (): Promise<FakeGitHub> => {
		const gh = nextPatchAhead();
		await runAction(gh, { event, branch: 'main', ...nextPatchToNextMinor });
		gh.calls.length = 0;
		return gh;
	};

	it('opens a sync PR from the source, whatever branch the run is on', async () => {
		const gh = nextPatchAhead();

		await runAction(gh, { event, branch: 'main', ...nextPatchToNextMinor });

		// One open PR from merge/next-patch_to_next-minor, though the run was on main.
		expect(gh.openPRs()).toMatchObject([{ head: 'merge/next-patch_to_next-minor', base: 'next-minor' }]);
	});

	it('merges new source commits into the open sync PR and restarts its CI', async () => {
		const gh = await withNextMinorSyncPR();
		gh.push('next-patch');

		await runAction(gh, { event, branch: 'main', ...nextPatchToNextMinor });

		// The intermediate branch has the new next-patch commit, and the PR was closed and reopened.
		expect(gh.contains('merge/next-patch_to_next-minor', 'next-patch')).toBe(true);
		expect(kicks(gh)).toEqual(['closed', 'open']);
	});

	it('merges new target commits into the open sync PR and restarts its CI', async () => {
		const gh = await withNextMinorSyncPR();
		gh.push('next-minor');

		await runAction(gh, { event, branch: 'main', ...nextPatchToNextMinor });

		// The intermediate branch has the new next-minor commit, and the PR was closed and reopened.
		expect(gh.contains('merge/next-patch_to_next-minor', 'next-minor')).toBe(true);
		expect(kicks(gh)).toEqual(['closed', 'open']);
	});

	it('leaves the open sync PR alone when nothing changed', async () => {
		const gh = await withNextMinorSyncPR();

		await runAction(gh, { event, branch: 'main', ...nextPatchToNextMinor });

		// No close and reopen, and no new PR.
		expect(kicks(gh)).toEqual([]);
		expect(gh.prs).toHaveLength(1);
	});

	it('skips the sync when the source has nothing new and no sync PR is open', async () => {
		const gh = new FakeGitHub().branch('main').branch('next-patch', 'main').branch('next-minor', 'next-patch');

		await runAction(gh, { event, branch: 'main', ...nextPatchToNextMinor });

		// No intermediate branch, merges, PRs or comments.
		expect(writes(gh)).toEqual([]);
	});

	it('syncs every branch that matches the source pattern to every branch that matches the target pattern', async () => {
		const gh = new FakeGitHub()
			.branch('main')
			.branch('release/a', 'main')
			.branch('release/b', 'main')
			.branch('preview/a', 'main')
			.branch('preview/b', 'main')
			.push('release/a')
			.push('release/b');

		await runAction(gh, { event, branch: 'main', source: 'release/*', target: 'preview/*' });

		// One PR for each source and target pair.
		expect(gh.openPRs().map(pr => pr.head)).toEqual([
			'merge/release-a_to_preview-a',
			'merge/release-a_to_preview-b',
			'merge/release-b_to_preview-a',
			'merge/release-b_to_preview-b',
		]);
	});

	it('labels the sync PR when the target conflicts with the intermediate branch', async () => {
		const gh = await withNextMinorSyncPR();
		gh.push('next-minor').conflict('merge/next-patch_to_next-minor', 'next-minor');

		await runAction(gh, { event, branch: 'main', ...nextPatchToNextMinor });

		// The PR has the target conflict label.
		expect(gh.openPRs()[0]?.labels).toEqual(['conflict']);
	});
});

describe('branch list', () => {
	it('finds branches past the first page', async () => {
		const gh = new FakeGitHub().branch('next-major');
		for (let i = 0; i < 120; i++) {
			gh.branch(`feature/${i}`, 'next-major');
		}
		gh.branch('preview/major/a', 'next-major').push('next-major');

		await runAction(gh, { event: 'push', branch: 'next-major', source: 'next-major', target: 'preview/major/*' });

		// The preview branch, 122nd in the list, gets its sync PR.
		expect(gh.openPRs()).toMatchObject([{ head: 'merge/next-major_to_preview-major-a' }]);
	});
});

describe('events', () => {
	it('fails on an event it does not support', async () => {
		const gh = mainAhead();

		await runAction(gh, { event: 'pull_request', branch: 'main', ...mainToNextPatch });

		// The run fails, and nothing in the repo changes.
		expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('only works on'));
		expect(writes(gh)).toEqual([]);
	});
});
