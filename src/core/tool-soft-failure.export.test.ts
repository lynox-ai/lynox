import { describe, it, expect } from 'vitest';

/**
 * Residuum 4 of four (closing comment 2026-08-02): the package entry point.
 *
 * A tool OUTSIDE this package — a plugin, or an integration living in the pro
 * repo — cannot signal "completed but did not succeed" unless the symbol is
 * reachable from the package root. Without the export its calls stay booked as
 * successes no matter what the ledger does, which is the defect this whole
 * change exists to remove, merely relocated to everyone else's tools.
 *
 * Asserted through the ENTRY POINT, not the module: importing
 * `./tool-soft-failure.js` directly would pass with the export line deleted.
 */
describe('package entry point — ToolSoftFailure is reachable', () => {
  it('exports the class and the type guard from src/index.ts', async () => {
    const entry = await import('../index.js') as Record<string, unknown>;
    expect(typeof entry['ToolSoftFailure'], 'the class tools throw').toBe('function');
    expect(typeof entry['isToolSoftFailure'], 'the guard consumers narrow with').toBe('function');
  });

  it('the exported class is the one the agent unwraps', async () => {
    const entry = await import('../index.js') as {
      ToolSoftFailure: new (payload: string, reason: string) => Error;
      isToolSoftFailure: (e: unknown) => boolean;
    };
    const internal = await import('./tool-soft-failure.js');
    const instance = new entry.ToolSoftFailure('payload', 'reason');
    // Same identity, not merely the same shape: a re-declared twin would satisfy
    // the typeof checks above while the agent's `instanceof` narrowing missed it.
    expect(instance).toBeInstanceOf(internal.ToolSoftFailure);
    expect(entry.isToolSoftFailure(instance)).toBe(true);
  });
});
