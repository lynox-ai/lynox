/**
 * The way out of a chat that only reads: "Plan in a new chat".
 *
 * A chat that read data through a store connection is contained: it reads and explains, and the
 * engine refuses every write and every bulk plan in it. The way out is a new chat that does not read
 * the store: where this instance runs bulk runs that read a Shopify store, it plans the change as
 * one, which reads the store itself; where it does not, it says what is missing and drafts texts the
 * user copies into the store. A request to another service runs there. That chat starts with the user's own words
 * from the old one in its input, unsent, so the user sees what goes across before it does.
 *
 * Only what the user typed (or dictated) goes across: never an answer, a tool result, a loaded
 * context or a text the app composed, even when it sits in a message with the role `user`. The
 * mark is `typed`, set where the composer sends, so a message without it is not taken: a chat
 * loaded from the server carries no mark and starts the new chat empty rather than guess.
 */
import { hiddenCharIndexes } from '../hidden-chars.js';
import { stripVoicePrefix } from '../utils/voice-prefix.js';

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

/** What the app adds to a typed message for its bubble: the 🎤 in front of a dictated one and the
 *  📎 line naming the attached files (`chat.svelte.ts`, `ChatView.svelte`). Neither was typed, and
 *  the files do not go across, so the new chat gets the words without them. */
const ATTACHMENT_LINE = /\n📎 [^\n]*$/u;

function withoutAppMarks(text: string): string {
	return stripVoicePrefix(text.replace(ATTACHMENT_LINE, ''));
}

/** The input text for the new chat: the user's typed messages, oldest first, at most the last
 *  `PREFILL_MAX_MESSAGES`, each without what the app added and without hidden characters. */
export function containedPrefill(messages: readonly PrefillSource[]): ContainedPrefill {
	const typed = messages.filter((m) => m.role === 'user' && m.typed === true);
	const kept = typed.slice(-PREFILL_MAX_MESSAGES);
	let removedHidden = false;
	const parts: string[] = [];
	for (const m of kept) {
		const clean = withoutHidden(withoutAppMarks(m.content));
		if (clean.removed) removedHidden = true;
		const text = clean.text.trim();
		if (text) parts.push(text);
	}
	if (parts.length > 0 && typed.length > kept.length) parts.unshift('…');
	return { text: parts.join('\n\n'), removedHidden };
}

/**
 * The sentences above the input of a chat opened with "Plan in a new chat", as i18n keys, from
 * `GET /api/config`. A bulk run is promised only where bulk runs are on and may read a Shopify
 * store (`bulk_runs.on` and `bulk_runs.shopify`), as the engine's text for that chat does
 * (`chat-context.ts › containedOriginContext`), and in the same order: what is missing for the
 * Shopify read, then for bulk runs, support once. Bulk runs the owner can turn on, wherever
 * turning them on takes effect (`source` is `'config'`, or `allowed`: a pool tier the control plane
 * has opened them on), get the place of the switch; the others go to support, as the engine reads
 * it (`bulk-switch.ts › bulkRunsTurnedOnBy`). A config that could not be read gives no line:
 * the engine reads the state when the message is sent, and a line saying either way could
 * contradict its answer.
 */
export function originLineKeys(ok: boolean, data: unknown): string[] {
	const cfg = ok && typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : null;
	const bulk = cfg !== null && typeof cfg['bulk_runs'] === 'object' && cfg['bulk_runs'] !== null
		? (cfg['bulk_runs'] as Record<string, unknown>) : null;
	if (bulk === null) return [];
	const bulkRuns = bulk['on'] === true;
	const shopify = bulk['shopify'] === true;
	if (bulkRuns && shopify) return ['contained.origin_line'];
	const managed = !!cfg!['managed'];
	const keys = ['contained.origin_line_off'];
	if (!shopify) keys.push(managed ? 'contained.way_support' : 'contained.way_flag');
	if (!bulkRuns) {
		if (bulk['source'] === 'config' || bulk['allowed'] === true) keys.push('contained.way_setting');
		else if (!keys.includes('contained.way_support')) keys.push('contained.way_support');
	}
	keys.push('contained.origin_line_draft');
	return keys;
}
