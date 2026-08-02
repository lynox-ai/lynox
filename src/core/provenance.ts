import type { ProvenanceKind } from '../types/memory.js';
import { ALL_PROVENANCE_KINDS } from '../types/memory.js';

/**
 * The write CHANNEL a memory came from — the evidence the caller *knows* at the
 * store boundary. It is persisted (`source_channel`) so the provenance tier stays a
 * re-derivable pure function of it (PRD-MEMORY-FOUNDATION §1/§3), never the only
 * thing stored. Distinct from `ProvenanceKind` (the DERIVED trust tier).
 *
 * - `user`   — a person typed it in a conversation turn. First producer: the Onboarding
 *              Wave 1 Step-0 engine promotion (`onboarding-promotion.ts`, §6.1) — the engine
 *              writes a clean-latch Step-0 answer VERBATIM on this channel → `user_asserted`.
 *              (The GENERAL conversational user-turn extractor — Wave 1.5's "extract from the
 *              user's turn" half — is still deferred: user turns persist in history, so it is
 *              backfillable, and it is a behaviour change deserving its own design.) The `ui`
 *              facade (settings, memory editor) also produces `user_asserted` via rule 2.
 * - `ui`     — a person entered it through a UI surface (settings, memory editor).
 * - `agent`  — the model derived/extracted it on a clean turn (the extractor, the
 *              force-floored `memory_store` tool).
 * - `upload` — it came from an uploaded document (`document-ingest`).
 */
export type SourceChannel = 'user' | 'ui' | 'agent' | 'upload';

/** The persisted evidence from which {@link deriveProvenanceTier} computes the tier. */
export interface ProvenanceEvidence {
  /** The write channel (`SourceChannel`); an unknown/absent value floors (rule 5). */
  sourceChannel?: string | undefined;
  /** The turn that produced this write read untrusted external content. Outranks the channel. */
  sourceUntrusted?: boolean | undefined;
  /**
   * A human reviewer was shown this exact text in the review queue and accepted it
   * (`review_action` ∈ `approve` | `edit_approve`). Outranks everything — see rule 0.
   *
   * ⚠️ SECURITY PRECONDITION, stated as what it is rather than as a guarantee: rule 0 is only
   * sound while the review action is genuinely a human act. Within this module the only
   * producer is `KnowledgeStore.reviewEntry` via the `user`-scoped review route — but whether
   * that route is reachable by anything else is a property of the DEPLOYMENT (its auth
   * configuration, its autonomy mode, which tools are exposed), and nothing here enforces it.
   * An earlier draft of this comment asserted the absolute; it was wrong. Treat a reachable
   * approve path as an escalation from `external_unverified` to `user_asserted` in one step,
   * and re-derive from something the agent cannot assert if the boundary has to move.
   */
  reviewApproved?: boolean | undefined;
}

/**
 * Evidence → provenance tier. A PURE function, computed at the store boundary from
 * `store()`'s own arguments. **First match wins; ambiguity always resolves DOWNWARD.**
 * This is §3 of PRD-MEMORY-FOUNDATION, stated completely.
 *
 * Because the tier is a pure function of persisted evidence, a derivation bug is
 * repaired by fixing this function and re-running it over the stored columns — an
 * idempotent recomputation, never a data migration (§5.6). That is why the tier is
 * never the only thing stored.
 *
 * `tool_verified` is intentionally NOT produced here: no channel derives it (§3/§10.3).
 * The enum value stays reserved (the model's trust vocabulary, the forgery guard), but
 * a clean tool-result ingest path is its own future arc.
 */
export function deriveProvenanceTier(ev: ProvenanceEvidence): ProvenanceKind {
  // Rule 0 — a human reviewer accepted this exact text. Outranks rule 1 on purpose, and the
  // distinction is narrow: rule 1 distrusts a human WRITE made on a turn that had attacker text
  // in context, because nobody asked the operator to vouch for that text. A review approval is
  // the opposite situation — the queue shows the reviewer the entry itself and the only thing
  // the action means is "I vouch for this". Without this rule an approved entry stores
  // `user_asserted` while its own evidence re-derives to `external_unverified`, the far end of
  // the ordering — which breaks the invariant this function's contract rests on
  // (`DEF-dk-trust-gate-consistency` (d)). See `reviewApproved` for why the agent cannot set it.
  if (ev.reviewApproved === true) return 'user_asserted';
  // Rule 1 — untrusted OUTRANKS the channel. A `ui`/`user` write on a turn that read a
  // malicious document is not first-party trust; the operator may be relaying attacker text.
  if (ev.sourceUntrusted === true) return 'external_unverified';
  // Rule 2 — a first-party human channel.
  if (ev.sourceChannel === 'user' || ev.sourceChannel === 'ui') return 'user_asserted';
  // Rule 3 — an uploaded document.
  if (ev.sourceChannel === 'upload') return 'external_unverified';
  // Rule 4 — the model derived it on a clean turn (the extractor, the floored memory_store).
  // Not a default: it is the explicit `agent` channel, the floor for *derivation*, reached
  // only once rule 1 has ruled out an untrusted turn. This is the tier of 886/893 live rows.
  if (ev.sourceChannel === 'agent') return 'agent_inferred';
  // Rule 5 — no (or unknown) channel reported → we cannot vouch for it → floor. Closes the
  // fail-open door for any future `channels.memoryStore` publisher that forgets to say anything.
  return 'external_unverified';
}

/**
 * The trust RANK of a provenance tier — a total order where a HIGHER number is
 * MORE trusted. `user_asserted` → 3, `tool_verified` → 2, `agent_inferred` → 1,
 * `external_unverified` → 0. This is the single source of the trust ordering used
 * by every memory retire path (Memory Foundation Wave 2 — the write-trust gate).
 *
 * ⚠️ DIRECTION IS SECURITY-CRITICAL (from /security-deep-dive S2). {@link ALL_PROVENANCE_KINDS}
 * is highest-trust-FIRST — `user_asserted` is index 0, `external_unverified` index 3. A raw
 * `indexOf` would therefore INVERT the rank (user_asserted→0, external_unverified→3) and make
 * `canSupersede(external_unverified, user_asserted)` TRUE — the gate would then AUTHORIZE an
 * injected low-trust write to retire a user's truth, i.e. become an injection ENABLER. The
 * rank MUST reverse the index. Tests assert the BEHAVIOURAL `canSupersede` pairs (never a
 * scalar `provenanceRank === N`, which would silently cement the inversion).
 */
export function provenanceRank(kind: ProvenanceKind): number {
  const index = ALL_PROVENANCE_KINDS.indexOf(kind);
  // FAIL CLOSED on a value this build does not know. `indexOf` answers -1, and the
  // reversal above turns -1 into `length` — a rank ABOVE `user_asserted`, so an
  // unrecognised tier would outrank every real one and `canSupersede(<unknown>,
  // 'user_asserted')` returned true: the one direction this gate must never take.
  // The tier is read back from a TEXT column, so "unknown" is not hypothetical — a
  // migration, a hand-edited row, or a future build's new tier name all produce one,
  // and the current fleet simply has none yet (checked: every stored value is in the
  // enum). An unknown tier is untrusted BY DEFINITION: we cannot place what we cannot
  // name, so it sorts below everything nameable.
  if (index === -1) return -1;
  return (ALL_PROVENANCE_KINDS.length - 1) - index;
}

/**
 * Two consequences of the `-1` sentinel that are deliberate, because they follow from
 * the arithmetic rather than from a decision, and arithmetic is a poor place to leave
 * a trust rule implicit:
 *
 *  - **Unknown vs unknown supersedes** (`-1 >= -1`). Two unrecognised tiers rank equal
 *    and the equal-trust rule is newest-wins, so one may retire the other. This is not a
 *    trust loss (neither is trusted) and it is what keeps an unknown row CORRECTABLE
 *    rather than wedged. Reachable: `agent-memory-db.ts` compares two DB-sourced tiers.
 *  - **A dedup hit against an unknown row now RAISES it.** `knowledge-layer.ts` decides
 *    `tier-raise` vs `confirm` on `rank(incoming) > rank(existing)`; with the old
 *    fail-open sentinel no known tier could beat an unknown row, so it stayed unknown
 *    forever. Now any nameable tier raises it — supersede-not-mutate, so reversible.
 *    That is a repair path the fail-open version did not have.
 *  - **Even `external_unverified` may now supersede an unknown row** (`0 >= -1`, where
 *    it was `0 >= 4` = false). Stated because it is the one direction that WIDENS: the
 *    injection-seeded tier can act on an unknown row where it previously could not. The
 *    alternative — letting only a high tier correct an unknown row — buys little (an
 *    unknown row is untrusted either way) and costs the total order a special case, so
 *    the simple ordering wins. Revisit if unknown tiers ever become routine rather than
 *    the zero-occurrence case measured here.
 *
 * The same sentinel also fixes the KEEPER SORT, which is the half of this that bites
 * without any retire at all: consolidation sorts a cluster by rank descending
 * (`agent-memory-db.ts`), so a rank above `user_asserted` made an unknown row the
 * survivor and dropped the user's own duplicate. Both halves are one ordering bug.
 */

/**
 * The trust gate primitive: may a write of tier `newTier` retire (supersede) an
 * existing row of tier `existingTier`? True iff the incoming write is of
 * EQUAL-OR-HIGHER trust. A strictly lower-trust write may never retire a
 * higher-trust fact (that is the integrity hole this closes — an `agent_inferred`
 * or injection-seeded `external_unverified` write silently deleting a
 * `user_asserted` truth). A reusable pure function imported by every retire path
 * in both memory stores (legacy `AgentMemoryDb`, engine.db `MemoryGraphStore`).
 */
export function canSupersede(newTier: ProvenanceKind, existingTier: ProvenanceKind): boolean {
  return provenanceRank(newTier) >= provenanceRank(existingTier);
}
