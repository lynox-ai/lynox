import type { ProvenanceKind } from '../types/memory.js';
import { ALL_PROVENANCE_KINDS } from '../types/memory.js';

/**
 * The write CHANNEL a memory came from — the evidence the caller *knows* at the
 * store boundary. It is persisted (`source_channel`) so the provenance tier stays a
 * re-derivable pure function of it (PRD-MEMORY-FOUNDATION §1/§3), never the only
 * thing stored. Distinct from `ProvenanceKind` (the DERIVED trust tier).
 *
 * - `user`   — a person typed it in a conversation turn. RESERVED: rule 2 admits it, but
 *              no producer emits it yet — the conversational user-turn extractor (Wave 1.5's
 *              "extract from the user's turn" half) is deferred (user turns persist in history,
 *              so it is backfillable, and it is a behaviour change deserving its own design).
 *              Until then `user_asserted` is produced only by the UI facade via `ui`.
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
  return (ALL_PROVENANCE_KINDS.length - 1) - ALL_PROVENANCE_KINDS.indexOf(kind);
}

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
