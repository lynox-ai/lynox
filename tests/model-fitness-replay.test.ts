/**
 * Unit coverage for the model-fitness wire-replay harness's pure decision helpers
 * (`scripts/model-fitness/replay.ts`).
 *
 * These decide which model is fit for a production slot, so they are covered here rather
 * than left in a script: `scripts/` is outside the tsconfig `include` and outside the vitest
 * `include`, so nothing there is typechecked or executed by CI. Same arrangement as
 * `tests/agent-efficiency-stats.test.ts`.
 *
 * Both suites below are regression tests for defects the harness actually shipped with.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CANDIDATES, LONG_CONTEXT_WARN_TOKENS, STAGE_SUCCESSOR, classifySpawn, compareStageCost, decideVerdict, isDirectInvocation,
  meanTurnCost, turnCostUSD, type PricedRun,
} from '../scripts/model-fitness/replay.js';
import { _resetOverridePricingForTests } from '../src/core/pricing.js';
import { MODEL_CAPABILITIES, MODEL_MAP, ownEntry } from '../src/types/models.js';

const SCRIPT = new URL('../scripts/model-fitness/replay.ts', import.meta.url).pathname;

interface Blk { type: string; text?: string; name?: string; input?: unknown }
const spawn = (agents: unknown): Blk[] => [{ type: 'tool_use', name: 'spawn_agent', input: { agents } }];

describe('classifySpawn', () => {
  it('reads the tier from agents[].model, not from free text', () => {
    expect(classifySpawn(spawn([{ name: 'a', task: 'analyse', model: 'deep' }])).deep).toBe(true);
    expect(classifySpawn(spawn([{ name: 'a', model: 'balanced' }, { name: 'b', model: 'deep' }])).deep).toBe(true);
  });

  it('does not treat the word "deep" in free-text fields as an escalation', () => {
    // The original detector stringified the whole input and searched for 'deep'.
    for (const spec of [
      { name: 'a', task: 'do a deep dive on competitors', model: 'balanced' },
      { name: 'a', task: 'research', context: 'deep background on pricing' },
      { name: 'a', task: 'research', system_prompt: 'go deep' },
    ]) {
      const r = classifySpawn(spawn([spec]));
      expect(r.deep).toBe(false);
      expect(r.delegated).toBe(true);
    }
  });

  it('is not satisfied by the quoted field appearing anywhere in the payload', () => {
    // Kills the near-miss mutation `JSON.stringify(a).includes('"model":"deep"')`, which passes
    // every other fixture here — without this case the suite proves only that the ORIGINAL
    // substring search was wrong, not that the tier is read from the field.
    //
    // It has to be a NESTED object: putting the text in `task` does not work, because
    // JSON.stringify escapes its quotes to \"model\":\"deep\" and the mutant survives. That is
    // how the first version of this test passed while failing to kill anything.
    const r = classifySpawn(spawn([{ name: 'a', model: 'balanced', thinking: { model: 'deep' } }]));
    expect(r.deep).toBe(false);
    expect(r.delegated).toBe(true);
  });

  it('separates delegation-without-deep from answering inline', () => {
    expect(classifySpawn(spawn([{ name: 'a', task: 'research', role: 'researcher' }])))
      .toMatchObject({ deep: false, delegated: true });
    expect(classifySpawn([{ type: 'text', text: 'Here is the analysis' }]))
      .toMatchObject({ deep: false, delegated: false });
    expect(classifySpawn([{ type: 'tool_use', name: 'web_research', input: { q: 'deep learning' } }]))
      .toMatchObject({ deep: false, delegated: false });
  });

  it('survives malformed model-controlled input', () => {
    // `agents: [null]` threw inside `.some()`, which surfaced as a run-level ERROR — and an
    // ERROR used to be able to flip the verdict (see decideVerdict below).
    for (const agents of [[null], [{ model: 5 }], 'deep', undefined, [undefined]]) {
      expect(() => classifySpawn(spawn(agents))).not.toThrow();
      expect(classifySpawn(spawn(agents)).deep).toBe(false);
    }
  });
});

describe('decideVerdict', () => {
  const esc = 'spawn_agent{deep}';

  it('scores the escalation bar against runs, so an ERROR cannot lower it', () => {
    // THE regression: scoring against survivors dropped the bar from 2 to 1, and one
    // transient failure turned the same single escalation into the opposite verdict.
    expect(decideVerdict([esc, 'inline', 'inline'], 3).verdict).toBe('inline');
    expect(decideVerdict([esc, 'inline', 'ERROR'], 3).verdict).toBe('inline');
  });

  it('still reaches ESCALATE on a real majority', () => {
    expect(decideVerdict([esc, esc, 'inline'], 3).verdict).toBe('ESCALATE');
    expect(decideVerdict([esc, esc, esc], 3).verdict).toBe('ESCALATE');
    expect(decideVerdict([esc, 'judge:offer', 'inline'], 3).verdict).toBe('ESCALATE');
  });

  it('refuses a verdict when more than a third errored, or nothing survived', () => {
    expect(decideVerdict(['ERROR', 'ERROR', esc], 3).verdict).toBe('INVALID');
    expect(decideVerdict(['ERROR', 'ERROR', 'ERROR'], 3).verdict).toBe('INVALID');
    // Exactly one third is still a measurement.
    expect(decideVerdict([esc, esc, 'ERROR'], 3).verdict).toBe('ESCALATE');
  });

  it('does not count delegation-without-deep as an escalation', () => {
    expect(decideVerdict(['spawn_agent{not-deep}', 'spawn_agent{not-deep}', 'inline'], 3).verdict).toBe('inline');
  });

  it('reports the counts it decided on', () => {
    expect(decideVerdict([esc, 'inline', 'ERROR'], 3)).toMatchObject({ escalated: 1, valid: 2, errors: 1 });
  });

  it('keeps the bar at `runs` even if fewer results arrive than were planned', () => {
    // `hows.length` and `runs` are separate parameters and the exported contract permits them
    // to differ. `runs` stays the authority for the bar — the planned evidence, not what
    // happened to survive — which is the whole point of the fix above.
    expect(decideVerdict([esc], 3).verdict).toBe('inline');
    expect(decideVerdict([esc, esc], 3).verdict).toBe('ESCALATE');
  });
});

describe('isDirectInvocation', () => {
  it('runs when the entry point is this module, however it is spelled', () => {
    expect(isDirectInvocation(pathToFileURL(SCRIPT).href, SCRIPT)).toBe(true);
  });

  it('runs through a symlink to the same file', () => {
    // The original guard compared raw strings and returned false here, so the CLI exited 0
    // having done nothing at all.
    const dir = mkdtempSync(join(tmpdir(), 'guard-'));
    const link = join(dir, 'linked.ts');
    try {
      symlinkSync(SCRIPT, link);
      expect(isDirectInvocation(pathToFileURL(SCRIPT).href, link)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs rather than falling silent when a path cannot be resolved', () => {
    // The second-round defect: resolving argv[1] failed, the helper fell back to comparing raw
    // strings, they differed, and main() silently did not run. Doubt must run the CLI.
    expect(isDirectInvocation(pathToFileURL(SCRIPT).href, '/nonexistent/replay.ts')).toBe(true);
    expect(isDirectInvocation('file:///nonexistent/module.ts', SCRIPT)).toBe(true);
    expect(isDirectInvocation(pathToFileURL(SCRIPT).href, undefined)).toBe(true);
  });

  it('does NOT run when the entry point is a different, real file', () => {
    // The counter-direction: a guard that always returns true is not a guard, and importing
    // this module for tests would then execute main().
    expect(isDirectInvocation(pathToFileURL(SCRIPT).href, new URL(import.meta.url).pathname)).toBe(false);
  });
});

describe('turnCostUSD', () => {
  // A pricing.json on the machine running the suite would otherwise price these ids.
  beforeEach(() => { _resetOverridePricingForTests({}); });
  afterEach(() => { _resetOverridePricingForTests(null); });

  it('prices input, output, cache writes and cache reads at the registry card', () => {
    // sonnet-5-5: $2 in, $10 out, $4 cache write, $0.10 cache read per MTok.
    const r = turnCostUSD('claude-sonnet-5-5', { input_tokens: 1_000_000, output_tokens: 100_000, cache_creation_input_tokens: 500_000, cache_read_input_tokens: 2_000_000 });
    expect(r.usd).toBeCloseTo(2 + 1 + 2 + 0.2, 10);
    expect(r.priced).toBe(true);
  });

  it('counts a missing cache field as none', () => {
    expect(turnCostUSD('claude-opus-5-5', { input_tokens: 1_000_000, output_tokens: 0 }).usd).toBeCloseTo(4, 10);
  });

  it('prices a Haiku 5.5 prompt over 100K tokens at the long-prompt card, and one at 100K at the short one', () => {
    // Short card $0.10 / $0.50, long card $0.50 / $2.50: five times, input and output.
    const short = turnCostUSD('claude-haiku-5-5', { input_tokens: 100_000, output_tokens: 1_000 });
    expect(short.usd).toBeCloseTo(0.1 * 0.1 + 0.001 * 0.5, 10);
    const long = turnCostUSD('claude-haiku-5-5', { input_tokens: 60_000, output_tokens: 1_000, cache_read_input_tokens: 40_001 });
    expect(long.usd).toBeCloseTo(5 * (0.06 * 0.1 + 0.001 * 0.5 + 0.040001 * 0.01), 10);
  });

  it('counts cache writes toward the Haiku 5.5 prompt length', () => {
    const r = turnCostUSD('claude-haiku-5-5', { input_tokens: 60_000, output_tokens: 0, cache_creation_input_tokens: 40_001 });
    expect(r.usd).toBeCloseTo(5 * (0.06 * 0.1 + 0.040001 * 0.2), 10);
  });

  it('keeps every other model at its card however long the prompt', () => {
    expect(turnCostUSD('claude-sonnet-4-6', { input_tokens: 500_000, output_tokens: 0 }).usd).toBeCloseTo(1.5, 10);
  });

  it('says when a model has no registered price', () => {
    expect(turnCostUSD('no-such-model-xyz', { input_tokens: 1000, output_tokens: 1000 }).priced).toBe(false);
  });
});

describe('compareStageCost', () => {
  it('sets each stage’s 5.5 successor against today’s model', () => {
    const rows = compareStageCost(new Map([
      [MODEL_MAP.deep, 0.10], [STAGE_SUCCESSOR.deep, 0.12],
      [MODEL_MAP.fast, 0.02], [STAGE_SUCCESSOR.fast, 0.005],
    ]));
    expect(rows.map(r => r.stage)).toEqual(['fast', 'deep']);
    const deep = rows.find(r => r.stage === 'deep')!;
    expect(deep).toMatchObject({ today: MODEL_MAP.deep, successor: 'claude-opus-5-5', todayUsd: 0.10, successorUsd: 0.12 });
    expect(deep.ratio).toBeCloseTo(1.2, 10);
    expect(rows.find(r => r.stage === 'fast')!.ratio).toBeCloseTo(0.25, 10);
  });

  it('leaves out a stage where either side has no valid turn', () => {
    expect(compareStageCost(new Map([[MODEL_MAP.balanced, 0.05]]))).toEqual([]);
    expect(compareStageCost(new Map([[STAGE_SUCCESSOR.balanced, 0.05]]))).toEqual([]);
  });

  it('leaves out a stage whose today model cost nothing, rather than dividing by zero', () => {
    expect(compareStageCost(new Map([[MODEL_MAP.deep, 0], [STAGE_SUCCESSOR.deep, 0.1]]))).toEqual([]);
  });
});

describe('meanTurnCost', () => {
  const run = (over: Partial<PricedRun>): PricedRun => ({ how: 'inline', usd: 0.1, priced: true, hasUsage: true, promptTokens: 1000, ...over });

  it('averages only runs that answered and reported usage', () => {
    const r = meanTurnCost([run({ usd: 0.1 }), run({ usd: 0.3 }), run({ how: 'ERROR', usd: 0 }), run({ hasUsage: false, usd: 0 })]);
    expect(r).toMatchObject({ counted: 2, priced: true, longContext: false });
    expect(r!.mean).toBeCloseTo(0.2, 10);
  });

  it('says when any run fell back to the conservative rate', () => {
    expect(meanTurnCost([run({}), run({ priced: false })])!.priced).toBe(false);
  });

  it('flags a prompt over the long-context mark', () => {
    expect(meanTurnCost([run({ promptTokens: LONG_CONTEXT_WARN_TOKENS + 1 })])!.longContext).toBe(true);
    expect(meanTurnCost([run({ promptTokens: LONG_CONTEXT_WARN_TOKENS })])!.longContext).toBe(false);
  });

  it('gives nothing when no run counts', () => {
    expect(meanTurnCost([run({ how: 'ERROR' })])).toBeUndefined();
  });
});

describe('CANDIDATES stay in lockstep with the model registry', () => {
  it('every Anthropic candidate id is registered, and every stage has today’s model and its 5.5 successor', () => {
    const anthropic = CANDIDATES.filter((c) => c.keyName === 'anthropic');
    for (const c of anthropic) {
      expect(ownEntry(MODEL_CAPABILITIES, c.modelId), `${c.label}: ${c.modelId} must be registered`).toBeDefined();
    }
    for (const stage of ['fast', 'balanced', 'deep'] as const) {
      for (const id of [MODEL_MAP[stage], STAGE_SUCCESSOR[stage]]) {
        const c = anthropic.find((x) => x.modelId === id);
        expect(c, `${stage}: ${id} must be a replay candidate`).toBeDefined();
        expect(c!.stage).toBe(stage);
      }
    }
  });

  it('every Fireworks candidate id is registered in MODEL_CAPABILITIES', async () => {
    // A typo'd id in the candidate list would otherwise surface only at replay
    // time as a live-endpoint 404 — this pins the list to the registry, which is
    // page-verified (model-presets-registry.test.ts). Mistral/Anthropic ids are
    // covered by their own registry tests; the Fireworks wave is what grows here.
    const { CANDIDATES } = await import('../scripts/model-fitness/replay.js');
    const { MODEL_CAPABILITIES } = await import('../src/types/models.js');
    const fireworks = CANDIDATES.filter((c) => c.keyName === 'fireworks');
    for (const c of fireworks) {
      expect(MODEL_CAPABILITIES[c.modelId], `${c.label}: ${c.modelId} must be registered`).toBeDefined();
    }
  });

  it('every Fireworks model a preset pins is a replay candidate', async () => {
    // This used to be a count (`>= 7`, the size of the 2026-08-09 picker wave). A count
    // holds a list at its size, so when the provider withdrew five of those models the
    // only way to keep it green was to keep the dead ids — which made every replay of
    // them a 404. What the replay has to cover is the set a preset can actually route
    // to, so that is what this asserts.
    const { CANDIDATES } = await import('../scripts/model-fitness/replay.js');
    const { pinnedSlots, FIREWORKS_HOST } = await import('./online/preset-slots.js');
    const replayIds = new Set(CANDIDATES.filter((c) => c.keyName === 'fireworks').map((c) => c.modelId));
    const pinned = pinnedSlots().filter((s) => s.baseUrl.includes(FIREWORKS_HOST)).map((s) => s.modelId);
    expect(pinned.length, 'the presets pin no Fireworks slot — this check would pass vacuously').toBeGreaterThan(0);
    expect(pinned.filter((id) => !replayIds.has(id))).toEqual([]);
  });
});
