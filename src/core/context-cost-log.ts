import { appendBoundedJsonl } from './bounded-jsonl-log.js';
import type { CompositionSnapshot } from './context-composition-probe.js';

/**
 * Context-cost Slice 0 — opt-in live capture sink.
 *
 * When the user sets `context_cost_log: true`, the agent emits one composition
 * snapshot per real API turn here. The point is GROUND-TRUTH composition from a
 * real thread (the synthetic harness only models the duplication rate) so the
 * L1-vs-L3 decision rests on measured numbers, not assumptions.
 *
 * Design constraints:
 *  - Default OFF: a single boolean check at the call site; zero overhead when off.
 *  - Best-effort: a logging failure must NEVER surface into the agent run, so
 *    every error is swallowed. Cost telemetry that crashes a chat is worse than
 *    no telemetry.
 *  - Deploy-safe path: written next to `agent-memory.db` in the persistent data
 *    dir (env `LYNOX_DATA_DIR`/`LYNOX_DIR`, else `~/.lynox`). That volume is writable
 *    in the managed read-only container (the DB lives there), so no extra wiring.
 *  - Bounded: retention is capped by the shared size-rotation in
 *    `bounded-jsonl-log.ts` (≤ 2× cap on disk), so an opt-in capture can't grow
 *    an unbounded file.
 */

export const CONTEXT_COST_LOG_FILE = 'context-cost.jsonl';

/** One persisted line: a snapshot plus the turn metadata that frames it. */
export interface ContextCostLogEntry extends CompositionSnapshot {
  /** Epoch millis at capture. */
  readonly ts: number;
  /** Thread id the turn belongs to, if known. */
  readonly thread: string | undefined;
  /** Model the turn ran against. */
  readonly model: string;
  /** Cache-read tokens reported for this turn (the actual billed floor), if known. */
  readonly cacheReadTokens: number | undefined;
}

/**
 * Append one composition entry as a JSON line to the size-bounded sink. Fire-and-forget:
 * the caller does `void appendContextCostLog(...)` and never awaits. Best-effort — any
 * FS error is swallowed so the run is untouched.
 */
export function appendContextCostLog(entry: ContextCostLogEntry): Promise<void> {
  return appendBoundedJsonl(CONTEXT_COST_LOG_FILE, entry);
}
