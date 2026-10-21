// === Signal shutdown — the process's answer to SIGTERM and SIGINT ===
//
// Moved out of `index.ts` so a test can send a real signal to a process that runs it.

/** What a signal shuts down: the HTTP API in production, an engine in the test. */
export interface SignalShutdownTarget {
  shutdown(options: { inboxBacklog: 'bounded' }): Promise<void>;
}

/**
 * On the first SIGTERM or SIGINT, shut `target` down once and exit, also when the shutdown throws.
 * The container runtime kills the process 10 s after the signal, so the inbox gets a bounded
 * share of that, and whatever it cannot classify in time is surfaced unclassified
 * (`Engine.shutdown`). SIGINT takes the same path: a stop is a stop. Closing the stores before
 * the exit keeps their WAL from being cut off.
 */
export function installSignalShutdown(target: SignalShutdownTarget): void {
  let shuttingDown = false;
  const graceful = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`\n[lynox] ${signal} received — shutting down…\n`);
    try { await target.shutdown({ inboxBacklog: 'bounded' }); } catch { /* best-effort */ }
    process.exit(0);
  };
  process.on('SIGINT', () => void graceful('SIGINT'));
  process.on('SIGTERM', () => void graceful('SIGTERM'));
}
