import { Decoder, object, string } from 'decoders';
import { readFile } from 'fs/promises';

/**
 * The parts of a push event that we use. `ref` is the branch that was pushed to.
 * https://docs.github.com/en/webhooks/webhook-events-and-payloads#push
 */
export type BranchEvent = {
	ref: string;
	repository: {
		name: string;
		owner: {
			login: string;
		};
	};
};

export const branchEvent: Decoder<BranchEvent> = object({
	ref: string,
	repository: object({
		name: string,
		owner: object({
			login: string,
		}),
	}),
});

/** Returns push event values gathered from CI environment variables */
export const checkBranchEventEnv = async (): Promise<BranchEvent> => {
	const eventPath = process.env.GITHUB_EVENT_PATH;
	if (!eventPath) {
		throw new Error('Expected non-nil event path');
	}

	const repoPath = process.env.GITHUB_REPOSITORY;
	if (!repoPath) {
		throw new Error('Expected non-nil repo path');
	}

	const buf = await readFile(eventPath);
	const value = JSON.parse(buf.toString());
	return branchEvent.verify(value);
};

/**
 * Returns the repo from GITHUB_REPOSITORY ("owner/repo").
 * Scheduled and manual runs use this: a schedule event's payload doesn't name the repo.
 */
export const repoFromEnv = (): { owner: string; repo: string } => {
	const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? '').split('/');
	if (!owner || !repo) {
		throw new Error('Expected GITHUB_REPOSITORY like "owner/repo"');
	}
	return { owner, repo };
};
