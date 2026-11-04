/**
 * The refusals the engine gives a reader who may not read a chat (register 1112): a chat that
 * holds data from a connected store and is neither the reader's nor read by the owner, and a live
 * run whose chat the engine cannot name. The engine sends its own English sentence and a `code`;
 * the page shows the sentence in its own language, keyed on the code (ux U-091).
 */
const KEYS = {
	contained_thread: 'contained.thread_read_refused',
	run_chat_unknown: 'contained.run_chat_unknown',
} as const;

export type ContainedReadKey = (typeof KEYS)[keyof typeof KEYS];

/** The text key for a response that refused the read of a chat, or null for any other answer. */
export async function containedReadKey(res: Pick<Response, 'status' | 'clone'>): Promise<ContainedReadKey | null> {
	if (res.status !== 403) return null;
	try {
		const body = (await res.clone().json()) as { code?: unknown };
		return typeof body.code === 'string' && Object.hasOwn(KEYS, body.code) ? KEYS[body.code as keyof typeof KEYS] : null;
	} catch {
		return null;
	}
}
