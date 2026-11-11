import { Decoder, object, string } from 'decoders';
import { readFile } from 'fs/promises';

/**
 * The parts of a push or workflow_dispatch event that we use.
 * In both, `ref` is the branch that was pushed to or that the workflow was run on.
 * https://docs.github.com/en/webhooks/webhook-events-and-payloads#push
 * https://docs.github.com/en/webhooks/webhook-events-and-payloads#workflow_dispatch
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

/** Returns push or workflow_dispatch event values gathered from CI environment variables */
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
