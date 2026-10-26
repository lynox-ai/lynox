/**
 * The way out of a chat that only reads: "Plan in a new chat".
 *
 * A chat that read data through a store connection is contained: it reads and explains, and the
 * engine refuses every write and every bulk plan in it. The way out is a new chat that plans the
 * change as a bulk run, which reads the store itself. That chat starts with the user's own words
 * from the old one in its input, unsent, so the user sees what goes across before it does.
 *
 * Only what the user typed (or dictated) goes across: never an answer, a tool result, a loaded
 * context or a text the app composed, even when it sits in a message with the role `user`. The
 * mark is `typed`, set where the composer sends, so a message without it is not taken: a chat
 * loaded from the server carries no mark and starts the new chat empty rather than guess.
 */
import { hiddenCharIndexes } from '../hidden-chars.js';

/** The reasons the engine gives a refusal in a contained chat. Mirrors `ContainedRefusalReason`. */
export type ContainedRefusalReason = 'contained_call' | 'contained_write' | 'contained_plan';

const REASONS: ReadonlySet<string> = new Set<ContainedRefusalReason>(['contained_call', 'contained_write', 'contained_plan']);

/** The reason on a `tool_result` event, or undefined when it carries none the UI knows. */
export function containedReason(value: unknown): ContainedRefusalReason | undefined {
	return typeof value === 'string' && REASONS.has(value) ? (value as ContainedRefusalReason) : undefined;
}

/** Whether a refusal is one the new chat can carry out: a store write or a bulk plan. A refused
 *  call of another tool gets no button; the bar above the input says what holds. */
export function refusalOffersNewChat(call: { contained?: ContainedRefusalReason | undefined }): boolean {
	return call.contained === 'contained_write' || call.contained === 'contained_plan';
}

/** The most messages of the user's that go across. Older ones are marked with an ellipsis. */
export const PREFILL_MAX_MESSAGES = 5;

/** A message as far as the prefill reads it. */
export interface PrefillSource {
	role: string;
	content: string;
	typed?: boolean | undefined;
}

export interface ContainedPrefill {
	/** The input text for the new chat; empty when the old chat holds no typed message. */
	text: string;
	/** Whether a character the reader does not see was taken out. */
	removedHidden: boolean;
}

/** Take out every character `hiddenCharIndexes` names. Those it keeps in place stay: a joiner
 *  inside an emoji, a mark inside a word. */
function withoutHidden(text: string): { text: string; removed: boolean } {
	const at = hiddenCharIndexes(text);
	if (at.length === 0) return { text, removed: false };
	const drop = new Set(at);
	return { text: Array.from(text).filter((_, i) => !drop.has(i)).join(''), removed: true };
}

/** The input text for the new chat: the user's typed messages, oldest first, at most the last
 *  `PREFILL_MAX_MESSAGES`, each without hidden characters. */
export function containedPrefill(messages: readonly PrefillSource[]): ContainedPrefill {
	const typed = messages.filter((m) => m.role === 'user' && m.typed === true);
	const kept = typed.slice(-PREFILL_MAX_MESSAGES);
	let removedHidden = false;
	const parts: string[] = [];
	for (const m of kept) {
		const clean = withoutHidden(m.content);
		if (clean.removed) removedHidden = true;
		const text = clean.text.trim();
		if (text) parts.push(text);
	}
	if (parts.length > 0 && typed.length > kept.length) parts.unshift('…');
	return { text: parts.join('\n\n'), removedHidden };
}
