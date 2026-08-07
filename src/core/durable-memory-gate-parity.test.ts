import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The durable-memory tool REGISTRATION and the durable-memory store WIRING sit ~450 lines apart
 * in engine.ts and must fire under the same condition. When they drifted, the failure was silent
 * and total.
 *
 * Registration was gated on the flag alone; wiring additionally required `this.engineDb`, which
 * the constructor leaves null when opening engine.db fails (caught on purpose so chat still
 * boots). In that state the six durable tools were registered over a null `knowledgeStore` and
 * every one of them answered "Durable memory is not enabled for this agent" — while the else
 * branch never ran, so the six legacy `memory_*` tools were absent too. The tenant had no memory
 * at all: boot green, /api/health OK, one line on stderr.
 *
 * It was carried as dormant because reaching it took a deliberate operator flip on a watched
 * instance. The control-plane default flipped ON (pro migration 0048), so it became the path
 * every newly provisioned tenant takes — the same defect at a different blast radius.
 *
 * A behavioural test would have to mock the whole tool surface to construct an Engine, which is
 * why the drift went unnoticed in the first place. This pins the thing that actually broke: that
 * the two conditions are the same text. Comment lines are stripped before matching — a sibling
 * guard in the pro repo once read its answer out of a prose comment and passed while the code
 * said the opposite.
 */

const ENGINE_TS = fileURLToPath(new URL('./engine.ts', import.meta.url));

function codeLines(): string[] {
  return readFileSync(ENGINE_TS, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'));
}

/** Every `if (…)` condition in engine.ts that mentions `durable_memory_enabled`. */
function durableGateConditions(): string[] {
  const out: string[] = [];
  for (const line of codeLines()) {
    if (!line.includes('durable_memory_enabled')) continue;
    const m = /if\s*\((.+)\)\s*\{?\s*$/.exec(line.trim());
    if (m?.[1]) out.push(m[1].trim());
  }
  return out;
}

describe('engine.ts — durable-memory registration and wiring share one gate', () => {
  it('finds the gates at all (the guard\'s own substrate)', () => {
    // Without this the assertion below passes vacuously the day the conditions are reformatted
    // across lines or the flag is renamed — an empty list is trivially "all equal".
    expect(durableGateConditions().length).toBeGreaterThanOrEqual(2);
  });

  it('every durable_memory_enabled gate is the identical condition', () => {
    const conditions = durableGateConditions();
    const distinct = [...new Set(conditions)];
    expect(
      distinct,
      `engine.ts gates durable memory on ${String(distinct.length)} DIFFERENT conditions:\n` +
      distinct.map((c) => `  ${c}`).join('\n') +
      `\nRegistration and store wiring must agree, or a tenant ends up with durable tools over a ` +
      `null store AND no legacy fallback — no memory at all, silently.`,
    ).toHaveLength(1);
  });

  it('the shared gate requires engine.db, not just the flag', () => {
    // The direction matters and the equality above cannot see it: both sites agreeing on the
    // flag ALONE is exactly the broken state this guard was written for.
    const [condition] = [...new Set(durableGateConditions())];
    expect(condition).toContain('this.engineDb');
  });
});
