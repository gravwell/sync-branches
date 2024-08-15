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
	{ owner, repo, actionsOctokit }: EventContext,
	{ branch }: { branch: string },
): Promise<Awaited<ReturnType<Octokit['repos']['getBranch']>>['data']> => {
	try {
		const { data } = await actionsOctokit.repos.getBranch({ branch, owner, repo });
		return data;
	} catch {
		throw new Error(`Could not find target branch: ${branch}`);
	}
};

/**
 * Checks to see if a branch exists, and if it doesn't, creates that branch
 *
 * Returns true if a branch was created, otherwise false. Throws if the branch _can't_ be created.I
 */
const createBranch = async (
	{ owner, repo, actionsOctokit }: EventContext,
	{ branch, sha }: { branch: string; sha: string },
): Promise<boolean> => {
	try {
		const foundBranch = await actionsOctokit.repos.getBranch({ branch, owner, repo });
		core.info(`Found branch ${branch} at ${foundBranch.data.commit.sha}`);
		return false;
	} catch {
		core.debug(`Branch ${branch} not found. Will try to create it.`);
		try {
			const newBranch = await actionsOctokit.git.createRef({ owner, repo, ref: branchAsRef(branch), sha });
			core.info(`Created branch ${branch} at ${newBranch.data.object.sha}`);
			return true;
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
	{ owner, repo, actionsOctokit }: EventContext,
	{ base, head }: { base: string; head: string },
): Promise<boolean> => {
	core.debug(`Will attempt to merge ${head} into ${base}`);
	const { status } = await actionsOctokit.repos.merge({ owner, repo, base, head });

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
 * Given a list of notes, constructs a comment containing a list of those notes.
 *
 * If the comment fails to post, this fn won't throw. It only logs.
 */
const comment = async (
	{ owner, repo, actionsOctokit }: EventContext,
	{ number: pull_number }: { number: number },
	{ notes }: { notes: string[] },
): Promise<void> => {
	if (notes.length === 0) {
		core.debug('Skip commenting. Nothing to do.');
		return;
	}

	const commentReportTemplate = `
\`sync-branches\` Action reports the following:

{{#notes}}
- {{{.}}}
{{/notes}}
`;

	const body = Mustache.render(commentReportTemplate, { notes });
	core.debug(`Constructed comment from ${JSON.stringify(notes)}: ${body}`);

	try {
		core.debug('Posting comment');
		await actionsOctokit.issues.createComment({ owner, repo, issue_number: pull_number, body });
		core.debug('Posted comment');
	} catch (err) {
		core.warning(`Failed to create comment`);
		if (err instanceof Error) {
			core.warning(err);
		} else {
			core.warning(`${err}`);
		}
	}
};

/**
 * Applies the given label to the PR
 *
 * If the label fails to apply, this fn won't throw. It only logs.
 */
const applyLabel = async (
	{ owner, repo, actionsOctokit }: EventContext,
	{ number: pull_number, labels }: { number: number; labels: { name: string }[] },
	{ label }: { label: string },
): Promise<void> => {
	if (label === '') {
		core.debug('Empty label. Skipping application');
		return;
	}

	if (labels.map(l => l.name).includes(label) === true) {
		core.debug(`Already have label "${label}". Skipping application`);
		return;
	}

	try {
		core.debug(`Applying label: ${label}`);
		await actionsOctokit.issues.addLabels({ owner, repo, issue_number: pull_number, labels: [label] });
		core.debug(`Applied label: ${label}`);
	} catch (err) {
		core.warning(`Failed to apply label`);
		if (err instanceof Error) {
			core.warning(err);
		} else {
			core.warning(`${err}`);
		}
	}
};

/**
 * Removes the given label from the PR
 *
 * If the label fails to remove, this fn won't throw. It only logs.
 */
const removeLabel = async (
	{ owner, repo, actionsOctokit }: EventContext,
	{ number: pull_number, labels }: { number: number; labels: { name: string }[] },
	{ label }: { label: string },
): Promise<void> => {
	if (label === '') {
		core.debug('Empty label. Skipping removal');
		return;
	}

	if (labels.map(l => l.name).includes(label) === false) {
		core.debug(`Already missing label "${label}". Skipping removal`);
		return;
	}

	try {
		core.debug(`Removing label: ${label}`);
		await actionsOctokit.issues.removeLabel({ owner, repo, issue_number: pull_number, name: label });
		core.debug(`Removed label: ${label}`);
	} catch (err) {
		core.warning(`Failed to remove label`);
		if (err instanceof Error) {
			core.warning(err);
		} else {
			core.warning(`${err}`);
		}
	}
};

/** Descirbes any conflicts we may have encountered when merging branches */
type ConflictSummary = {
	sourceConflict: boolean;
	targetConflict: boolean;
};

/**
 * Adds labels and comments describing merge conflicts to a PR.
 *
 * This function is designed not to throw. It will log if there are failures
 * creating comments or adding/removing labels.
 */
const reportConflicts = async (
	ctx: EventContext,
	pr: { number: number; labels: { name: string }[] },
	{
		sourceBranch,
		targetBranch,
		intermediateBranch,
		conflicts,
	}: {
		sourceBranch: string;
		targetBranch: string;
		intermediateBranch: string;
		conflicts: ConflictSummary;
	},
): Promise<void> => {
	const notes: string[] = [];

	if (conflicts.sourceConflict) {
		notes.push(
			`Failed to merge \`${sourceBranch}\` into \`${intermediateBranch}\`. Possibly a conflict? It may help to delete branch \`${intermediateBranch}\` and re-run your \`sync-branches\` job in order to start fresh.`,
		);
		applyLabel(ctx, pr, { label: ctx.sourceConflictLabel });
	} else {
		core.debug(`Encountered no ${sourceBranch} => ${intermediateBranch} conflict`);
		removeLabel(ctx, pr, { label: ctx.sourceConflictLabel });
	}

	if (conflicts.targetConflict) {
		notes.push(
			`Failed to merge \`${targetBranch}\` into \`${intermediateBranch}\`. Possibly a conflict? Check the status of this PR below.`,
		);
		applyLabel(ctx, pr, { label: ctx.targetConflictLabel });
	} else {
		core.debug(`Encountered no ${targetBranch} => ${intermediateBranch} conflict`);
		removeLabel(ctx, pr, { label: ctx.targetConflictLabel });
	}

	for (const note of notes) {
		core.warning(note);
	}

	await comment(ctx, pr, { notes });
};

/**
 * Closes, pauses, then reopens a given PR.
 *
 * GitHub won't execute workflows in response to an event caused by GITHUB_TOKEN. This function
 * allows us to use the user's PAT (if it's provided) to "kick" GitHub into running Actions.
 *
 * As long as the close+reopen requests come from a PAT and not GITHUB_TOKEN, then Workflows should run.
 */
const kickCI = async (
	{ owner, repo, actionsOctokit, prOctokit }: EventContext,
	{ pull_number }: { pull_number: number },
): Promise<void> => {
	if (actionsOctokit === prOctokit) {
		core.debug('Actions Octokit is the same as PR Octokit. Skipping CI kick.');
	}

	core.debug(`Closing ${pull_number}`);
	await prOctokit.pulls.update({ owner, repo, pull_number, state: 'closed' });
	core.debug(`Closed ${pull_number}`);

	// Give GitHub a moment
	await new Promise(resolve => setTimeout(resolve, 5_000));

	core.debug(`Reopening ${pull_number}`);
	await prOctokit.pulls.update({ owner, repo, pull_number, state: 'open' });
	core.debug(`Reopened ${pull_number}`);
};

type EventContext = {
	/** The owner of the repo: "gravwell" in "gravwell/frontend" */
	owner: string;
	/** The name of the repo: "frontend" in "gravwell/frontend" */
	repo: string;

	/** The NAME of the branch (not the full ref) that was pushed to. The one that triggered this workflow. */
	pushedBranch: string;

	/**
	 * true if we should use an intermediate branch to merge "pushedBranch" into "targetBranch".
	 * Otherwise we just open a PR that merges "pushedBranch" directly into "targetBranch"
	 */
	useIntermediateBranch: boolean;

	/** The pattern used to match the source (head) branch */
	sourceBranchPattern: string;
	/** The pattern used to match the target (base) branch */
	targetBranchPattern: string;
	/** The template to be used for the PR title */
	prTitleTemplate: string;
	/** the template to be used for the PR body */
	prBodyTemplate: string;

	/** The name of a label to apply to the PR if a src-intermediate conflict is detected */
	sourceConflictLabel: string;
	/** The name of a label to apply to the PR if a target-intermediate conflict is detected */
	targetConflictLabel: string;

	/** The default instance of octokit created using GITHUB_TOKEN */
	actionsOctokit: Octokit;
	/** The instance of Octokit that should be used to create/update sync PRs */
	prOctokit: Octokit;
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
const handlePushToSourceBranch = async (
	ctx: EventContext,

	/** The NAME of the branch (not the full ref) that requires a sync because "pushedBranch" was pushed to. */
	targetBranch: string,
): Promise<PRUpdate | null> => {
	const {
		owner,
		repo,
		pushedBranch,
		useIntermediateBranch,
		actionsOctokit,
		prOctokit,
		prTitleTemplate,
		prBodyTemplate,
		sourceBranchPattern,
	} = ctx;

	core.info(`Opening/Updating sync PR: ${pushedBranch} => ${targetBranch}`);

	// Make sure the target branch exists
	await getBranch(ctx, { branch: targetBranch });

	const head = useIntermediateBranch
		? `merge/${pushedBranch.replace(/\//g, '-')}_to_${targetBranch.replace(/\//g, '-')}`
		: pushedBranch;

	// Track encountered merge conflicts
	const conflicts: ConflictSummary = { sourceConflict: false, targetConflict: false };

	// true if we need to close+reopen the PR to start CI, otherwise false
	let needsKick = false;

	if (useIntermediateBranch) {
		// Try to fetch the pushed branch
		const {
			commit: { sha: baseCommit },
		} = await getBranch(ctx, { branch: pushedBranch });

		// create the intermediate branch off of source branch (pushed branch) (if necessary)
		await createBranch(ctx, { branch: head, sha: baseCommit });

		// merge the source branch into the intermediate branch
		// this'll be a no-op if the branch is new, but may pull in changes if it's not.
		try {
			needsKick = await merge(ctx, { base: head, head: pushedBranch });
			conflicts.sourceConflict = false;
		} catch {
			conflicts.sourceConflict = true;
		}

		// merge the target branch into the intermediate branch
		try {
			needsKick = await merge(ctx, { base: head, head: targetBranch });
			conflicts.targetConflict = false;
		} catch {
			conflicts.targetConflict = true;
		}
	}

	// List existing pulls from the given source to the desired target branch
	const { data: pulls } = await actionsOctokit.pulls.list({
		owner,
		repo,
		base: targetBranch,
		head,
		state: 'open',
	});
	const existingPRs = pulls.filter(p => p.head.ref === head && p.base.ref === targetBranch);
	if (existingPRs.length > 1) {
		core.warning(`Found multiple PRs from ${head} to ${targetBranch}. That's impossible... Merging the first one.`);
	}

	const existingPR = existingPRs[0];
	if (existingPR !== undefined) {
		core.info(`A PR from ${head} to ${targetBranch} already exists.`);

		await reportConflicts(ctx, existingPR, {
			sourceBranch: pushedBranch,
			intermediateBranch: head,
			targetBranch,
			conflicts,
		});

		if (needsKick) {
			await kickCI(ctx, { pull_number: existingPR.number });
			core.info(`Successfully updated PR: ${existingPR.html_url}`);
			return {
				baseBranch: existingPR.base.ref,
				headBranch: existingPR.head.ref,
				sourceBranch: pushedBranch,
				targetBranch,
				url: existingPR.html_url,
			};
		}
		core.debug('Skipping close+reopen.');

		return null; // PR existed, didn't update it, didn't kick it, didn't change it
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
		repo,
		title,
		body,
		head,
		base: targetBranch,
	});
	core.debug(`Created new pull request: ${JSON.stringify(newPr)}`);

	core.info(`Successfully created PR: ${newPr.html_url}`);

	await reportConflicts(ctx, newPr, {
		sourceBranch: pushedBranch,
		intermediateBranch: head,
		targetBranch,
		conflicts,
	});

	return {
		baseBranch: newPr.base.ref,
		headBranch: newPr.head.ref,
		sourceBranch: pushedBranch,
		targetBranch,
		url: newPr.html_url,
	};
};

/** Updates a single sync PR when there is a push to the TARGET (base) branch of that PR*/
const handlePushToTargetBranch = async (
	ctx: EventContext,

	/** The NAME of the branch (not the full ref) that requires a sync because "pushedBranch" was pushed to. */
	sourceBranch: string,
): Promise<PRUpdate | null> => {
	const { owner, repo, pushedBranch, useIntermediateBranch, actionsOctokit } = ctx;

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
		repo,
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
	const conflicts: ConflictSummary = { sourceConflict: false, targetConflict: false };

	try {
		needsKick = await merge(ctx, { base: head, head: pushedBranch });
		conflicts.targetConflict = false;
	} catch {
		core.warning(`Failed to merge ${pushedBranch} into ${head}. Possibly a conflict?`);
		conflicts.targetConflict = true;
	}

	await reportConflicts(ctx, existingPR, {
		sourceBranch,
		intermediateBranch: head,
		targetBranch: pushedBranch,
		conflicts,
	});

	if (needsKick) {
		await kickCI(ctx, { pull_number: existingPR.number });
		core.info(`Successfully updated PR: ${existingPR.html_url}`);

		return {
			baseBranch: existingPR.base.ref,
			headBranch: existingPR.head.ref,
			sourceBranch,
			targetBranch: pushedBranch,
			url: existingPR.html_url,
		};
	}
	core.debug('Skipping close+reopen.');
	return null; // PR existed, didn't update it, didn't kick it, didn't change it
};

/** Creates/Updates sync PRs according to provided branch patterns */
async function updateSyncPRs(actionsOctokit: Octokit): Promise<void> {
	const {
		ref,
		repository: {
			name: repo,
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
		repo,
		pushedBranch,

		sourceBranchPattern: core.getInput('source_pattern', { required: true }),
		targetBranchPattern: core.getInput('target_pattern', { required: true }),
		useIntermediateBranch: core.getBooleanInput('use_intermediate_branch', { required: true }),

		prTitleTemplate: core.getInput('pr_title', { required: true }),
		prBodyTemplate: core.getInput('pr_body', { required: true }),

		sourceConflictLabel: core.getInput('source_conflict_label'),
		targetConflictLabel: core.getInput('target_conflict_label'),

		actionsOctokit,
		prOctokit,
	};

	const { data: branches } = await actionsOctokit.repos.listBranches({ owner, repo });

	const syncedPRs: PRUpdate[] = [];

	// If this action was triggered by a push to a SOURCE branch...
	if (minimatch(pushedBranch, ctx.sourceBranchPattern) === true) {
		core.debug(
			`Matched source pattern: ${JSON.stringify({ pushedBranch, sourceBranchPattern: ctx.sourceBranchPattern })}`,
		);
		const targets = branches.map(b => b.name).filter(b => minimatch(b, ctx.targetBranchPattern));
		core.debug(`Will open/update sync PRs targeting: ${targets}`);

		for (const targetBranch of targets) {
			try {
				const update = await handlePushToSourceBranch(ctx, targetBranch);
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

	// If this action was triggered by a push to a TARGET branch...
	if (minimatch(pushedBranch, ctx.targetBranchPattern) === true) {
		core.debug(
			`Matched target pattern: ${JSON.stringify({ pushedBranch, targetBranchPattern: ctx.targetBranchPattern })}`,
		);
		const sources = branches.map(b => b.name).filter(b => minimatch(b, ctx.sourceBranchPattern));
		core.debug(`Will update sync PRs with sources: ${sources}`);

		for (const sourceBranch of sources) {
			try {
				const update = await handlePushToTargetBranch(ctx, sourceBranch);
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
