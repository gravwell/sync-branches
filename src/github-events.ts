import { Decoder, object, string } from 'decoders';
import { readFile } from 'fs/promises';

/**
 * Push event details
 * https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#push
 * https://docs.github.com/en/developers/webhooks-and-events/webhooks/webhook-events-and-payloads#push
 */
export type PushEvent = {
	after: string;
	ref: string;
	repository: {
		name: string;
		owner: {
			login: string;
		};
	};
};

export const pushEvent: Decoder<PushEvent> = object({
	after: string,
	ref: string,
	repository: object({
		name: string,
		owner: object({
			login: string,
		}),
	}),
});

/** Returns push event values gathered from CI environment variables */
export const checkPushEventEnv = async (): Promise<PushEvent> => {
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
	return pushEvent.verify(value);
};
