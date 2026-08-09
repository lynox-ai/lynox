/**
 * Wording for the durable-knowledge review chip.
 *
 * Kept out of the component so the mapping is testable in the ordinary suite — a `.svelte`
 * file is not importable from a test, and a mapping nobody can assert is a mapping that
 * quietly drifts.
 */

/** The engine's `describeTurnUntrusted` vocabulary, as it arrives on the SSE event. */
export type KnowledgeWriteCause = 'marker' | 'external-tool' | 'conversation' | 'none';

const KNOWLEDGE_WRITE_CAUSES: readonly KnowledgeWriteCause[] = ['marker', 'external-tool', 'conversation', 'none'];

/** Narrow a raw SSE `cause` to the known vocabulary — a value the engine's enum does not
 *  contain (an older/newer engine) becomes `undefined` rather than a lie typed as the union. */
function narrowCause(raw: unknown): KnowledgeWriteCause | undefined {
	return typeof raw === 'string' && (KNOWLEDGE_WRITE_CAUSES as readonly string[]).includes(raw)
		? (raw as KnowledgeWriteCause)
		: undefined;
}

/**
 * DK-UX inline chip for a durable-knowledge write (from the `knowledge_write` SSE event).
 *
 * Lives here, beside its pure logic, rather than in the `.svelte` store: the store cannot be
 * imported from a test, so a chip type whose projection and resolve transitions lived only in
 * the store had no way to be asserted. The store re-exports it for its own consumers.
 */
export interface KnowledgeWriteChip {
	id: string;
	subject?: string | undefined;
	kind?: string | undefined;
	status: 'active' | 'pending_review';
	/** Raw wording (for the untrusted review chip). Client-only; never re-enters model context. */
	text: string;
	/** WHY this was queued, in the engine's vocabulary. Only set for `pending_review`. */
	cause?: KnowledgeWriteCause | undefined;
	/** UI-local once the user resolves the chip, so it renders as done and the buttons retire. */
	resolved?: 'undone' | 'kept' | 'discarded' | undefined;
}

/**
 * Project a raw `knowledge_write` SSE payload onto the chip to append — or `null` when there
 * is nothing to add. Two `null` cases, and they are different: a payload with no `id` is
 * malformed and dropped; a payload whose `id` is already present is a **Tier-2 SSE replay**
 * (a reconnect re-delivers the event) and must be de-duplicated, or a reconnect would show the
 * same capture twice. Kept pure — no store, no `msg` — so both the dedup and the field
 * normalization can be asserted without a live stream.
 */
export function projectKnowledgeWrite(
	existing: readonly KnowledgeWriteChip[],
	data: Record<string, unknown>,
): KnowledgeWriteChip | null {
	const id = String(data['id'] ?? '');
	if (!id) return null;
	if (existing.some((w) => w.id === id)) return null;
	return {
		id,
		subject: typeof data['subject'] === 'string' ? data['subject'] : undefined,
		kind: typeof data['kind'] === 'string' ? data['kind'] : undefined,
		// Anything other than the explicit `pending_review` is treated as active: an unknown
		// status must not route a write into the untrusted-review path it did not ask for.
		status: data['status'] === 'pending_review' ? 'pending_review' : 'active',
		text: String(data['text'] ?? ''),
		cause: narrowCause(data['cause']),
	};
}

/**
 * The resolved state a review action lands on, once the route has ACCEPTED it. `reject`
 * discards; `approve` and `edit_approve` both keep (an edit is an approval of edited text, not
 * a third outcome). Pure and success-only by design: the caller maps ONLY after a 2xx, so a
 * failed review leaves the chip unresolved and its editor open — the transition cannot be read
 * as having happened when the server refused it.
 */
export function reviewResolution(action: 'approve' | 'edit_approve' | 'reject'): 'kept' | 'discarded' {
	return action === 'reject' ? 'discarded' : 'kept';
}

/** The resolved state an undo lands on, and only on a 2xx — a failed retire leaves the chip
 *  actionable rather than falsely showing as undone. `null` = no transition. */
export function retireResolution(ok: boolean): 'undone' | null {
	return ok ? 'undone' : null;
}

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
		// `marker` and `external-tool` collapse deliberately: they differ in how the engine
		// noticed, not in anything the person can act on. The split that matters is this step
		// versus an earlier one.
		case 'marker':
		case 'external-tool': return 'chat.knowledge.cause.this_step';
		case 'conversation': return 'chat.knowledge.cause.earlier';
		default: return 'chat.knowledge.review_hint';
	}
}
