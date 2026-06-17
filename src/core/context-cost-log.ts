import { appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
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
 *    dir (env `LYNOX_DATA_DIR`, else `~/.lynox`). That volume is writable in the
 *    managed read-only container (the DB lives there), so no extra wiring.
 */

export const CONTEXT_COST_LOG_FILE = 'context-cost.jsonl';

/** Resolve the data dir the same way the rest of the engine does. */
function dataDir(): string {
  const fromEnv = process.env['LYNOX_DATA_DIR'] ?? process.env['LYNOX_DIR'];
  return fromEnv && fromEnv.length > 0 ? fromEnv : path.join(homedir(), '.lynox');
}

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
 * Append one composition entry as a JSON line. Fire-and-forget: the caller does
 * `void appendContextCostLog(...)` and never awaits. Any error (read-only FS,
 * permission, disk full) is swallowed so the run is untouched.
 */
export async function appendContextCostLog(entry: ContextCostLogEntry): Promise<void> {
  try {
    const file = path.join(dataDir(), CONTEXT_COST_LOG_FILE);
    await appendFile(file, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Best-effort telemetry — never propagate.
  }
}
