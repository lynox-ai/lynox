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
// LYNOX_KNOWLEDGE_GOLD at the operator's frozen gold-set OUTSIDE this public repo (a
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
//     meetsGate() for the human to read — the canary flip is the operator's call on the
//     frozen gold-set, not this test's.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
import { makeRealReplayThread, makeLlmJudge, replayFailures, resetReplayFailures, type ReplayProviderConfig } from './knowledge-substrate-replay.js';
import { makeLegacyReplayThread } from './knowledge-substrate-baseline.js';
import { resolveReplayProvider } from './knowledge-substrate-provider.js';
import { HAIKU } from '../online/setup.js';

/** Read ~/.lynox/config.json (same store as the CLI). Missing/corrupt → {}, which
 *  the resolver reads as "nothing configured" and self-skips on. */
function readCliConfig(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(homedir(), '.lynox', 'config.json'), 'utf8')) as Record<string, unknown>;
  } catch { return {}; }
}

/** Resolution itself lives in `knowledge-substrate-provider.ts` — pure, and
 *  contract-tested there. It is where this harness has silently mis-measured
 *  before (wrong provider → every turn 400s into the runner's swallow → recall
 *  0.00 reported as a RESULT), and a resolver inside a `.test.ts` cannot be
 *  imported by a test without executing the eval. */
function resolveProvider(): ReplayProviderConfig | null {
  const r = resolveReplayProvider(
    process.env as NodeJS.ProcessEnv & Record<string, string | undefined>,
    readCliConfig(),
    p => readFileSync(p, 'utf8'),
    HAIKU,
  );
  if (r === null) return null;
  // The pure resolver leaves the Anthropic wire implicit (no `provider` field);
  // the Agent config wants it named.
  return r.provider === 'openai' ? r : { ...r, provider: 'anthropic' };
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
    // LYNOX_KNOWLEDGE_BASELINE=1 replays the SAME corpus with durable memory OFF —
    // the legacy pipeline a tenant runs today. It is the comparison the tier bars
    // were never set against: a recall figure is unreadable until you know whether
    // today's number is higher or lower.
    const BASELINE = process.env['LYNOX_KNOWLEDGE_BASELINE'] === '1';
    const makeThread = BASELINE ? makeLegacyReplayThread : makeRealReplayThread;
    const replayThread = makeThread({
      ...provider,
      onTurn: (threadId, turnSeq) => process.stderr.write(`  [turn] ${threadId.slice(0, 8)} t${turnSeq}\n`),
    });
    // The endpoint is in the banner deliberately: a run that silently resolved to
    // the wrong provider prints a plausible model name and then fails every turn
    // into a swallowed catch, reading as recall 0.00 (2026-07-27).
    //
    // But it is LABELLED, never printed verbatim, when the operator points this at a
    // local host: this banner exists to be read and pasted next to the numbers, and
    // this is a PUBLIC repo. A literal `127.0.0.1:<port>` in a pasted log is exactly
    // the operator-local-tooling leak that had to be scrubbed on 2026-07-27, and no
    // guard scans stdout. The label still distinguishes the three cases, which is all
    // the failure mode above needs.
    const rawBase = 'apiBaseURL' in provider ? provider.apiBaseURL : undefined;
    const endpoint = !rawBase
      ? 'api.anthropic.com'
      : rawBase.includes('api.mistral.ai') ? 'api.mistral.ai' : '<operator-local endpoint>';
    process.stdout.write(`\n[knowledge-eval] mode=${BASELINE ? 'BASELINE (durable memory OFF)' : 'DK (durable memory ON)'} provider=${provider.provider ?? 'anthropic'} endpoint=${endpoint} model=${provider.model} corpus=${corpus.threads.length} threads\n`);

    const reports: KnowledgeReplayReport[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      // Persist every captured entry per thread — the throwaway dbs are deleted,
      // and the junk/matched review (the 10% human spot-check + junk-label
      // calibration) needs the actual texts, not just the aggregate counts.
      const capturedLog: unknown[] = [];
      // Per RUN, not per invocation: the counters are module-level, so without this
      // run 2 reports run 1's failures on top of its own and the persisted rate only
      // ever climbs — a worst-of-N verdict built on a cumulative denominator.
      resetReplayFailures();
      // eslint-disable-next-line no-await-in-loop
      const r = await runReplayEval(corpus, {
        replayThread,
        onProgress: (_done, _total, thread, rows) => { capturedLog.push({ threadId: thread.id, stratum: thread.stratum, captured: rows }); },
      }, judge);
      const failPct = replayFailures.turns === 0 ? 0 : (100 * replayFailures.sends) / replayFailures.turns;
      // Printed EVERY run, not only when non-zero: a silent 0% is the evidence that the
      // number below is a measurement rather than a swallowed outage.
      process.stdout.write(`\n[knowledge-eval] run ${run + 1}/${RUNS} (${provider.model}) — turn failures ${replayFailures.sends}/${replayFailures.turns} = ${failPct.toFixed(1)}%${failPct > 5 ? '  ⚠️ THE NUMBERS BELOW ARE NOT A RESULT' : ''}\n${formatReport(r)}\n`);
      reports.push(r);
      try {
        const { writeFileSync, mkdirSync } = await import('node:fs');
        const dir = join(homedir(), '.lynox', 'knowledge-gold', 'results');
        mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const mode = BASELINE ? 'baseline' : 'dk';
        const file = join(dir, `replay-${mode}-${stamp}-run${run + 1}.json`);
        // mode + gold vintage + content hash are LOAD-BEARING, not metadata: without them
        // two runs are indistinguishable after the fact, and a result cannot be tied to the
        // gold it scored. Both bit us — the 2026-07-16 results could not be attributed to a
        // gold vintage because the gold files had been overwritten, and the first DK/baseline
        // pair differed only by timestamp.
        const goldPath = process.env['LYNOX_KNOWLEDGE_GOLD'] ?? '(committed fixture)';
        const goldHash = createHash('sha256').update(readFileSync(goldPath === '(committed fixture)' ? join(__dirname, 'knowledge-substrate-fixtures.json') : goldPath)).digest('hex').slice(0, 16);
        writeFileSync(file, JSON.stringify({
          mode, provider: provider.provider, model: provider.model,
          gold: { path: goldPath, sha256: goldHash, threads: corpus.threads.length },
          turnFailures: { sends: replayFailures.sends, turns: replayFailures.turns },
          report: r, captures: capturedLog,
        }, null, 2));
        process.stdout.write(`[knowledge-eval] captures + report persisted → ${file}\n`);
      } catch (err) {
        process.stderr.write(`[knowledge-eval] persist failed (non-fatal): ${String(err).slice(0, 120)}\n`);
      }
    }
    const worst = worstOf(reports);
    process.stdout.write(`\n[knowledge-eval] WORST OF ${RUNS} — flip gate (recall≥${GATE.recall}, junk≤${GATE.junkRate}): ${meetsGate(worst) ? 'MET ✓ (canary flip is the operator\'s call)' : 'NOT MET (hold flip)'}\n${formatReport(worst)}\n`);

    // HARD — deterministic H4 security invariant: no untrusted write may land
    // active/pinned. DK-ONLY, because it asserts a property of the DK write path.
    //
    // In BASELINE mode the legacy store has no review queue at all, so every
    // untrusted write is a violation BY CONSTRUCTION and the assertion could only
    // ever be red. That is a PRODUCT FINDING about the flag-off pipeline, not an
    // instrument failure, and conflating the two is what this file avoids
    // everywhere else (see the note on quality assertions below). The count is
    // printed instead, so the finding is visible without the harness reporting
    // itself broken.
    if (BASELINE) {
      process.stdout.write(`\n[knowledge-eval] BASELINE routing: ${worst.routing.violations.length} untrusted write(s) landed active of ${worst.routing.untrustedWrites} exercised — the legacy store has no review queue, so this is the exposure, not a harness failure\n`);
    } else {
      expect(worst.routing.violations, JSON.stringify(worst.routing.violations, null, 2)).toHaveLength(0);
    }
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
