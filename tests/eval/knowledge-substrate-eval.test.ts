// === Durable Knowledge Substrate (DK.0) — gated real-LLM gold replay ===
//
// The real measurement leg. Replays the gold-set through a real Agent driving the
// DK.1 `remember`/`recall` tools against a throwaway engine.db, scores it with an
// LLM fact-match judge, and reports the four DK.0 metrics + the flip gate. Slow +
// costs tokens, so it self-skips unless BOTH `LYNOX_EVAL=1` and an API key are set
// (same gate as the other eval harnesses).
//
//   LYNOX_EVAL=1 ANTHROPIC_API_KEY=… npx vitest run tests/eval/knowledge-substrate-eval.test.ts
//
// Corpus: the committed synthetic fixture by default. For the REAL gate run, point
// LYNOX_KNOWLEDGE_GOLD at rafael's frozen gold-set OUTSIDE this public repo (a
// `.json` GoldCorpus or a `.jsonl` of GoldThread rows) — real thread content must
// never land in the public core repo.
//
// What is asserted here vs. reported:
//   - HARD: routing is clean (zero untrusted writes escaped the review queue) —
//     a deterministic H4 security invariant, not a tuning knob.
//   - HARD: the harness actually captured something (wiring smoke).
//   - SANITY floors (recall/junk) so the instrument does not false-fail on benign
//     model drift.
//   - The FLIP decision (recall ≥ 0.7 AND junk ≤ 0.2, worst of N) is PRINTED via
//     meetsGate() for the human to read — the canary flip is rafael's call on the
//     frozen gold-set, not this test's.

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  runReplayEval,
  worstOf,
  meetsGate,
  formatReport,
  GATE,
  type GoldCorpus,
  type GoldThread,
  type KnowledgeReplayReport,
} from './knowledge-substrate-runner.js';
import { makeRealReplayThread, makeLlmJudge, type ReplayProviderConfig } from './knowledge-substrate-replay.js';
import { HAIKU } from '../online/setup.js';

/** Read a string field from ~/.lynox/config.json (same store as the CLI). */
function readConfigKey(field: string): string | undefined {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.lynox', 'config.json'), 'utf8')) as Record<string, unknown>;
    const v = cfg[field];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  } catch { return undefined; }
}

/**
 * Resolve the replay provider from the environment — PROVIDER-AGNOSTIC so the
 * gate runs on whatever stack the operator uses. Anthropic (Haiku) when an
 * Anthropic key is present; otherwise Mistral EU (`api.mistral.ai/v1`) when a
 * Mistral key is present — the latter is the only path that runs on a
 * Mistral-only box AND keeps rafael's real thread content in the EU (mirrors the
 * gold-gen label pass). `LYNOX_KNOWLEDGE_PROVIDER`/`_MODEL` override.
 */
function resolveProvider(): ReplayProviderConfig | null {
  const forced = process.env['LYNOX_KNOWLEDGE_PROVIDER'];
  const anthropicKey = process.env['ANTHROPIC_API_KEY'] ?? readConfigKey('api_key');
  const mistralKey = process.env['MISTRAL_API_KEY'] ?? readConfigKey('mistral_api_key');
  const modelOverride = process.env['LYNOX_KNOWLEDGE_MODEL'];

  // 'proxy' — a local CLIProxyAPI (github.com/router-for-me/CLIProxyAPI) exposing
  // Claude models over the OpenAI wire on localhost, backed by the operator's
  // Claude subscription. Operator-chosen for LOCAL eval runs so the CP's API
  // credits stay reserved for tenants. Explicit opt-in only (never auto-picked);
  // the client key is the localhost-only credential the proxy config defines.
  if (forced === 'proxy') {
    let proxyKey: string | undefined;
    try { proxyKey = readFileSync(join(homedir(), '.cli-proxy-api', '.local-eval-key'), 'utf8').trim(); } catch { /* not set up */ }
    if (!proxyKey) return null;
    const m = modelOverride ?? 'claude-sonnet-4-6';
    return { provider: 'openai', apiKey: proxyKey, apiBaseURL: process.env['LYNOX_KNOWLEDGE_PROXY_URL'] ?? 'http://127.0.0.1:8317/v1', model: m, openaiModelId: m };
  }

  const useAnthropic = forced ? forced === 'anthropic' : Boolean(anthropicKey);
  if (useAnthropic && anthropicKey) {
    return { provider: 'anthropic', apiKey: anthropicKey, model: modelOverride ?? HAIKU };
  }
  if (mistralKey && forced !== 'anthropic') {
    // NEVER a `-latest` alias: Mistral's latest tags carry much lower rate
    // limits, which grinds a long replay into 429s and reads as artificially
    // low recall. Pin the last stable dated snapshot — the canonical ids live
    // in MISTRAL_MODEL_MAP (src/types/models.ts) / catalog.ts.
    const m = modelOverride ?? 'mistral-large-2512';
    return { provider: 'openai', apiKey: mistralKey, apiBaseURL: 'https://api.mistral.ai/v1', model: m, openaiModelId: m };
  }
  return null;
}

const PROVIDER = resolveProvider();
const RUN = process.env['LYNOX_EVAL'] === '1' && PROVIDER !== null;
const RUNS = Math.max(1, Number(process.env['LYNOX_KNOWLEDGE_RUNS'] ?? '2'));

function loadCorpus(): GoldCorpus {
  const override = process.env['LYNOX_KNOWLEDGE_GOLD'];
  if (override) {
    const raw = readFileSync(override, 'utf8');
    if (override.endsWith('.jsonl')) {
      const threads = raw.split('\n').map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l) as GoldThread);
      return { version: 1, generatedAt: 'external', generator: override, threads };
    }
    return JSON.parse(raw) as GoldCorpus;
  }
  return JSON.parse(readFileSync(join(__dirname, 'knowledge-substrate-fixtures.json'), 'utf8')) as GoldCorpus;
}

describe.skipIf(!RUN)('Durable Knowledge Substrate — gold replay (real LLM)', () => {
  it('captures durable facts, keeps junk out, and never lets an untrusted write escape the queue', async () => {
    const provider = PROVIDER!;
    const corpus = loadCorpus();
    const judge = makeLlmJudge(provider);
    // Turn-level progress to stderr — without it a long replay is a black box
    // (learned on the first real-gold run: 45 minutes of WAL/CPU archaeology to
    // tell a grinding monster thread from a hung one).
    const replayThread = makeRealReplayThread({
      ...provider,
      onTurn: (threadId, turnSeq) => process.stderr.write(`  [turn] ${threadId.slice(0, 8)} t${turnSeq}\n`),
    });
    process.stdout.write(`\n[knowledge-eval] provider=${provider.provider ?? 'anthropic'} model=${provider.model} corpus=${corpus.threads.length} threads\n`);

    const reports: KnowledgeReplayReport[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      // Persist every captured entry per thread — the throwaway dbs are deleted,
      // and the junk/matched review (the 10% human spot-check + junk-label
      // calibration) needs the actual texts, not just the aggregate counts.
      const capturedLog: unknown[] = [];
      // eslint-disable-next-line no-await-in-loop
      const r = await runReplayEval(corpus, {
        replayThread,
        onProgress: (_done, _total, thread, rows) => { capturedLog.push({ threadId: thread.id, stratum: thread.stratum, captured: rows }); },
      }, judge);
      process.stdout.write(`\n[knowledge-eval] run ${run + 1}/${RUNS} (${provider.model})\n${formatReport(r)}\n`);
      reports.push(r);
      try {
        const { writeFileSync, mkdirSync } = await import('node:fs');
        const dir = join(homedir(), '.lynox', 'knowledge-gold', 'results');
        mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const file = join(dir, `replay-${stamp}-run${run + 1}.json`);
        writeFileSync(file, JSON.stringify({ provider: provider.provider, model: provider.model, report: r, captures: capturedLog }, null, 2));
        process.stdout.write(`[knowledge-eval] captures + report persisted → ${file}\n`);
      } catch (err) {
        process.stderr.write(`[knowledge-eval] persist failed (non-fatal): ${String(err).slice(0, 120)}\n`);
      }
    }
    const worst = worstOf(reports);
    process.stdout.write(`\n[knowledge-eval] WORST OF ${RUNS} — flip gate (recall≥${GATE.recall}, junk≤${GATE.junkRate}): ${meetsGate(worst) ? 'MET ✓ (canary flip is rafael\'s call)' : 'NOT MET (hold flip)'}\n${formatReport(worst)}\n`);

    // HARD — deterministic H4 security invariant: no untrusted write may land active/pinned.
    expect(worst.routing.violations, JSON.stringify(worst.routing.violations, null, 2)).toHaveLength(0);
    // HARD — wiring smoke: the agent actually used `remember` against the throwaway db.
    expect(worst.totalCaptured).toBeGreaterThan(0);
    // Deliberately NO quality assertions here. The first real-gold round measured
    // recall 42% / junk 80% — an honest, actionable reading that must leave the
    // INSTRUMENT green (a red test conflates instrument health with model
    // quality). The flip verdict is the printed meetsGate() line: the operator's
    // call, tuned via the capture prompt + junk-label calibration, never forced
    // by this test.
    // Default 2h; LYNOX_KNOWLEDGE_TIMEOUT_MS overrides — the deep-thread corpus
    // (76/64/64/149 turns, growing contexts) legitimately needs 4-8h in one
    // invocation, and a timeout kill loses the whole run (captures are in-memory).
  }, Number(process.env['LYNOX_KNOWLEDGE_TIMEOUT_MS'] ?? 7_200_000));
});
