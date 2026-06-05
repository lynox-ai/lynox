/**
 * Run executor — the dispatch + concurrency owner for chat runs (Tier 2).
 *
 * A chat run survives client disconnect (it finishes headless — PR-C) and its
 * activity is replayable (the run buffer — PR-D). This executor adds the two
 * remaining run-lifecycle concerns that must be **global to the engine**, not
 * bound to a request:
 *
 *   1. **Concurrency cap (D-S2, AC6):** at most `maxConcurrent` runs execute at
 *      once; the next dispatch is refused (the HTTP layer returns a typed
 *      "queue full" so the client can surface it). Bounds LLM-cost blast from
 *      many parallel headless runs and the buffer-memory growth (R3).
 *   2. **Abort registry (AC10):** a live run can be aborted by runId from any
 *      connection (`DELETE /api/runs/:runId`) or the stop button — the abort fn
 *      is the same `session.abort()` path the request used to own.
 *
 * Execution itself still runs in the HTTP handler (headless after disconnect,
 * per PR-C); the executor is the engine-owned accounting + cap + abort seam.
 * The lifecycle clock (30-min cap, heartbeat, orphan watchdog) stays anchored
 * where PR-C placed it — already correct for a headless run.
 */

/** Default max concurrent chat runs per engine (D-S2). Configurable via
 * `config.maxConcurrentRuns`. Five covers realistic multi-tab / parallel-thread
 * use while bounding cost + memory. */
export const DEFAULT_MAX_CONCURRENT_RUNS = 5;

interface ActiveRun {
  runId: string;
  threadId: string;
  abort: () => void;
}

export class RunExecutor {
  private readonly active = new Map<string, ActiveRun>();
  private readonly maxConcurrent: number;

  constructor(maxConcurrent: number = DEFAULT_MAX_CONCURRENT_RUNS) {
    this.maxConcurrent = Math.max(1, Math.floor(maxConcurrent));
  }

  get capacity(): number {
    return this.maxConcurrent;
  }

  get activeCount(): number {
    return this.active.size;
  }

  /** True when a fresh dispatch would exceed the cap — the HTTP layer checks
   * this BEFORE writing SSE headers and returns 429 "run queue full". */
  atCapacity(): boolean {
    return this.active.size >= this.maxConcurrent;
  }

  /** Register a now-executing run with its abort handle. Idempotent per runId
   * (a re-acquire replaces the handle — e.g. a takeover rewiring abort). The
   * caller MUST have checked `atCapacity()` first; acquire itself does not gate
   * (so an in-flight run being re-registered never trips the cap). */
  acquire(runId: string, threadId: string, abort: () => void): void {
    this.active.set(runId, { runId, threadId, abort });
  }

  /** Drop a run from the active set (terminal completion). Idempotent. */
  release(runId: string): void {
    this.active.delete(runId);
  }

  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  /** Abort a live run by id. Returns false if no such run is active (the
   * caller maps that to 404 — no existence oracle beyond "is it live"). */
  abort(runId: string): boolean {
    const run = this.active.get(runId);
    if (!run) return false;
    try { run.abort(); } catch { /* abort is best-effort; the run unwinds itself */ }
    return true;
  }

  /** runIds currently executing (for diagnostics / tests). */
  activeRunIds(): string[] {
    return [...this.active.keys()];
  }
}
