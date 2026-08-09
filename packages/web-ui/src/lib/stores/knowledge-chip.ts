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

/** What a chip action amounted to: `resolved` = the transition happened (and side-effects
 *  like the pending-count refresh are due), `noop` = nothing to do (no chip, or already
 *  resolved — the double-click guard), `failed` = the route refused or the request threw,
 *  so the chip stays actionable and a toast is due. */
export type ChipActionOutcome = 'resolved' | 'noop' | 'failed';

/**
 * Drive the retire (undo) flow on a chip, with the transport injected.
 *
 * This is the store glue that used to live untestable inside `chat.svelte.ts` (a Runes
 * module the ordinary suite cannot import): the guard, the 2xx gate, and the in-place
 * transition. The store's wrapper supplies only I/O (the fetch and the failure toast).
 * A `send` that throws counts as not-ok — same as the route refusing.
 */
export async function performRetire(
	chip: KnowledgeWriteChip | undefined,
	send: () => Promise<{ ok: boolean }>,
): Promise<ChipActionOutcome> {
	if (!chip || chip.resolved) return 'noop';
	let ok = false;
	try {
		ok = (await send()).ok;
	} catch { /* a thrown send counts as not-ok, same as the route refusing */ }
	const resolved = retireResolution(ok);
	if (!resolved) return 'failed';
	chip.resolved = resolved;
	return 'resolved';
}

/** The JSON body the review route expects — `text` only rides along on an edit, so a plain
 *  approve/reject must not send a `text` key at all. */
export function reviewRequestBody(
	action: 'approve' | 'edit_approve' | 'reject',
	editedText: string | undefined,
): { action: string; text?: string } {
	return editedText !== undefined ? { action, text: editedText } : { action };
}

/** The toast wording for a refused review: the server's own `error` when it sent one,
 *  else the bare status. `??` (not `||`) on purpose — an explicit empty-string error is
 *  passed through unchanged, preserving the pre-extraction behaviour byte for byte. */
export function parseReviewFailure(status: number, body: { error?: string } | null): string {
	return body?.error ?? `HTTP ${status}`;
}

/**
 * Drive the review flow (approve / edit_approve / reject) on a chip, transport injected.
 *
 * The transition is success-only: `chip.text` and `chip.resolved` change ONLY after the
 * route accepted the action, so a failed `edit_approve` leaves the chip unresolved with
 * its original text — which is what keeps the editor open instead of pretending the edit
 * landed. `errorMessage` carries the server's wording (or the thrown error's) for the
 * caller's toast; `null` means "no server wording, use the generic line".
 */
export async function performReview(
	chip: KnowledgeWriteChip | undefined,
	action: 'approve' | 'edit_approve' | 'reject',
	editedText: string | undefined,
	send: () => Promise<{ ok: boolean; errorMessage: string | null }>,
	// Discriminated on `outcome` so `errorMessage` only exists where it means something —
	// the compiler then forces every consumer to narrow before reading it (the same
	// return-type-over-convention move as SubjectStore's {ok}|{ambiguous}).
): Promise<{ outcome: 'resolved' | 'noop' } | { outcome: 'failed'; errorMessage: string | null }> {
	if (!chip || chip.resolved) return { outcome: 'noop' };
	let res: { ok: boolean; errorMessage: string | null };
	try {
		res = await send();
	} catch (e) {
		res = { ok: false, errorMessage: e instanceof Error ? e.message : null };
	}
	if (!res.ok) return { outcome: 'failed', errorMessage: res.errorMessage };
	if (editedText !== undefined) chip.text = editedText;
	chip.resolved = reviewResolution(action);
	return { outcome: 'resolved' };
}

/** The minimal message shape carry-over needs — structural, so the pure module
 *  does not import the store's ChatMessage. */
export interface ChipBearer {
	role: string;
	content: string;
	knowledgeWrites?: KnowledgeWriteChip[] | undefined;
}

/** Every chip across the transcript, in message order. The SSE handler feeds this to
 *  `projectKnowledgeWrite` so replay-dedup is transcript-GLOBAL: after an adoption
 *  anchored a carried chip onto a different message (the reprojection fallback), a
 *  Tier-2 replay of the same id must still be recognised as already-present. */
export function allKnowledgeWrites(messages: readonly ChipBearer[]): KnowledgeWriteChip[] {
	return messages.flatMap((m) => m.knowledgeWrites ?? []);
}

/**
 * Carry `knowledgeWrites` from the local message list onto a freshly adopted server
 * transcript, IN PLACE on `adopted`.
 *
 * Why this exists: both transcript-adoption sites replace `messages` wholesale once the
 * server has caught up (`server >= local`), and server messages never carry chips — the
 * chip is a client-side projection of an SSE event. Without carry-over the pending-review
 * chip is wiped at run end (then resurrected by a Tier-2 replay — the observed flicker)
 * and lost for good on a settled reload, leaving the fact invisible in the review queue.
 *
 * Matching walks both lists with a forward cursor and pairs a chip-bearing local message
 * with the NEXT adopted message of the same role and content — ordered matching, so two
 * tool-call messages with identical empty content pair up positionally instead of both
 * hitting the first. A chip whose message has no counterpart (the server reprojected the
 * turn, e.g. the multi-step merge) falls back to the LAST assistant message: the chip is a
 * turn-scoped affordance and the review queue holds the durable truth, so an approximate
 * anchor beats a dropped chip. Ids already present on `adopted` are never duplicated
 * (future server-derived chips stay authoritative).
 */
export function carryKnowledgeWrites(
	local: readonly ChipBearer[],
	adopted: readonly ChipBearer[],
): void {
	if (!local.some((m) => m.knowledgeWrites?.length)) return;
	const seen = new Set<string>();
	for (const m of adopted) for (const w of m.knowledgeWrites ?? []) seen.add(w.id);
	let cursor = 0;
	const unanchored: KnowledgeWriteChip[] = [];
	for (const src of local) {
		// Advance the cursor for EVERY local message that has a counterpart, chips or
		// not — otherwise a chip-less twin earlier in the list (two identical "done"
		// replies, empty tool-call rows) leaves the cursor behind and a later chip
		// anchors onto the earlier twin instead of its positional counterpart.
		let target: ChipBearer | undefined;
		for (let j = cursor; j < adopted.length; j++) {
			const cand = adopted[j]!;
			if (cand.role === src.role && cand.content === src.content) {
				target = cand;
				cursor = j + 1;
				break;
			}
		}
		if (!src.knowledgeWrites || src.knowledgeWrites.length === 0) continue;
		const fresh = src.knowledgeWrites.filter((w) => !seen.has(w.id));
		for (const w of fresh) seen.add(w.id);
		if (fresh.length === 0) continue;
		if (target) (target.knowledgeWrites ??= []).push(...fresh);
		else unanchored.push(...fresh);
	}
	if (unanchored.length > 0) {
		for (let j = adopted.length - 1; j >= 0; j--) {
			const cand = adopted[j]!;
			if (cand.role === 'assistant') {
				(cand.knowledgeWrites ??= []).push(...unanchored);
				break;
			}
		}
		// No assistant message in the adopted transcript: nowhere to anchor. The chips are
		// dropped here, but the entries stay reviewable in the queue — same as before the fix.
	}
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
