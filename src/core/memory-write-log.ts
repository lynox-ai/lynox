import { appendBoundedJsonl } from './bounded-jsonl-log.js';
import type { ProvenanceKind } from '../types/index.js';

/**
 * Memory Foundation Wave 1.3b — write-side tier telemetry.
 *
 * Every `KnowledgeLayer.store()` appends one record here (when the measurement flag
 * `retrieval_shadow_log` is on) describing what was WRITTEN: the source channel, the
 * derived provenance tier, and the untrusted signal. A retrieval-only shadow log can
 * never see a tier that is never WRITTEN, so §10.3 ("does tool_verified ever fire?") is
 * unanswerable without this, and the Wave-1.3 acceptance ("`external_unverified` did not
 * spike on rafael") needs the write distribution over time, not just a point-in-time
 * `GROUP BY` (which the persisted `source_channel`/`source_type` columns also allow).
 *
 * Mirrors `retrieval-shadow-log.ts` exactly: default OFF (gated on the same
 * `retrieval_shadow_log` flag → one flag, one retention story — both sinks share the
 * size-rotation in `bounded-jsonl-log.ts`), filters NOTHING, best-effort (a logging
 * failure never surfaces into the store), written next to `agent-memory.db` in the
 * persistent data dir, OUTSIDE backups and the migration export.
 */

export const MEMORY_WRITE_LOG_FILE = 'memory-write.jsonl';

/** One persisted line: the evidence + derived tier for a single store() call. */
export interface MemoryWriteLogEntry {
  /** Epoch millis at capture. */
  readonly ts: number;
  /** The write channel the caller reported (`user`/`ui`/`agent`/`upload`), or null if none. */
  readonly sourceChannel: string | null;
  /** Whether the writing turn had read untrusted content. */
  readonly sourceUntrusted: boolean;
  /** The tier DERIVED from the evidence (§3) — the histogram's value axis. */
  readonly sourceType: ProvenanceKind;
  /** The namespace written to. */
  readonly namespace: string;
  /** Embedding model identity — the corpus a Wave-2 floor would bind to. */
  readonly embeddingModel: string;
}

/**
 * Append one write-telemetry record as a JSON line to the size-bounded sink.
 * Fire-and-forget: the caller does `void appendMemoryWriteLog(...)` and never awaits.
 * Best-effort — any FS error is swallowed so the store is untouched.
 */
export function appendMemoryWriteLog(entry: MemoryWriteLogEntry): Promise<void> {
  return appendBoundedJsonl(MEMORY_WRITE_LOG_FILE, entry);
}
