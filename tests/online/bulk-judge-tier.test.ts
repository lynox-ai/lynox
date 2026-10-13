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
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { callForStructuredJson, extractionSpendOf } from '../../src/core/llm-helper.js';
import { clientForTierSnapshot, createLLMClient } from '../../src/core/llm-client.js';
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

const MODELS: ReadonlyArray<{ provider: ProviderKey; modelId: string }> = [
  { provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001' },
  { provider: 'mistral', modelId: 'ministral-8b-2512' },
  { provider: 'mistral', modelId: 'mistral-medium-2604' },
  { provider: 'anthropic', modelId: 'claude-sonnet-4-6' },
];

function configKey(field: string): string | undefined {
  try {
    const c = JSON.parse(readFileSync(join(homedir(), '.lynox', 'config.json'), 'utf8')) as Record<string, unknown>;
    const v = c[field];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  } catch { return undefined; }
}
const ANTHROPIC_KEY = process.env['ANTHROPIC_API_KEY'] ?? configKey('anthropic_api_key');
const MISTRAL_KEY = process.env['MISTRAL_API_KEY'] ?? configKey('mistral_api_key');

const asked = MODE === 'smoke' || MODE === 'full';
const describeE2 = asked && ANTHROPIC_KEY && MISTRAL_KEY ? describe : describe.skip;

function outDir(): string {
  const dir = process.env['LYNOX_E2_OUT'] ?? join(tmpdir(), `bulk-judge-e2-${new Date().toISOString().slice(0, 10)}`, MODE ?? 'none');
  mkdirSync(dir, { recursive: true });
  return dir;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describeE2('E2 bulk_judge model tier (spends money)', () => {
  it(`runs ${MODE ?? ''} under a hard limit of ${String(LIMIT_USD)} USD`, async () => {
    const ambient = createLLMClient({ provider: 'anthropic', apiKey: ANTHROPIC_KEY });
    const clientFor = (m: { provider: ProviderKey; modelId: string }) => clientForTierSnapshot(
      m.provider === 'mistral'
        ? { provider: 'mistral', modelId: m.modelId, apiKey: MISTRAL_KEY, apiBaseURL: MISTRAL_BASE_URL }
        : { provider: m.provider, modelId: m.modelId },
      ambient, 'anthropic',
    );

    const smokeModel = process.env['LYNOX_E2_SMOKE_MODEL'] ?? MODELS[0]!.modelId;
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
            const worst = (Math.ceil((JUDGE_SYSTEM.length + user.length) / 2) * price.input + MAX_OUTPUT_TOKENS * price.output) / 1_000_000;
            if (spent + worst > LIMIT_USD) { aborted = `limit: spent ${spent.toFixed(4)} + next worst ${worst.toFixed(4)} > ${String(LIMIT_USD)}`; break; }
            let o: CallOutcome | null = null;
            for (let attempt = 0; attempt < 3 && o === null; attempt++) {
              // Latency of the attempt that answered, without the backoff before it.
              const t0 = Date.now();
              try {
                const r = await callForStructuredJson<Record<string, unknown>>({
                  client, model: m.modelId, system: JUDGE_SYSTEM, user, schema: rule.schema,
                  maxOutputTokens: MAX_OUTPUT_TOKENS, budgetUsd: 0.05,
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
