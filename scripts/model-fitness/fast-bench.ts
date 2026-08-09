#!/usr/bin/env npx tsx
/**
 * FAST-slot compaction benchmark (P3 design, 2026-07).
 *
 * The fast slot does NO conversation in lynox — it writes compaction summaries
 * (`Session.compact()`, `compaction_model ?? 'fast'`), classifies inbox mail, and
 * recovers follow-up chips. This bench measures the FIRST of those jobs: each
 * candidate gets a hand-authored stress transcript PRELOADED in real thread form
 * (tool_use/tool_result blocks, long tool outputs, DE+EN, topic switches,
 * 20k-80k tokens) plus the EXACT production summarizer prompt
 * (`src/core/compaction-prompt.ts` — extracted, not paraphrased), and its summary
 * is scored two ways:
 *
 *   1. mechanical literal recall against the transcript's PLANTED checklist
 *      (paths / ids / amounts — contained or not, no LLM), and
 *   2. an 8-element rubric judged by a DEEP model that NEVER shares a family
 *      with the candidate (DEF-replay-judge-self-family).
 *
 * Decision rule (P3): a candidate HOLDS the fast slot iff literal recall ≥95%
 * AND its judge score is within-noise of the reference model (haiku-4.5).
 *
 * Usage:  npx tsx scripts/model-fitness/fast-bench.ts [--runs N] [--only <label>] [--transcript <id>]
 * Keys:   ANTHROPIC_API_KEY / MISTRAL_API_KEY / FIREWORKS_API_KEY env, else ~/.lynox/config.json.
 * Cost:   ~12 transcripts × candidates × runs; 20k-80k input tokens per call — budget $10-20 for a full pass.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCompactionSummaryPrompt } from '../../src/core/compaction-prompt.js';
import { createLLMClient } from '../../src/core/llm-client.js';
import { isDirectInvocation } from './replay.js';
import {
  FIREWORKS_BASE, RUBRIC_SIZE,
  buildBenchMarkdown, buildRubricJudgePrompt, checkServedModel, decideFastSlot,
  expandTranscript, handAuthoredText, literalsMissingFromTranscript,
  mean, parseRubricJudgeResponse, parseTranscript, pickJudgeModel,
  scoreLiteralRecall, stddev,
  type BenchMatrix, type BenchRow, type Transcript,
} from './fast-bench-lib.js';

const MISTRAL_BASE = 'https://api.mistral.ai/v1';

interface FastCandidate {
  label: string;
  provider: 'anthropic' | 'openai';
  modelId: string;
  apiBaseURL?: string;
  keyName: 'anthropic' | 'mistral' | 'fireworks';
  /** The within-noise baseline every other candidate is compared against. */
  reference?: boolean;
}

/**
 * The fast-slot candidate set. Every id is registered in
 * `src/types/models.ts` MODEL_CAPABILITIES (the corpus test pins that — a typo'd
 * id would otherwise fail only at replay time against the live endpoint).
 * haiku-4.5 is the REFERENCE: the current MODEL_MAP.fast, i.e. what the slot
 * runs today — candidates must reach its band, not beat it.
 */
export const FAST_CANDIDATES: FastCandidate[] = [
  { label: 'haiku-4.5 (reference)', provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001', keyName: 'anthropic', reference: true },
  { label: 'ministral-8b (mistral)', provider: 'openai', modelId: 'ministral-8b-2512', apiBaseURL: MISTRAL_BASE, keyName: 'mistral' },
  { label: 'deepseek-v4-flash (fireworks)', provider: 'openai', modelId: 'accounts/fireworks/models/deepseek-v4-flash', apiBaseURL: FIREWORKS_BASE, keyName: 'fireworks' },
  { label: 'qwen3.7-plus (fireworks)', provider: 'openai', modelId: 'accounts/fireworks/models/qwen3p7-plus', apiBaseURL: FIREWORKS_BASE, keyName: 'fireworks' },
  { label: 'gpt-oss-120b (fireworks)', provider: 'openai', modelId: 'accounts/fireworks/models/gpt-oss-120b', apiBaseURL: FIREWORKS_BASE, keyName: 'fireworks' },
  { label: 'kimi-k2.6 (fireworks)', provider: 'openai', modelId: 'accounts/fireworks/models/kimi-k2p6', apiBaseURL: FIREWORKS_BASE, keyName: 'fireworks' },
];

/** Same key sourcing as replay.ts: env first, then ~/.lynox/config.json. */
function loadKeys(): Record<'anthropic' | 'mistral' | 'fireworks', string> {
  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(readFileSync(join(homedir(), '.lynox', 'config.json'), 'utf8')) as Record<string, unknown>; } catch { /* env only */ }
  const pick = (env: string, cfgKey: string): string => process.env[env] ?? (typeof cfg[cfgKey] === 'string' ? cfg[cfgKey] as string : '');
  return {
    anthropic: pick('ANTHROPIC_API_KEY', 'anthropic_api_key'),
    mistral: pick('MISTRAL_API_KEY', 'mistral_api_key'),
    fireworks: pick('FIREWORKS_API_KEY', 'fireworks_api_key'),
  };
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const CORPUS_DIR = join(HERE, 'fast-corpus');

export function loadCorpus(dir: string = CORPUS_DIR): Transcript[] {
  const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  return files.map(f => parseTranscript(JSON.parse(readFileSync(join(dir, f), 'utf8'))));
}

/** Instrument preflight (eval-preflight rule): a corpus whose planted literals
 *  do not actually occur in the transcript, or whose transcripts miss the real
 *  thread-length band, produces a plausible number that measures nothing.
 *  Refuse to run — do not warn-and-continue. */
export function preflightCorpus(corpus: readonly Transcript[]): string[] {
  const problems: string[] = [];
  for (const t of corpus) {
    const missing = literalsMissingFromTranscript(t);
    if (missing.length > 0) problems.push(`${t.id}: checklist literals never occur in transcript: ${missing.join(', ')}`);
    if (t.checklist.rubric.length !== RUBRIC_SIZE) problems.push(`${t.id}: rubric has ${t.checklist.rubric.length} elements, expected ${RUBRIC_SIZE}`);
    const { approxTokens } = expandTranscript(t);
    if (approxTokens < 20_000 || approxTokens > 80_000) {
      problems.push(`${t.id}: expanded size ~${approxTokens} tokens outside the 20k-80k design band`);
    }
  }
  return problems;
}

interface ContentBlock { type: string; text?: string }

const SUMMARY_MAX_TOKENS = 4096;
const CALL_TIMEOUT_MS = 240_000;

/** Minimal system frame. KNOWN FIDELITY GAP, documented in the README: the
 *  production summarizer runs inside the full agent system prompt; replaying a
 *  raw-sink capture of a real compaction turn closes that gap once captures
 *  exist. The transcript preload itself IS the real thread form. */
const BENCH_SYSTEM = 'You are the assistant in an ongoing work thread. The conversation so far is provided; follow the final user instruction exactly.';

async function summarizeOnce(c: FastCandidate, t: Transcript, key: string): Promise<{ text: string; served: string | undefined; ms: number; inTok: number; outTok: number; error?: string }> {
  const started = Date.now();
  try {
    const client = createLLMClient({
      provider: c.provider,
      apiKey: key,
      ...(c.apiBaseURL ? { apiBaseURL: c.apiBaseURL } : {}),
      ...(c.provider === 'openai' ? { openaiModelId: c.modelId } : {}),
    });
    const { messages } = expandTranscript(t);
    const outbound = [...messages, { role: 'user' as const, content: [{ type: 'text' as const, text: buildCompactionSummaryPrompt() }] }];
    const stream = client.beta.messages.stream({
      model: c.modelId,
      max_tokens: SUMMARY_MAX_TOKENS,
      system: BENCH_SYSTEM,
      messages: outbound,
    } as never);
    const final = await Promise.race([
      stream.finalMessage(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timeout ${CALL_TIMEOUT_MS}ms`)), CALL_TIMEOUT_MS)),
    ]);
    const text = ((final.content ?? []) as ContentBlock[]).filter(b => b.type === 'text').map(b => b.text ?? '').join('\n');
    const u = (final as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
    const served = (final as { model?: string }).model;
    return { text, served, ms: Date.now() - started, inTok: u?.input_tokens ?? 0, outTok: u?.output_tokens ?? 0 };
  } catch (err) {
    return { text: '', served: undefined, ms: Date.now() - started, inTok: 0, outTok: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

async function judgeOnce(candidateModelId: string, t: Transcript, summary: string, keys: Record<'anthropic' | 'mistral' | 'fireworks', string>): Promise<{ score: number; invalid: boolean; judgeModel: string; error?: string }> {
  const judge = pickJudgeModel(candidateModelId);
  const key = keys[judge.keyName];
  if (!key) return { score: 0, invalid: true, judgeModel: judge.modelId, error: `no ${judge.keyName} key for judge` };
  try {
    const client = createLLMClient({
      provider: judge.provider,
      apiKey: key,
      ...(judge.apiBaseURL ? { apiBaseURL: judge.apiBaseURL } : {}),
      ...(judge.provider === 'openai' ? { openaiModelId: judge.modelId } : {}),
    });
    // Digest: the hand-authored spine only (planted facts + turns), not the pad
    // noise — the judge grades preservation, it does not need 60k tokens of logs.
    const digest = handAuthoredText(t).slice(0, 24_000);
    const prompt = buildRubricJudgePrompt(t.checklist.rubric, digest, summary.slice(0, 16_000));
    const stream = client.beta.messages.stream({
      model: judge.modelId,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    } as never);
    const final = await Promise.race([
      stream.finalMessage(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('judge timeout 120s')), 120_000)),
    ]);
    const text = ((final.content ?? []) as ContentBlock[]).filter(b => b.type === 'text').map(b => b.text ?? '').join('\n');
    const parsed = parseRubricJudgeResponse(text, t.checklist.rubric.length);
    return { score: parsed.score, invalid: parsed.invalid, judgeModel: judge.modelId };
  } catch (err) {
    return { score: 0, invalid: true, judgeModel: judge.modelId, error: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const runs = Number(argv[argv.indexOf('--runs') + 1]) || 2;
  const onlyIdx = argv.indexOf('--only');
  const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : undefined;
  const trIdx = argv.indexOf('--transcript');
  const onlyTranscript = trIdx >= 0 ? argv[trIdx + 1] : undefined;

  let corpus = loadCorpus();
  if (onlyTranscript) corpus = corpus.filter(t => t.id.includes(onlyTranscript));
  if (corpus.length === 0) { console.error('no transcripts matched'); process.exit(1); }

  const problems = preflightCorpus(corpus);
  if (problems.length > 0) {
    console.error('✗ CORPUS PREFLIGHT FAILED — refusing to measure with a broken instrument:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`Corpus preflight OK: ${corpus.length} transcripts, every planted literal present, all in the 20k-80k band.\n`);

  const keys = loadKeys();
  const reference = FAST_CANDIDATES.find(c => c.reference)!;
  let candidates = only ? FAST_CANDIDATES.filter(c => c.label.toLowerCase().includes(only.toLowerCase())) : FAST_CANDIDATES;
  // The decision rule is relative to the reference band — a run without the
  // reference is not a measurement (same lesson as replay.ts's control gate).
  if (!candidates.some(c => c.reference)) candidates = [reference, ...candidates];

  const rows: BenchRow[] = [];
  for (const c of candidates) {
    const key = keys[c.keyName];
    if (!key) { console.log(`${c.label.padEnd(30)} SKIP — no ${c.keyName} key`); continue; }
    for (const t of corpus) {
      for (let run = 1; run <= runs; run++) {
        const s = await summarizeOnce(c, t, key);
        const servedCheck = s.error ? { ok: false, note: 'run errored' } : checkServedModel(c.modelId, s.served);
        const recall = s.error ? { hits: [], misses: t.checklist.literals, recall: 0, invalid: true } : scoreLiteralRecall(s.text, t.checklist.literals);
        const judged = s.error ? { score: 0, invalid: true, judgeModel: pickJudgeModel(c.modelId).modelId, error: 'run errored' } : await judgeOnce(c.modelId, t, s.text, keys);
        rows.push({
          label: c.label, transcriptId: t.id, run,
          literalRecall: recall.recall, misses: recall.misses,
          judgeScore: judged.score, judgeInvalid: judged.invalid, judgeModel: judged.judgeModel,
          servedOk: servedCheck.ok, servedNote: servedCheck.note,
          latencyMs: s.ms, inTok: s.inTok, outTok: s.outTok,
          ...(s.error ?? judged.error ? { error: s.error ?? judged.error } : {}),
        });
        const flag = servedCheck.ok ? '' : ' ⚠served';
        console.log(`${c.label.padEnd(30)} ${t.id.padEnd(28)} run ${run}: recall ${(recall.recall * 100).toFixed(0)}% judge ${judged.invalid ? 'INVALID' : judged.score + '/' + t.checklist.rubric.length} ${(s.ms / 1000).toFixed(1)}s${flag}${s.error ? ` ERROR ${s.error}` : ''}`);
      }
    }
  }

  // Aggregate + verdicts
  const byLabel = new Map<string, BenchRow[]>();
  for (const r of rows) { const arr = byLabel.get(r.label) ?? []; arr.push(r); byLabel.set(r.label, arr); }
  const refRows = byLabel.get(reference.label) ?? [];
  const refAgg = {
    judgeMean: mean(refRows.filter(r => !r.judgeInvalid).map(r => r.judgeScore)),
    judgeStd: stddev(refRows.filter(r => !r.judgeInvalid).map(r => r.judgeScore)),
    invalid: refRows.length === 0 || refRows.some(r => r.judgeInvalid || !r.servedOk || r.error !== undefined),
  };
  const aggregates = [...byLabel.entries()].map(([label, rs]) => {
    const agg = {
      literalRecall: mean(rs.map(r => r.literalRecall)),
      judgeMean: mean(rs.filter(r => !r.judgeInvalid).map(r => r.judgeScore)),
      invalid: rs.some(r => r.judgeInvalid || !r.servedOk || r.error !== undefined),
    };
    return { label, agg, verdict: decideFastSlot(agg, refAgg) };
  });

  const matrix: BenchMatrix = { timestamp: new Date().toISOString(), referenceLabel: reference.label, rows, aggregates };
  const outDir = join(HERE, 'results');
  mkdirSync(outDir, { recursive: true });
  const stamp = matrix.timestamp.replace(/[:.]/g, '-');
  const mdPath = join(outDir, `fast-bench-${stamp}.md`);
  const jsonPath = join(outDir, `fast-bench-${stamp}.json`);
  writeFileSync(mdPath, buildBenchMarkdown(matrix));
  writeFileSync(jsonPath, JSON.stringify(matrix, null, 2));
  console.log(`\n${buildBenchMarkdown(matrix)}`);
  console.log(`Written: ${mdPath}\n         ${jsonPath}`);
  if (refAgg.invalid) {
    console.error('\n✗ Reference (haiku-4.5) aggregate INVALID — no candidate verdict from this run is quotable.');
    process.exit(1);
  }
}

if (isDirectInvocation(import.meta.url, process.argv[1])) void main();
