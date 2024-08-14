import * as core from '@actions/core';
import { Octokit } from '@octokit/action';
import { createTokenAuth } from '@octokit/auth-token';
import { RequestError } from '@octokit/request-error';
import { isNil } from 'lodash';
import { minimatch } from 'minimatch';
import Mustache from 'mustache';
import { checkPushEventEnv } from './github-events';

/**
 * Creates a new Octokit instance that authenticates with the given Personal Access Token (PAT)
 * instead of GITHUB_TOKEN (which is the default auth strategy for @octokit/action)
 */
const mkOctokitFromPAT = async (token: string): Promise<Octokit> => {
	core.debug('Creating new octokit');
	const o = new Octokit({
		authStrategy: () => {
			return createTokenAuth(token);
		},
	});
	core.debug('New octokit created');

	core.debug('Auth new octokit');
	await o.auth();
	core.debug(`Authed new octokit`);

	return o;
};

/** Grabs the branchName out of a ref like "refs/heads/branchName" */
const refAsBranch = (ref: string): string | null => ref.match(/^refs\/heads\/(?<branch>.*)$/)?.groups?.branch ?? null;

/** Constructs a ref from a branchName : refs/heads/brachName */
const branchAsRef = (ref: string): string => `refs/heads/${ref}`;

/** Fetches the given branch from the remote. Throws if not found. */
const getBranch = async (
	okit: Octokit,
	{ owner, repo, branch }: { owner: string; repo: string; branch: string },
): Promise<Awaited<ReturnType<Octokit['repos']['getBranch']>>['data']> => {
	try {
		const { data } = await okit.repos.getBranch({ branch, owner, repo });
		return data;
	} catch {
		throw new Error(`Could not find target branch: ${branch}`);
	}
};

/** Checks to see if a branch exists, and if it doesn't, creates that branch */
const createBranch = async (
	okit: Octokit,
	{ owner, repo, branch, sha }: { owner: string; repo: string; branch: string; sha: string },
): Promise<void> => {
	try {
		const foundBranch = await okit.repos.getBranch({ branch, owner, repo });
		core.info(`Found branch ${branch} at ${foundBranch.data.commit.sha}`);
	} catch {
		core.debug(`Branch ${branch} not found. Will try to create it.`);
		try {
			const newBranch = await okit.git.createRef({ owner, repo, ref: branchAsRef(branch), sha });
			core.info(`Created branch ${branch} at ${newBranch.data.object.sha}`);
		} catch {
			throw new Error(`Failed to create branch: ${branch}`);
		}
	}
};

/** Merges "head" into "base" on the given owner/repo.
 *
 * Returns true if a merge commit was created, otherwise false
 *
 * If the merge **fails** for any reason (permission trouble, merge conflict), then this function will throw.
 *
 * Status code reference: https://docs.github.com/en/rest/branches/branches?apiVersion=2022-11-28#merge-a-branch--status-codes
 */
const merge = async (
	okit: Octokit,
	{ owner, repoName, base, head }: { owner: string; repoName: string; base: string; head: string },
): Promise<boolean> => {
	core.debug(`Will attempt to merge ${head} into ${base}`);
	const { status } = await okit.repos.merge({
		owner,
		repo: repoName,
		base,
		head,
	});

	if (status === 201) {
		core.info(`Merged ${head} into ${base}`);
		return true;
	}

	if (status === 204) {
		core.info(`${head} is already merged to ${base}`);
		return false;
	}

	// Unless we receive an undocumented 2xx return code, this code is unreachable.
	core.error(`Unknown return status (${status}). Assuming we don't need to kick CI.`);
	return false;
};

/**
 * Closes, pauses, then reopens a given PR.
 *
 * GitHub won't execute workflows in response to an event caused by GITHUB_TOKEN. This function
 * allows us to use the user's PAT (if it's provided) to "kick" GitHub into running Actions.
 *
 * As long as the close+reopen requests come from a PAT and not GITHUB_TOKEN, then Workflows should run.
 */
const kickCI = async (okit: Octokit, pr: { owner: string; repo: string; pull_number: number }): Promise<void> => {
	core.debug(`Closing ${pr.pull_number}`);
	await okit.pulls.update({
		owner: pr.owner,
		repo: pr.repo,
		pull_number: pr.pull_number,
		state: 'closed',
	});
	core.debug(`Closed ${pr.pull_number}`);

	// Give GitHub a moment
	await new Promise(resolve => setTimeout(resolve, 5_000));

	core.debug(`Reopening ${pr.pull_number}`);
	await okit.pulls.update({
		owner: pr.owner,
		repo: pr.repo,
		pull_number: pr.pull_number,
		state: 'open',
	});
	core.debug(`Reopened ${pr.pull_number}`);
};

type EventContext = {
	/** The owner of the repo: "gravwell" in "gravwell/frontend" */
	owner: string;
	/** The name of the repo: "frontend" in "gravwell/frontend" */
	repoName: string;

	/** The NAME of the branch (not the full ref) that was pushed to. The one that triggered this workflow. */
	pushedBranch: string;

	/**
	 * true if we should use an intermediate branch to merge "pushedBranch" into "targetBranch".
	 * Otherwise we just open a PR that merges "pushedBranch" directly into "targetBranch"
	 */
	useIntermediateBranch: boolean;

	/** The default instance of octokit created using GITHUB_TOKEN */
	actionsOctokit: Octokit;
	/** The instance of Octokit that should be used to create/update sync PRs */
	prOctokit: Octokit;

	/** The pattern used to match the source (head) branch */
	sourceBranchPattern: string;
	/** The pattern used to match the target (base) branch */
	targetBranchPattern: string;
	/** The template to be used for the PR title */
	prTitleTemplate: string;
	/** the template to be used for the PR body */
	prBodyTemplate: string;
};

/** Describes an updated PR */
type PRUpdate = {
	/** The source branch (changes come FROM this branch) */
	sourceBranch: string;
	/** The target branch (changes are heading TO this branch) */
	targetBranch: string;

	/** The head branch of the PR (same as source branch unless using an intermediate branch) */
	headBranch: string;
	/** The base branch of the PR (same as target branch) */
	baseBranch: string;

	/** The URL of the PR's web page */
	url: string;
};

/** Creates/Updates a single sync PR when there is a push to the SOURCE (head) branch of that PR */
const handlePushToSourceBranch = async ({
	owner,
	repoName,

	pushedBranch,
	targetBranch,

	useIntermediateBranch,

	actionsOctokit,
	prOctokit,

	prTitleTemplate,
	prBodyTemplate,
	sourceBranchPattern,
}: EventContext & {
	/** The NAME of the branch (not the full ref) that requires a sync because "pushedBranch" was pushed to. */
	targetBranch: string;
}): Promise<PRUpdate> => {
	core.info(`Opening/Updating sync PR: ${pushedBranch} => ${targetBranch}`);

	const head = useIntermediateBranch
		? `merge/${pushedBranch.replace(/\//g, '-')}_to_${targetBranch.replace(/\//g, '-')}`
		: pushedBranch;

	// true if we need to close+reopen the PR to start CI, otherwise false
	let needsKick = false;

	if (useIntermediateBranch) {
		// Try to fetch the target branch
		const {
			commit: { sha: baseCommit },
		} = await getBranch(actionsOctokit, { owner, repo: repoName, branch: targetBranch });

		// create the intermediate branch off of target branch (base) (if necessary)
		await createBranch(actionsOctokit, { owner, repo: repoName, branch: head, sha: baseCommit });

		// merge the source branch (head) into the intermediate branch
		try {
			needsKick = await merge(actionsOctokit, {
				owner,
				repoName,
				base: head,
				head: pushedBranch,
			});
		} catch {
			throw new Error(`Failed to merge ${pushedBranch} into ${head}. Maybe delete ${head}?`);
		}
	}

	// List existing pulls from the given source to the desired target branch
	const ownerHead = `${owner}:${head}`;
	const { data: pulls } = await actionsOctokit.pulls.list({
		owner,
		repo: repoName,
		base: targetBranch,
		head,
		state: 'open',
	});
	const existingPRs = pulls.filter(p => p.head.ref === head && p.base.ref === targetBranch);
	if (existingPRs.length > 1) {
		core.error(`Found multiple PRs from ${ownerHead} to ${targetBranch}. That's impossible.`);
		core.info("I guess I'll just merge the first one.");
	}

	const existingPR = existingPRs[0];
	if (existingPR !== undefined) {
		core.info(`A PR from ${ownerHead} to ${targetBranch} already exists.`);

		if (needsKick && prOctokit !== actionsOctokit) {
			await kickCI(prOctokit, { owner, repo: repoName, pull_number: existingPR.number });
		} else {
			core.debug('Skipping close+reopen.');
		}

		return {
			baseBranch: existingPR.base.ref,
			headBranch: existingPR.head.ref,
			sourceBranch: pushedBranch,
			targetBranch,
			url: existingPR.html_url,
		};
	}

	const templateContext = {
		source_pattern: sourceBranchPattern,
		original_source: pushedBranch,
		source: head,
		target: targetBranch,
		use_intermediate_branch: useIntermediateBranch,
	};

	const title = Mustache.render(prTitleTemplate, templateContext);
	const body = Mustache.render(prBodyTemplate, templateContext);

	// Apparently this NEEDS read&write for PR and at least read for contents... despite what the docs say.
	core.debug('Create new pull request');
	const { data: newPr } = await prOctokit.pulls.create({
		owner,
		repo: repoName,
		title,
		body,
		head: ownerHead,
		base: targetBranch,
		headers: {
			'X-GitHub-Api-Version': '2022-11-28',
		},
	});
	core.debug(`Created new pull request: ${JSON.stringify(newPr)}`);

	core.info(`Successfully created PR: ${newPr.html_url}`);

	return {
		baseBranch: newPr.base.ref,
		headBranch: newPr.head.ref,
		sourceBranch: pushedBranch,
		targetBranch,
		url: newPr.html_url,
	};
};

/** Updates a single sync PR when there is a push to the TARGET (base) branch of that PR*/
const handlePushToTargetBranch = async ({
	owner,
	repoName,

	pushedBranch,
	sourceBranch,

	useIntermediateBranch,

	actionsOctokit,
	prOctokit,
}: EventContext & {
	/** The NAME of the branch (not the full ref) that requires a sync because "pushedBranch" was pushed to. */
	sourceBranch: string;
}): Promise<PRUpdate | null> => {
	if (useIntermediateBranch === false) {
		// Only merge base to head if we're using an intermediate branch.
		core.info(`Update not required for ${sourceBranch} => ${pushedBranch}`);
		return null;
	}
	core.info(`Update ${sourceBranch} => ${pushedBranch}`);

	const head = `merge/${sourceBranch.replace(/\//g, '-')}_to_${pushedBranch.replace(/\//g, '-')}`;

	// List existing pulls from the given source to the desired target branch
	const { data: pulls } = await actionsOctokit.pulls.list({
		owner,
		repo: repoName,
		base: pushedBranch,
		head,
		state: 'open',
	});
	const existingPRs = pulls.filter(p => p.head.ref === head && p.base.ref === pushedBranch);
	if (existingPRs.length > 1) {
		core.error(`Found multiple PRs from ${head} to ${pushedBranch}. That's impossible.`);
	}

	const existingPR = existingPRs[0];
	if (existingPR === undefined) {
		core.info(`A PR from ${head} to ${pushedBranch} doesn't exist. Skipping update.`);
		return null;
	}

	// true if we need to close+reopen the PR to start CI, otherwise false
	let needsKick = false;

	try {
		needsKick = await merge(actionsOctokit, {
			owner,
			repoName,
			base: head,
			head: pushedBranch,
		});
	} catch {
		throw new Error(`Failed to merge ${pushedBranch} into ${head}. Maybe delete ${head}?`);
	}

	if (needsKick && prOctokit !== actionsOctokit) {
		await kickCI(prOctokit, { owner, repo: repoName, pull_number: existingPR.number });
	} else {
		core.debug('Skipping close+reopen.');
	}

	core.info(`Successfully updated PR: ${existingPR.html_url}`);

	return {
		baseBranch: existingPR.base.ref,
		headBranch: existingPR.head.ref,
		sourceBranch,
		targetBranch: pushedBranch,
		url: existingPR.html_url,
	};
};

/** Creates/Updates sync PRs according to provided branch patterns */
async function updateSyncPRs(actionsOctokit: Octokit): Promise<void> {
	const {
		ref,
		repository: {
			name: repoName,
			owner: { login: owner },
		},
	} = await checkPushEventEnv();

	const pushedBranch = refAsBranch(ref);
	if (isNil(pushedBranch)) {
		throw new Error(
			`Unable to determine head branch. ref was ${ref}. Did you forget to limit the workflow to only branches?`,
		);
	}

	const prToken = core.getInput('PR_CREATE_TOKEN');

	// Octokit based by a PAT, if provided, otherwise the default GITHUB_TOKEN octokit
	const prOctokit = await (prToken !== '' ? mkOctokitFromPAT(prToken) : actionsOctokit);

	const ctx: EventContext = {
		owner,
		repoName,
		pushedBranch,
		targetBranchPattern: core.getInput('target_pattern', { required: true }),
		useIntermediateBranch: core.getBooleanInput('use_intermediate_branch', { required: true }),
		actionsOctokit,
		prOctokit,
		prTitleTemplate: core.getInput('pr_title', { required: true }),
		prBodyTemplate: core.getInput('pr_body', { required: true }),
		sourceBranchPattern: core.getInput('source_pattern', { required: true }),
	};

	const { data: branches } = await actionsOctokit.repos.listBranches({ owner, repo: repoName });

	const syncedPRs: PRUpdate[] = [];

	// If this action was triggered by a push to a SOURCE branch...
	if (minimatch(pushedBranch, ctx.sourceBranchPattern) === true) {
		core.debug(`Matched source pattern: ${{ pushedBranch, sourceBranchPattern: ctx.sourceBranchPattern }}`);
		const targets = branches.map(b => b.name).filter(b => minimatch(b, ctx.targetBranchPattern));
		core.debug(`Will open/update sync PRs targeting: ${targets}`);

		for (const targetBranch of targets) {
			try {
				syncedPRs.push(await handlePushToSourceBranch({ ...ctx, targetBranch }));
			} catch (err: unknown) {
				if (err instanceof RequestError) {
					core.error(`status: ${err.status}`);
				}

				core.setFailed(err instanceof Error ? err : `${err}`);
			}
		}
	}

	// If this action was triggered by a push to a TARGET branch...
	if (minimatch(pushedBranch, ctx.targetBranchPattern) === true) {
		core.debug(`Matched target pattern: ${{ pushedBranch, targetBranchPattern: ctx.targetBranchPattern }}`);
		const sources = branches.map(b => b.name).filter(b => minimatch(b, ctx.sourceBranchPattern));
		core.debug(`Will update sync PRs with sources: ${sources}`);

		for (const sourceBranch of sources) {
			try {
				const update = await handlePushToTargetBranch({ ...ctx, sourceBranch });
				if (update) {
					syncedPRs.push(update);
				}
			} catch (err: unknown) {
				if (err instanceof RequestError) {
					core.error(`status: ${err.status}`);
				}

				core.setFailed(err instanceof Error ? err : `${err}`);
			}
		}
	}

	core.setOutput('syncedPRs', syncedPRs);

	core.info('Done');
}

async function run(): Promise<void> {
	if (process.env.GITHUB_EVENT_NAME !== 'push') {
		core.setFailed(`sync-branches only works on "push" events`);
		return;
	}

	try {
		// If unset, will throw.
		core.getInput('GITHUB_TOKEN', { required: true });

		const actionsOctokit = new Octokit();
		await updateSyncPRs(actionsOctokit);
	} catch (err: unknown) {
		if (err instanceof RequestError) {
			core.error(`status: ${err.status}`);
		}

		core.setFailed(err instanceof Error ? err : `${err}`);
	}
}

run();
