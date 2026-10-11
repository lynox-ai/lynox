import { createHmac, randomBytes } from 'node:crypto';
import { appendBoundedJsonl } from './bounded-jsonl-log.js';
import type { ProvenanceKind } from '../types/index.js';

/**
 * Memory Foundation Wave 0 — retrieval shadow-mode sink.
 *
 * When the tenant sets `retrieval_shadow_log: true`, every `retrieve()` appends one
 * record here describing the SCORED candidate set: each candidate's raw cosine, its
 * provenance tier, its subject, and whether it passed the current admission gate.
 * The point is GROUND-TRUTH admission distribution from the real corpus (§5.1) so the
 * Wave-2 FLOOR is measured per tier — never guessed — before enforcement lands.
 * It ships WITH Wave 0 because Wave 0 widens admission (§4, bound 2), so the floor
 * must be measured on the corpus customers actually generate.
 *
 * Design constraints (mirrors `context-cost-log.ts`):
 *  - Default OFF: a single boolean check at the call site; zero overhead when off.
 *  - Filters NOTHING: pure telemetry, never affects what a retrieval returns.
 *  - Best-effort: a logging failure must NEVER surface into the agent run — every
 *    error is swallowed.
 *  - Deploy-safe path: written next to `agent-memory.db` in the persistent data dir
 *    (`getLynoxDir()`), writable in the managed read-only container.
 *  - Privacy: the query is stored only as a salted 16-char HMAC prefix (never raw text,
 *    see `shadowQueryHash`), but `threadId`/`subjectId` are plaintext. The sink is
 *    per-container, OUTSIDE backups and the migration export, and the erasure removes it
 *    (`DATA_DIR_INVENTORY`). Its retention is bounded by the shared
 *    size-rotation in `bounded-jsonl-log.ts` (≤ 2× cap on disk), so enabling it
 *    fleet-wide on customer data cannot grow an unbounded plaintext file.
 */

export const RETRIEVAL_SHADOW_LOG_FILE = 'retrieval-shadow.jsonl';

/** One scored candidate as seen by the admission gate. */
export interface RetrievalShadowCandidate {
  /** Memory id (stable across the two stores — the mirror shares the legacy id). */
  readonly id: string;
  /** Raw cosine similarity (unscaled by VECTOR_WEIGHT). 0 for a graph-only candidate. */
  readonly rawCosine: number;
  /** Provenance tier the row carries. */
  readonly sourceType: ProvenanceKind;
  /** The candidate's primary subject id (engine.db recall path), or null. */
  readonly subjectId: string | null;
  /** Whether it cleared the current admission gate (`finalScore > threshold * 0.3`). */
  readonly wouldPass: boolean;
}

/** One persisted line: the candidate set for a single retrieve() call. */
export interface RetrievalShadowLogEntry {
  /** Epoch millis at capture. */
  readonly ts: number;
  /** Thread id the retrieval belongs to, if known. */
  readonly threadId: string | undefined;
  /**
   * `shadowQueryHash(query)` — a GROUPING key that correlates repeat queries within one
   * process, nothing more.
   */
  readonly queryHash: string;
  /** Embedding model identity — the FLOOR binds to it (§1.7), so the distribution must record it. */
  readonly embeddingModel: string;
  /** Embedding provider name (e.g. 'onnx', 'local'). */
  readonly embeddingProvider: string;
  /** Every scored, scope-filtered candidate this retrieval considered. */
  readonly candidates: readonly RetrievalShadowCandidate[];
}

/**
 * Salt for `shadowQueryHash`, drawn per process and never written anywhere.
 *
 * The hash was a plain sha256 prefix, and a query is often a name: anyone holding the
 * file and a list of candidate names could read back who was looked up, and that survived
 * the erasure of the person it named. Keyed with a salt nothing persists, the hash still
 * groups repeat queries within a process — the only use it has — and a record written
 * now reveals nothing after a restart. Records written before this change keep their
 * plain prefix until the file rotates or is erased. The price is that grouping does not span restarts or containers, which
 * no reader of this log needs.
 */
const QUERY_HASH_SALT = randomBytes(32);

/** 16-hex-char HMAC-SHA256 of the query under the per-process salt. */
export function shadowQueryHash(query: string): string {
  return createHmac('sha256', QUERY_HASH_SALT).update(query).digest('hex').slice(0, 16);
}

/**
 * Append one retrieval record as a JSON line to the size-bounded sink. Fire-and-forget:
 * the caller does `void appendRetrievalShadowLog(...)` and never awaits. Best-effort —
 * any FS error is swallowed so the retrieval is untouched.
 */
export function appendRetrievalShadowLog(entry: RetrievalShadowLogEntry): Promise<void> {
  return appendBoundedJsonl(RETRIEVAL_SHADOW_LOG_FILE, entry);
}
