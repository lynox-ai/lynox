/**
 * E2 of PRD bulk-loop §8: the cheapest model tier per provider that holds the schema, keeps
 * the rule and is not steered by the product record. Cases, prompt and scoring are in
 * `bulk-judge-cases.ts`; the scoring is checked without a provider call in
 * `tests/bulk-judge-scoring.test.ts`.
 *
 * Spends money, so it runs only when asked for twice: `LYNOX_ONLINE=1` (all online tests)
 * AND `LYNOX_E2=smoke|full`. `smoke` is one call on Haiku, or on `LYNOX_E2_SMOKE_MODEL` to check a provider's wire first; `full` is 40 fixtures × 2 rules ×
 * 3 repetitions × 4 models = 960 calls. A hard limit of 3 USD actual spend (from each reply's
 * usage) is checked before every call; reaching it stops the run and says so.
 *
 * Path: `callForStructuredJson` with an explicit client from `clientForTierSnapshot` — the
 * path L2 takes (Anthropic native, Mistral over the openai wire). Keys from the environment
 * or `~/.lynox/config.json`. Raw outcomes are appended to `<out>/calls.jsonl` as they come
 * (`LYNOX_E2_OUT`, else a dated folder under the temp dir — set it to keep the data),
 * so an aborted run keeps what it paid for.
 */
import { describe, it, expect } from 'vitest';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOperatorConfig, reportMissingKey } from '../../scripts/test-run-home.js';
import { callForStructuredJson, extractionSpendOf } from '../../src/core/llm-helper.js';
import { clientForTierSnapshot, createLLMClient } from '../../src/core/llm-client.js';
import { FIREWORKS_API_BASE } from '../../src/core/tier-presets.js';
import { modelCapability } from '../../src/types/models.js';
import type { ProviderKey } from '../../src/types/provider-registry.js';
import {
  FIXTURES, JUDGE_SYSTEM, RULES, injectionByModel, summarize, userMessage,
  type CallOutcome, type Fixture, type RuleId,
} from './bulk-judge-cases.js';

const MODE = process.env['LYNOX_E2'];
const LIMIT_USD = 3;
const MAX_OUTPUT_TOKENS = 400;
const REPS = 3;
const MISTRAL_BASE_URL = 'https://api.mistral.ai/v1';

type Family = 'anthropic' | 'mistral' | 'fireworks';
interface Candidate {
  family: Family;
  modelId: string;
  /** Output budget when the model thinks without saying so in its capability entry (measured). */
  maxOutput?: number;
}

/** Every model the eval knows. `LYNOX_E2_MODELS` (comma list) picks from it; unset → the first four. */
const CANDIDATES: readonly Candidate[] = [
  { family: 'anthropic', modelId: 'claude-haiku-4-5-20251001' },
  { family: 'mistral', modelId: 'ministral-8b-2512' },
  { family: 'mistral', modelId: 'mistral-medium-2604' },
  { family: 'anthropic', modelId: 'claude-sonnet-4-6' },
  { family: 'mistral', modelId: 'mistral-small-2603' },
  { family: 'fireworks', modelId: 'accounts/fireworks/models/deepseek-v4p1-flash' },
  // Measured 2026-10-13: on R-a it spends all 400 tokens thinking and never calls the tool;
  // the capability entry declares no thinking. Same headroom as the thinking-only models.
  { family: 'fireworks', modelId: 'accounts/fireworks/models/minimax-m3', maxOutput: 1424 },
  { family: 'fireworks', modelId: 'accounts/fireworks/models/gpt-oss-120b' },
  { family: 'fireworks', modelId: 'accounts/fireworks/models/glm-5p3' },
];
const picked = process.env['LYNOX_E2_MODELS']?.split(',').map((x) => x.trim()).filter(Boolean);
const MODELS: readonly Candidate[] = picked ? CANDIDATES.filter((c) => picked.includes(c.modelId)) : CANDIDATES.slice(0, 4);
const unknownPicks = (picked ?? []).filter((id) => !CANDIDATES.some((c) => c.modelId === id));

/**
 * Output budget per call. A model the provider will not let stop thinking needs room above its
 * measured silent bound, or the adapter refuses the call; its thinking is billed as output and
 * so shows in the measured cost. Everyone else gets the judge's own small budget.
 */
function maxOutputFor(m: Candidate): number {
  if (m.maxOutput !== undefined) return m.maxOutput;
  const silent = modelCapability(m.modelId)?.thinkingOnly?.emptyAtOrBelow;
  return silent === undefined ? MAX_OUTPUT_TOKENS : silent + 1024;
}

// The developer's own config, read only: the suite points HOME at a directory of its own
// (`scripts/test-run-home.ts`).
function configKey(field: string): string | undefined {
  const v = readOperatorConfig().config?.[field];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
// `||`, not `??`: an empty variable falls back to the config, as the missing-key message says.
const ANTHROPIC_KEY = (process.env['ANTHROPIC_API_KEY'] || configKey('anthropic_api_key'));
const MISTRAL_KEY = (process.env['MISTRAL_API_KEY'] || configKey('mistral_api_key'));
const FIREWORKS_KEY = (process.env['FIREWORKS_API_KEY'] || configKey('fireworks_api_key'));
const KEYS: Record<Family, string | undefined> = { anthropic: ANTHROPIC_KEY, mistral: MISTRAL_KEY, fireworks: FIREWORKS_KEY };

const asked = MODE === 'smoke' || MODE === 'full';
// Every picked model needs its key. A name in LYNOX_E2_MODELS that matches no candidate fails the run.
const describeE2 = asked && ANTHROPIC_KEY && MODELS.every((m) => KEYS[m.family]) ? describe : describe.skip;
// Asked for and still skipped is a failed lookup, not "nothing to run": say where it looked.
// Only the families that are missing, so the message names what is actually absent.
const missingFamilies = [...new Set<Family>(['anthropic', ...MODELS.map((m) => m.family)])].filter((f) => !KEYS[f]);
if (asked && missingFamilies.length > 0) {
  reportMissingKey(
    `bulk-judge e2 (${missingFamilies.join(', ')})`,
    missingFamilies.map((f) => `${f.toUpperCase()}_API_KEY`),
    missingFamilies.map((f) => `${f}_api_key`),
  );
}

function outDir(): string {
  const dir = process.env['LYNOX_E2_OUT'] ?? join(tmpdir(), `bulk-judge-e2-${new Date().toISOString().slice(0, 10)}`, MODE ?? 'none');
  mkdirSync(dir, { recursive: true });
  return dir;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describeE2('E2 bulk_judge model tier (spends money)', () => {
  it(`runs ${MODE ?? ''} under a hard limit of ${String(LIMIT_USD)} USD`, async () => {
    const ambient = createLLMClient({ provider: 'anthropic', apiKey: ANTHROPIC_KEY });
    // Mistral and Fireworks both ride the openai wire, as the tier presets route them.
    const snapshot = (m: Candidate): { provider: ProviderKey; modelId: string; apiKey?: string | undefined; apiBaseURL?: string | undefined } => {
      if (m.family === 'mistral') return { provider: 'mistral', modelId: m.modelId, apiKey: MISTRAL_KEY, apiBaseURL: MISTRAL_BASE_URL };
      if (m.family === 'fireworks') return { provider: 'openai', modelId: m.modelId, apiKey: FIREWORKS_KEY, apiBaseURL: FIREWORKS_API_BASE };
      return { provider: 'anthropic', modelId: m.modelId };
    };
    const clientFor = (m: Candidate) => clientForTierSnapshot(snapshot(m), ambient, 'anthropic');

    expect(unknownPicks, 'LYNOX_E2_MODELS names no such candidate').toEqual([]);
    const smokeModel = process.env['LYNOX_E2_SMOKE_MODEL'] ?? MODELS[0]?.modelId;
    const models = MODE === 'smoke' ? MODELS.filter((m) => m.modelId === smokeModel) : MODELS;
    expect(models.length).toBeGreaterThan(0);
    const fixtures: readonly Fixture[] = MODE === 'smoke' ? FIXTURES.filter((f) => f.id === 'c01') : FIXTURES;
    const rules: readonly RuleId[] = MODE === 'smoke' ? ['R-b'] : ['R-a', 'R-b'];
    const reps = MODE === 'smoke' ? 1 : REPS;

    const dir = outDir();
    const jsonl = join(dir, 'calls.jsonl');
    writeFileSync(jsonl, '');
    const outcomes: CallOutcome[] = [];
    let spent = 0;
    let aborted: string | null = null;
    const startedAt = new Date().toISOString();

    for (const m of models) {
      const client = clientFor(m);
      // Repetitions in the outer loop: a run stopped by the limit still has whole passes.
      for (let rep = 0; rep < reps && !aborted; rep++) {
        for (const f of fixtures) {
          for (const ruleId of rules) {
            const rule = RULES[ruleId];
            const user = userMessage(rule, f);
            // Worst case for the next call: two characters per token in, the full output cap out.
            const price = modelCapability(m.modelId)!.pricing;
            const maxOut = maxOutputFor(m);
            const worst = (Math.ceil((JUDGE_SYSTEM.length + user.length) / 2) * price.input + maxOut * price.output) / 1_000_000;
            if (spent + worst > LIMIT_USD) { aborted = `limit: spent ${spent.toFixed(4)} + next worst ${worst.toFixed(4)} > ${String(LIMIT_USD)}`; break; }
            let o: CallOutcome | null = null;
            for (let attempt = 0; attempt < 3 && o === null; attempt++) {
              // Latency of the attempt that answered, without the backoff before it.
              const t0 = Date.now();
              try {
                const r = await callForStructuredJson<Record<string, unknown>>({
                  client, model: m.modelId, system: JUDGE_SYSTEM, user, schema: rule.schema,
                  maxOutputTokens: maxOut, budgetUsd: 0.05,
                });
                o = { fixture: f.id, rule: ruleId, model: m.modelId, rep, data: r.data, error: null, costUsd: r.costUsd, inputTokens: r.inputTokens, outputTokens: r.outputTokens, ms: Date.now() - t0 };
              } catch (err) {
                const name = err instanceof Error ? err.name : 'unknown';
                const spend = extractionSpendOf(err);
                if (spend !== undefined || name === 'ExtractShapeError' || name === 'SchemaValueError') {
                  o = { fixture: f.id, rule: ruleId, model: m.modelId, rep, data: null, error: name, costUsd: spend?.costUsd ?? 0, ms: Date.now() - t0 };
                } else if (attempt === 2) {
                  o = { fixture: f.id, rule: ruleId, model: m.modelId, rep, data: null, error: `${name}: ${String((err as Error).message ?? '').slice(0, 120)}`, costUsd: 0, ms: Date.now() - t0 };
                } else {
                  await sleep(2000 * 4 ** attempt);
                }
              }
            }
            spent += o!.costUsd;
            outcomes.push(o!);
            appendFileSync(jsonl, `${JSON.stringify(o)}\n`);
          }
          if (aborted) break;
        }
      }
      if (aborted) break;
    }

    const cells = summarize(outcomes, fixtures);
    const injection = Object.fromEntries(injectionByModel(outcomes, fixtures));
    const summary = { mode: MODE, startedAt, endedAt: new Date().toISOString(), limitUsd: LIMIT_USD, spentUsd: spent, calls: outcomes.length, aborted, cells, injection };
    writeFileSync(join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`[E2] ${MODE} → ${dir}: ${String(outcomes.length)} calls, ${spent.toFixed(4)} USD${aborted ? `, ABORTED (${aborted})` : ''}`);

    expect(aborted).toBeNull();
    // Transport errors leave a fixture's denominator; a run that lost answers is not a clean run.
    for (const c of cells) expect(c.transportErrors, `${c.model} ${c.rule}`).toBe(0);
    expect(spent).toBeLessThanOrEqual(LIMIT_USD);
    if (MODE === 'smoke') {
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]!.error === null || outcomes[0]!.error === 'ExtractShapeError' || outcomes[0]!.error === 'SchemaValueError').toBe(true);
      expect(spent).toBeLessThan(0.01);
    }
  }, 3 * 60 * 60_000);
});
