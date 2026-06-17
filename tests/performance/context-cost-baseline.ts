/**
 * Context-cost Slice 0 — synthetic long-thread baseline harness.
 *
 * Reproduces the observed cost mechanism: the per-turn bill is the cache-read
 * floor (~$0.30/Mtok) on the WHOLE carried context, charged EVERY turn, so cost
 * ≈ context-size × turns. Compaction is %-of-window gated (never cost gated), so
 * a large thread on a big window carries a large live context indefinitely.
 *
 * It drives a growing synthetic thread through the SHARED `computeComposition`
 * probe (the same code the live `context_cost_log` hook runs), emits a baseline
 * JSON + a printed summary, and projects the two candidate levers:
 *   • L1 — cost-aware compaction (cap occupancy at a threshold)
 *   • L3 — tool-result dedup (drop verbatim resident duplicates)
 * so the L1-vs-L3 ordering can be decided from measured composition.
 *
 * ⚠️ SYNTHETIC: the per-turn sizes and the duplication rate are MODELED, not
 * measured. The real duplication share comes from the opt-in live hook
 * (`context_cost_log: true` → ~/.lynox/context-cost.jsonl) on a real thread.
 * This harness's job is the reproducible mechanism + the projection math + the
 * gate number Slice 1 re-measures against — not a ground-truth bill.
 *
 * Run:  npx tsx tests/performance/context-cost-baseline.ts
 * Out:  tests/performance/baselines/context-cost-baseline.json
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import { CHARS_PER_TOKEN } from '../../src/types/index.js';
import { computeComposition } from '../../src/core/context-composition-probe.js';

// ── Modeled parameters (documented; the live hook calibrates the real shape) ──
const TURNS = 40;
/** System prompt + tool schemas that live outside messages[], in tokens. */
const OVERHEAD_TOKENS = 9_000;
/** Anthropic standard cache-read price, USD per million tokens. */
const CACHE_READ_USD_PER_MTOK = 0.30;
/** A "large doc" tool_result (web_fetch / file read / doc edit), chars. */
const LARGE_DOC_CHARS = 80_000;
/** A "small" tool_result (status, small query), chars. */
const SMALL_RESULT_CHARS = 2_000;
/** Every Nth large-doc turn RE-FETCHES an earlier doc verbatim (the dup class). */
const REFETCH_EVERY = 3;
/** L1 projection: compact when modeled occupancy would exceed this. */
const L1_THRESHOLD_TOKENS = 120_000;
/** Tokens a compaction summary + retained recall handles cost (modeled). */
const L1_SUMMARY_TOKENS = 2_500;

function block(n: number, seed: string): string {
  // Deterministic filler — content identity matters for dup detection, so a
  // re-fetch reuses the SAME seed to produce a byte-identical payload.
  return (seed + ' ').repeat(Math.ceil(n / (seed.length + 1))).slice(0, n);
}

/** One realistic turn appended to the running thread. */
function appendTurn(messages: BetaMessageParam[], turn: number): void {
  messages.push({ role: 'user', content: block(400, `q${turn}`) });
  const id = `tool_${turn}`;
  messages.push({
    role: 'assistant',
    content: [
      { type: 'text', text: block(1_200, `a${turn}`) },
      { type: 'tool_use', id, name: turn % 2 === 0 ? 'web_fetch' : 'http_request', input: { url: `https://doc/${turn}` } },
    ],
  });
  // Large-doc turns alternate; every REFETCH_EVERY-th large-doc turn re-fetches
  // an EARLIER doc byte-for-byte (same seed) — the F3/F11 dup-fetch class.
  const isLargeDoc = turn % 2 === 0;
  let payload: string;
  if (isLargeDoc) {
    // Every REFETCH_EVERY-th large-doc turn re-fetches the PREVIOUS large-doc
    // turn's payload byte-for-byte (turn-2 is always an earlier original fetch),
    // modeling the dup-fetch class. Other large-doc turns produce a fresh doc.
    const docTurn = turn % (REFETCH_EVERY * 2) === 0 ? turn - 2 : turn;
    payload = block(LARGE_DOC_CHARS, `DOC_${docTurn}`);
  } else {
    payload = block(SMALL_RESULT_CHARS, `r${turn}`);
  }
  messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: payload }] });
}

const usd = (tokens: number): number => (tokens * CACHE_READ_USD_PER_MTOK) / 1_000_000;

interface PerTurn {
  turn: number;
  messageCount: number;
  occupancyTokens: number;
  cacheReadCostUsd: number;
  duplicateResidentBytes: number;
}

// ── Baseline run (no compaction — the status quo) ──────────────────────────
const messages: BetaMessageParam[] = [];
const perTurn: PerTurn[] = [];
let totalCacheReadTokens = 0;

for (let turn = 1; turn <= TURNS; turn++) {
  appendTurn(messages, turn);
  const snap = computeComposition(messages, { charsPerToken: CHARS_PER_TOKEN });
  const occupancy = Math.round(snap.messageTokensEstimate + OVERHEAD_TOKENS);
  totalCacheReadTokens += occupancy;
  perTurn.push({
    turn,
    messageCount: snap.messageCount,
    occupancyTokens: occupancy,
    cacheReadCostUsd: Number(usd(occupancy).toFixed(4)),
    duplicateResidentBytes: snap.duplicateResidentBytes,
  });
}

const finalSnap = computeComposition(messages, { charsPerToken: CHARS_PER_TOKEN });
const avgContextTokens = Math.round(totalCacheReadTokens / TURNS);
const totalCostUsd = usd(totalCacheReadTokens);

// ── L1 projection: cost-aware compaction at L1_THRESHOLD_TOKENS ────────────
// Re-walk the same turns; once modeled occupancy crosses the threshold, "compact"
// (history collapses to a summary), then keep accumulating.
let l1Tokens = 0;
let carriedSummaryTokens = 0;
let windowMessages: BetaMessageParam[] = [];
let compactions = 0;
for (let turn = 1; turn <= TURNS; turn++) {
  appendTurn(windowMessages, turn);
  const snap = computeComposition(windowMessages, { charsPerToken: CHARS_PER_TOKEN });
  let occupancy = snap.messageTokensEstimate + OVERHEAD_TOKENS + carriedSummaryTokens;
  if (occupancy > L1_THRESHOLD_TOKENS) {
    compactions++;
    carriedSummaryTokens += L1_SUMMARY_TOKENS;
    windowMessages = [];
    occupancy = OVERHEAD_TOKENS + carriedSummaryTokens; // post-compaction floor this turn
  }
  l1Tokens += Math.round(occupancy);
}
const l1CostUsd = usd(l1Tokens);

// ── L3 projection: drop verbatim resident duplicate tool_result bytes ──────
// Per turn, the duplicate-resident bytes are re-billed every subsequent turn
// they stay resident. Sum the cache-read tokens attributable to duplicates.
let l3DupTokens = 0;
for (const t of perTurn) {
  l3DupTokens += t.duplicateResidentBytes / CHARS_PER_TOKEN;
}
const l3SavingsUsd = usd(l3DupTokens);
const l3CostUsd = totalCostUsd - l3SavingsUsd;

const dupSharePct = Number(((finalSnap.duplicateResidentBytes / finalSnap.totalBytes) * 100).toFixed(1));

const baseline = {
  generated: 'SYNTHETIC — modeled per-turn sizes + duplication; cross-check the duplication share against the live context-cost.jsonl on a real thread.',
  params: {
    turns: TURNS,
    overheadTokens: OVERHEAD_TOKENS,
    charsPerToken: CHARS_PER_TOKEN,
    cacheReadUsdPerMtok: CACHE_READ_USD_PER_MTOK,
    largeDocChars: LARGE_DOC_CHARS,
    smallResultChars: SMALL_RESULT_CHARS,
    refetchEvery: REFETCH_EVERY,
    l1ThresholdTokens: L1_THRESHOLD_TOKENS,
    l1SummaryTokens: L1_SUMMARY_TOKENS,
  },
  baseline: {
    totalCacheReadTokens,
    totalCacheReadCostUsd: Number(totalCostUsd.toFixed(2)),
    avgContextTokensPerTurn: avgContextTokens,
    finalOccupancyTokens: perTurn[perTurn.length - 1]?.occupancyTokens ?? 0,
    finalComposition: {
      totalBytes: finalSnap.totalBytes,
      categories: finalSnap.categories,
      toolResultByTool: finalSnap.toolResultByTool,
      duplicateResidentBytes: finalSnap.duplicateResidentBytes,
      duplicateSharePctOfTotal: dupSharePct,
    },
  },
  projections: {
    l1CostAwareCompaction: {
      thresholdTokens: L1_THRESHOLD_TOKENS,
      compactions,
      totalCacheReadCostUsd: Number(l1CostUsd.toFixed(2)),
      savedUsd: Number((totalCostUsd - l1CostUsd).toFixed(2)),
      savedPct: Number((((totalCostUsd - l1CostUsd) / totalCostUsd) * 100).toFixed(1)),
    },
    l3ToolResultDedup: {
      duplicateResidentTokensOverThread: Math.round(l3DupTokens),
      totalCacheReadCostUsd: Number(l3CostUsd.toFixed(2)),
      savedUsd: Number(l3SavingsUsd.toFixed(2)),
      savedPct: Number(((l3SavingsUsd / totalCostUsd) * 100).toFixed(1)),
    },
  },
  perTurn,
};

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'baselines');
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'context-cost-baseline.json');
writeFileSync(outFile, JSON.stringify(baseline, null, 2) + '\n', 'utf8');

// ── Printed summary ────────────────────────────────────────────────────────
const b = baseline.baseline;
const l1 = baseline.projections.l1CostAwareCompaction;
const l3 = baseline.projections.l3ToolResultDedup;
const pct = (n: number): string => `${n}%`;
const lines = [
  '',
  'Context-cost Slice 0 — SYNTHETIC baseline (modeled; live hook gives ground truth)',
  '─'.repeat(78),
  `Thread:        ${TURNS} turns, ${b.finalComposition.totalBytes.toLocaleString()} message bytes at end`,
  `Cache-read:    ${b.totalCacheReadTokens.toLocaleString()} tokens over the thread → $${b.totalCacheReadCostUsd}`,
  `Avg context:   ${b.avgContextTokensPerTurn.toLocaleString()} tokens/turn (final ${b.finalOccupancyTokens.toLocaleString()})`,
  '',
  'Composition at end (bytes):',
  `  tool_result  ${b.finalComposition.categories.toolResult.toLocaleString()}`,
  `  assistant    ${b.finalComposition.categories.assistantText.toLocaleString()}`,
  `  user         ${b.finalComposition.categories.userText.toLocaleString()}`,
  `  tool_use     ${b.finalComposition.categories.toolUse.toLocaleString()}`,
  `  structural   ${b.finalComposition.categories.structural.toLocaleString()}`,
  `  ⮑ duplicate-resident tool_result: ${b.finalComposition.duplicateResidentBytes.toLocaleString()} bytes (${pct(b.finalComposition.duplicateSharePctOfTotal)} of total) = L3 ceiling`,
  '',
  'Lever projections (modeled):',
  `  L1 cost-aware compaction @${l1.thresholdTokens.toLocaleString()} tok: ${l1.compactions} compactions → $${l1.totalCacheReadCostUsd}  (save $${l1.savedUsd}, ${pct(l1.savedPct)})`,
  `  L3 tool-result dedup:                       → $${l3.totalCacheReadCostUsd}  (save $${l3.savedUsd}, ${pct(l3.savedPct)})`,
  '',
  `Baseline JSON → ${path.relative(process.cwd(), outFile)}`,
  '',
];
process.stdout.write(lines.join('\n'));
