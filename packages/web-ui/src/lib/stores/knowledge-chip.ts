/**
 * Wording for the durable-knowledge review chip.
 *
 * Kept out of the component so the mapping is testable in the ordinary suite — a `.svelte`
 * file is not importable from a test, and a mapping nobody can assert is a mapping that
 * quietly drifts.
 */

/** The engine's `describeTurnUntrusted` vocabulary, as it arrives on the SSE event. */
export type KnowledgeWriteCause = 'marker' | 'external-tool' | 'conversation' | 'none';

/**
 * The i18n key naming WHY a write was queued.
 *
 * "from external content" is true of every queued write, so as the only line it gives the
 * person nothing to judge — and a confirmation nobody can judge is a reflex, which is worse
 * than no gate because it still looks like a control. The `conversation` case is the one
 * that most needs saying: nothing external happened on THIS turn, so without naming it the
 * chip reads as a malfunction.
 *
 * An absent or unknown cause falls back to the old generic line rather than rendering
 * nothing — an older engine behind a newer UI must still say something.
 */
export function knowledgeCauseKey(cause: string | undefined): string {
	switch (cause) {
		case 'marker': return 'chat.knowledge.cause.marker';
		case 'external-tool': return 'chat.knowledge.cause.external_tool';
		case 'conversation': return 'chat.knowledge.cause.conversation';
		default: return 'chat.knowledge.review_hint';
	}
}
