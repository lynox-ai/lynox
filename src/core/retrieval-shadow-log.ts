import { appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
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
 *    (env `LYNOX_DATA_DIR`/`LYNOX_DIR`, else `~/.lynox`), writable in the managed
 *    read-only container.
 *  - Privacy: the query is stored only as a 16-char sha256 prefix (never raw text),
 *    but `threadId`/`subjectId` are plaintext. The sink is per-container, OUTSIDE
 *    backups and the migration export — bound its retention before enabling it
 *    fleet-wide on customer data.
 */

export const RETRIEVAL_SHADOW_LOG_FILE = 'retrieval-shadow.jsonl';

/** Resolve the data dir the same way the rest of the engine does. */
function dataDir(): string {
  const fromEnv = process.env['LYNOX_DATA_DIR'] ?? process.env['LYNOX_DIR'];
  return fromEnv && fromEnv.length > 0 ? fromEnv : path.join(homedir(), '.lynox');
}

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
  /** 16-char sha256 prefix of the query — groups repeat queries without recovering content. */
  readonly queryHash: string;
  /** Embedding model identity — the FLOOR binds to it (§1.7), so the distribution must record it. */
  readonly embeddingModel: string;
  /** Embedding provider name (e.g. 'onnx', 'local'). */
  readonly embeddingProvider: string;
  /** Every scored, scope-filtered candidate this retrieval considered. */
  readonly candidates: readonly RetrievalShadowCandidate[];
}

/**
 * Append one retrieval record as a JSON line. Fire-and-forget: the caller does
 * `void appendRetrievalShadowLog(...)` and never awaits. Any error (read-only FS,
 * permission, disk full) is swallowed so the retrieval is untouched.
 */
export async function appendRetrievalShadowLog(entry: RetrievalShadowLogEntry): Promise<void> {
  try {
    const file = path.join(dataDir(), RETRIEVAL_SHADOW_LOG_FILE);
    await appendFile(file, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Best-effort telemetry — never propagate.
  }
}
