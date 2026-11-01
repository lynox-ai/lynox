// === An answer that reached a closed question (UX-064, UX-068, ux U-113) ===
//
// The server answers such an answer with 410 and, where it knows, why the question was closed
// (`code`). The page says that reason, what to do instead, and — where writing the answer again
// helps — puts the lost answer back into an empty message field.

/** Why the server closed a question (core `PromptClosedReason`). */
export type ClosedCode =
	| 'process_restarted'
	| 'timed_out'
	| 'run_stopped'
	| 'run_taken_over'
	| 'thread_deleted'
	| 'mandate_ended'
	| 'plan_paused'
	| 'plan_taken_over'
	| 'plan_ended'
	| 'superseded';

const CODES: ReadonlySet<string> = new Set<ClosedCode>([
	'process_restarted', 'timed_out', 'run_stopped', 'run_taken_over', 'thread_deleted',
	'mandate_ended', 'plan_paused', 'plan_taken_over', 'plan_ended', 'superseded',
]);

/** The code of a 410 body, or null for a closed question the server gave no reason for. */
export function closedCodeOf(code: unknown): ClosedCode | null {
	return typeof code === 'string' && CODES.has(code) ? (code as ClosedCode) : null;
}

/** Who reads the sentence: the way out differs where only the owner can act. */
export type ClosedReader = 'owner' | 'mandate';

/** The i18n key of the sentence for `code` (null: no reason given). */
export function closedSentenceKey(code: ClosedCode | null, reader: ClosedReader): string {
	switch (code) {
		case null: return 'chat.prompt_expired';
		case 'process_restarted': return 'chat.prompt_closed_restart';
		case 'mandate_ended': return `chat.prompt_closed.mandate_ended.${reader}`;
		case 'plan_paused': return `chat.prompt_closed.plan_paused.${reader}`;
		default: return `chat.prompt_closed.${code}`;
	}
}

/**
 * Whether the lost answer goes back into the message field. Not where writing it again in this
 * chat is no way out: the chat is gone, a newer question waits for the answer, or only the owner
 * can go on (an ended access, a paused plan).
 */
export function closedDraftAllowed(code: ClosedCode | null, reader: ClosedReader): boolean {
	switch (code) {
		case 'thread_deleted':
		case 'superseded':
		case 'plan_paused':
			return false;
		case 'mandate_ended':
			return reader === 'owner';
		default:
			return true;
	}
}

/**
 * The lost answer as text for the message field, or null when there is none to give back: a
 * question skipped (`__dismissed__`) or left empty. A multi-select answer travels as a JSON array
 * of the chosen labels; it comes back as those labels.
 */
export function draftOfAnswer(answer: string): string | null {
	if (answer === '__dismissed__') return null;
	let text = answer;
	if (answer.startsWith('[')) {
		try {
			const parsed: unknown = JSON.parse(answer);
			if (Array.isArray(parsed) && parsed.every((p): p is string => typeof p === 'string')) text = parsed.join(', ');
		} catch { /* not a list: the answer as typed */ }
	}
	return text.trim() === '' ? null : text;
}
