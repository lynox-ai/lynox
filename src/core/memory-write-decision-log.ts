import { appendBoundedJsonl } from './bounded-jsonl-log.js';
import type { ProvenanceKind } from '../types/index.js';

/**
 * Memory Foundation Wave 2 — write-DECISION shadow telemetry (the write-trust gate).
 *
 * The existing write-log (`memory-write-log.ts`) fires only AFTER the dedup early-return
 * and records the STORED row's tier, so it can never see what the trust gate WOULD do at
 * a conflict: a P1a `superseded → coexist` demotion (a low-trust write blocked from
 * retiring a higher-trust truth) or a P1b dedup tier-RAISE. This sink records that
 * would-be decision so the gate's blast-radius is measurable BEFORE the enforcement flag
 * (`memory_write_trust_gate`) is flipped on the fleet — the "shadow-first, then enforce"
 * discipline (measure-first).
 *
 * It is emitted whenever the gate COMPUTES a decision (independent of enforcement), gated
 * on the SAME measurement flag as the retrieval/write shadow logs (`retrieval_shadow_log`
 * → one flag, one retention story). Best-effort, fire-and-forget, size-bounded, written
 * next to `agent-memory.db` in the persistent data dir — OUTSIDE backups + the migration
 * export (via `appendBoundedJsonl`).
 *
 * ⚠️ PII discipline (security-critical, from /security-deep-dive S1): the emit sites sit
 * next to the FULL memory body (trimmedText / candidate.text), which can hold PII or a
 * `secret:`-resolved value. This record therefore logs ONLY the decision, the two tiers,
 * an OPAQUE row id, and the (low-cardinality, non-PII) namespace — NEVER the memory text.
 * Acceptance grep-asserts this record carries no `text`/`body` key.
 */

export const MEMORY_WRITE_DECISION_LOG_FILE = 'memory-write-decision.jsonl';

/** What the write-trust gate decided (or WOULD decide when only measuring). */
export type WriteDecision =
  /** P1a: the incoming write is equal-or-higher trust → it may retire the existing row. */
  | 'supersede'
  /** P1a: the incoming write is strictly lower trust → demote the retire to coexist. */
  | 'demote-coexist'
  /** P1b: a dedup hit with no trust change → the plain no-op-confirm path. */
  | 'confirm'
  /** P1b: a dedup hit whose incoming write strictly outranks the stored row → tier-raise. */
  | 'tier-raise';

/** One persisted line: a single write-trust decision. Text-free by construction. */
export interface MemoryWriteDecisionEntry {
  /** Epoch millis at capture. */
  readonly ts: number;
  /** The decision the gate reached (or would reach when only measuring). */
  readonly decision: WriteDecision;
  /** The DERIVED tier of the incoming write. */
  readonly newTier: ProvenanceKind;
  /** The tier of the existing/contradicted/deduped row the decision concerns. */
  readonly existingTier: ProvenanceKind;
  /** Whether enforcement was live (flag on) when this decision was reached. */
  readonly enforced: boolean;
  /** The OPAQUE id of the existing row (a UUID — not PII; no text). */
  readonly existingId: string;
  /** The namespace (low-cardinality enum — not PII). */
  readonly namespace: string;
}

/**
 * Append one write-decision record as a JSON line to the size-bounded sink.
 * Fire-and-forget: the caller does `void appendMemoryWriteDecisionLog(...)` and never
 * awaits. Best-effort — any FS error is swallowed so the store is untouched.
 */
export function appendMemoryWriteDecisionLog(entry: MemoryWriteDecisionEntry): Promise<void> {
  return appendBoundedJsonl(MEMORY_WRITE_DECISION_LOG_FILE, entry);
}
