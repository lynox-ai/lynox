// === Durable Knowledge Substrate — score persisted replay runs (the gate CLI) ===
//
// Scores one or two persisted replay results (the JSON files
// `knowledge-substrate-eval.test.ts` writes per run) through the §5.6 gate
// metric: tiered COVERAGE over the user-provenance denominator, and — with two
// results — the BINDING comparison gate (`meetsComparisonGate`).
//
//   npx tsx tests/eval/knowledge-substrate-score.ts <dk-result.json> [<legacy-result.json>]
//
// The INSTRUMENT lives here; the DATA stays with the operator. Inputs:
//   LYNOX_KNOWLEDGE_GOLD    path to the gold corpus (.json GoldCorpus or .jsonl of
//                           GoldThread rows). Default: the path recorded in the
//                           result file itself — always vintage-checked by sha256.
//   LYNOX_KNOWLEDGE_LABELS  path to the fact labels (tier + provenance). Accepts a
//                           flat GoldFactLabels record, or the operator-local shape
//                           { provenance: {id: src}, items: [{id, tier}] }.
//   SCORE_PROXY_URL         OpenAI-compatible /chat/completions base for the
//                           coverage judge. NO default — this is a public repo and
//                           operator-local endpoints do not belong in it.
//   SCORE_PROXY_KEY         bearer key (or SCORE_PROXY_KEY_FILE to read one).
//   SCORE_MODEL             judge model id.
//
// Judge-error handling matches `scoreTieredCoverage`: a failed call is a MISSING
// verdict, counted and reported — never folded into the miss column.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  scoreTieredCoverage,
  meetsComparisonGate,
  formatTieredReport,
  formatComparison,
  parseGoldFactLabels,
  type CapturedEntry,
  type CoverageJudge,
  type GoldCorpus,
  type GoldThread,
  type KnowledgeReplayReport,
  type TieredCoverageReport,
} from './knowledge-substrate-runner.js';

// ── Result-file shape (what the eval test persists) ──────────────────────────

interface RunFile {
  mode?: string;
  provider?: string;
  model?: string;
  gold?: { path?: string; sha256?: string; threads?: number };
  turnFailures?: { sends: number; turns: number };
  report: KnowledgeReplayReport;
  captures?: Array<{ threadId: string; captured?: CapturedEntry[] }>;
}

function fail(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(2);
}

const files = process.argv.slice(2);
if (files.length === 0 || files.length > 2) {
  fail('usage: npx tsx tests/eval/knowledge-substrate-score.ts <dk-result.json> [<legacy-result.json>]');
}

// ── Gold + labels ────────────────────────────────────────────────────────────

function loadCorpus(path: string): GoldCorpus {
  const raw = readFileSync(path, 'utf8');
  if (path.endsWith('.jsonl')) {
    const threads = raw.split('\n').map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l) as GoldThread);
    return { version: 1, generatedAt: 'external', generator: path, threads };
  }
  return JSON.parse(raw) as GoldCorpus;
}


// ── Coverage judge over an OpenAI-compatible endpoint ────────────────────────

const JUDGE_SYS = 'You compare two short business notes. Answer strictly with a single word: "yes" if the CANDIDATE records the same underlying fact as the GOLD note — paraphrase counts, and so does a statement that clearly ENTAILS the gold fact (e.g. "prefers X over Y, will not use Y" entails "dislikes Y"). Answer "no" if it records a different, missing, or contradictory fact. Output only "yes" or "no".';

function makeFetchCoverageJudge(): CoverageJudge {
  const base = process.env['SCORE_PROXY_URL'];
  if (!base) fail('SCORE_PROXY_URL is not set — point it at an OpenAI-compatible /v1 base for the coverage judge.');
  const keyFile = process.env['SCORE_PROXY_KEY_FILE'];
  const key = (process.env['SCORE_PROXY_KEY'] ?? (keyFile ? readFileSync(keyFile, 'utf8') : '')).trim();
  if (!key) fail('SCORE_PROXY_KEY (or SCORE_PROXY_KEY_FILE) is not set.');
  const model = process.env['SCORE_MODEL'];
  if (!model) fail('SCORE_MODEL is not set.');

  const cache = new Map<string, boolean>();
  let done = 0;
  return async (gold: string, candidateBlock: string): Promise<boolean> => {
    const cacheKey = JSON.stringify([gold, candidateBlock]);
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, max_tokens: 10,
        messages: [
          { role: 'system', content: JUDGE_SYS },
          { role: 'user', content: `GOLD: ${gold}\nCANDIDATE (everything this conversation stored):\n${candidateBlock}\n\nIs the gold fact recorded somewhere in the candidate? yes or no.` },
        ],
      }),
    });
    if (!res.ok) throw new Error(`judge HTTP ${res.status}`);
    const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const out = body.choices?.[0]?.message?.content ?? '';
    done += 1;
    process.stderr.write(`\r  judging… ${done} calls`);
    const verdict = /\byes\b/i.test(out) && !/\bno\b/i.test(out);
    cache.set(cacheKey, verdict);
    return verdict;
  };
}

// ── Score one run ────────────────────────────────────────────────────────────

interface ScoredRun {
  file: string;
  run: RunFile;
  ranThreads: Set<string>;
  captured: CapturedEntry[];
  tiered: TieredCoverageReport;
}

async function main(): Promise<void> {
  const runs = files.map(f => ({ file: f, run: JSON.parse(readFileSync(f, 'utf8')) as RunFile }));

  // One gold vintage for everything — refuse to score across vintages.
  const goldPath = process.env['LYNOX_KNOWLEDGE_GOLD'] ?? runs[0]!.run.gold?.path;
  if (!goldPath || goldPath === '(committed fixture)') {
    fail('No usable gold path — set LYNOX_KNOWLEDGE_GOLD (the result was scored against the committed fixture or predates the gold field).');
  }
  const goldHash = createHash('sha256').update(readFileSync(goldPath)).digest('hex').slice(0, 16);
  for (const r of runs) {
    const recorded = r.run.gold?.sha256;
    if (recorded && recorded !== goldHash) {
      fail(`⛔ GOLD VINTAGE MISMATCH: ${r.file} was produced against sha256=${recorded}, but ${goldPath} hashes to ${goldHash}. Scoring would judge a run against gold it never saw.`);
    }
  }
  const corpus = loadCorpus(goldPath);

  const labelsPath = process.env['LYNOX_KNOWLEDGE_LABELS'];
  if (!labelsPath) fail('LYNOX_KNOWLEDGE_LABELS is not set — the tier/provenance labels are the gate\'s denominator.');
  const labels = parseGoldFactLabels(JSON.parse(readFileSync(labelsPath, 'utf8')));

  const judge = makeFetchCoverageJudge();

  const scored: ScoredRun[] = [];
  for (const { file, run } of runs) {
    const captures = run.captures ?? [];
    if (captures.length === 0) fail(`${file} has no per-thread captures — it predates the capture log and cannot be coverage-scored.`);
    const ranThreads = new Set(captures.map(c => c.threadId));
    const captured = captures.flatMap(c => c.captured ?? []);

    process.stdout.write(`\n### ${file}\n`);
    const tf = run.turnFailures;
    const failPct = tf && tf.turns > 0 ? (100 * tf.sends) / tf.turns : null;
    process.stdout.write(`  mode=${run.mode ?? '(unlabelled)'} model=${run.model ?? '?'} provider=${run.provider ?? '?'}\n`);
    process.stdout.write(`  turn failures: ${tf ? `${tf.sends}/${tf.turns} = ${failPct!.toFixed(1)}%` : 'NOT RECORDED'}${failPct !== null && failPct > 5 ? '   ⚠️ NOT A RESULT' : ''}\n`);

    const tiered = await scoreTieredCoverage(corpus, captured, labels, judge, { ranThreadIds: ranThreads });
    process.stderr.write('\n');
    process.stdout.write(`${formatTieredReport(tiered)}\n`);
    const j = run.report.junk;
    process.stdout.write(`  junk (verbatim from the run's own report): rate ${(100 * j.junkRate).toFixed(1)}% (${j.junkCount} of ${run.report.totalCaptured}) · junk-control writes ${j.junkControlWrites}\n`);
    process.stdout.write(`  routing: ${run.report.routing.violations.length} violation(s), ${run.report.routing.untrustedWrites} untrusted writes exercised\n`);
    scored.push({ file, run, ranThreads, captured, tiered });
  }

  if (scored.length === 2) {
    const [dk, legacy] = scored as [ScoredRun, ScoredRun];
    if (dk.run.model !== legacy.run.model) {
      fail('\n⛔ DIFFERENT MODEL — these two runs are NOT comparable; no gate verdict.');
    }
    // Compare only over threads BOTH runs replayed: two runs over different
    // thread sets are two different measurements, and one denominator would hand
    // the advantage to whichever ran the easier subset.
    const both = new Set([...dk.ranThreads].filter(t => legacy.ranThreads.has(t)));
    const differ = both.size !== dk.ranThreads.size || both.size !== legacy.ranThreads.size;
    if (differ) {
      process.stdout.write(`\n⚠️ thread sets differ — comparing the INTERSECTION (${both.size} threads)\n`);
    }
    const dkT = differ ? await scoreTieredCoverage(corpus, dk.captured, labels, judge, { ranThreadIds: both }) : dk.tiered;
    const legT = differ ? await scoreTieredCoverage(corpus, legacy.captured, labels, judge, { ranThreadIds: both }) : legacy.tiered;
    process.stderr.write('\n');

    const verdict = meetsComparisonGate(
      { tiered: dkT, report: dk.run.report },
      { tiered: legT, report: legacy.run.report },
    );
    process.stdout.write(`\n${formatComparison(verdict)}\n`);
    const errs = dkT.judgeErrors.length + legT.judgeErrors.length;
    if (errs > 0) {
      process.stdout.write(`⚠️ ${errs} judge call(s) failed across the two sides — those facts carry NO verdict; re-run before quoting the gate.\n`);
    }
  }
}

void main();
