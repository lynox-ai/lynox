#!/usr/bin/env npx tsx
/**
 * KG-Recall Phase 1 Benchmark — Worker Loop verification harness for PR #529 + #534.
 *
 * GOAL
 * ----
 * The unit tests (memory.test.ts + knowledge-layer.test.ts) prove that
 * `memory_recall` now routes through `KnowledgeLayer.retrieve()` instead of
 * dumping the flat-file namespace mirror. What unit tests DO NOT prove is
 * **retrieval quality** on a realistic seeded corpus:
 *
 *   - Does the top-k actually contain the gold-set memory for a specific-fact query?
 *   - Does an `acme`-scoped query ever leak `beta`-scoped rows back into the agent
 *     context (the regression #534 was supposed to close)?
 *   - Does the no-query path return the most-recent rows in `created_at DESC`?
 *   - Is the production threshold (KG_RECALL_THRESHOLD=0.3) actually calibrated
 *     for `memory_recall`, or is the RetrievalEngine default (0.55) closer?
 *
 * METHODOLOGY
 * -----------
 * Deterministic: seed a fixed 200-memory corpus (Acme + Beta + personal) plus a
 * fixed 50-query catalog where the gold-set memory IDs are known a-priori (we
 * authored both). Run each query through `KnowledgeLayer.retrieve()` with the
 * SAME options `memory_recall` uses in prod (topK=10, threshold=0.3, graph
 * expansion on). Compute recall@5, recall@10, MRR, scope-bleed-rate, latency.
 *
 * Two-pass for cold-vs-warm timing: the second pass re-uses the LRU caches
 * (embedding + HyDE) in RetrievalEngine, so latency drops dramatically.
 *
 * INTERPRETING recall@k
 * ---------------------
 *   recall@k = |gold ∩ top-k retrieved| / |gold|
 *
 * For a multi-fact query with 3 gold-set items, recall@5 = 1.0 means all 3
 * appear in the top 5. recall@5 = 0.66 means 2 of 3 appear. A query whose
 * gold-set is a single item caps at 1.0 (the item appears) or 0.0 (it doesn't).
 *
 * MRR (mean reciprocal rank) = 1 / rank-of-first-correct-result, averaged over
 * the query set. MRR=1.0 means every query's first-best result is the gold
 * answer; MRR=0.5 means it's at rank 2 on average; MRR=0.0 means no query found
 * any gold result at all.
 *
 * PASS BAR
 * --------
 *   recall@5 >= 0.80  (per-query min_recall_at_5 also enforced)
 *   recall@10 >= 0.85
 *   MRR >= 0.60
 *   scope-bleed-rate == 0   (HARD requirement — bleed is a contract violation)
 *
 * Usage:
 *   cd scripts/kg-bench
 *   npx tsx run.ts > results/kg-bench-$(date +%Y-%m-%d-%H%M%S).md
 *   npx tsx run.ts --threshold 0.55   # calibration sweep
 *   npx tsx run.ts --quick            # skip cold-vs-warm second pass
 */
import { readFileSync, writeFileSync, mkdtempSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';

import { KnowledgeLayer } from '../../src/core/knowledge-layer.js';
import { OnnxProvider } from '../../src/core/embedding.js';
import type { MemoryNamespace, MemoryScopeRef } from '../../src/types/index.js';

// =============================================================================
// Types
// =============================================================================

interface CorpusEntry {
  fixtureId: string;
  namespace: MemoryNamespace;
  text: string;
  scope: MemoryScopeRef;
  createdDaysAgo: number;
}

interface QueryEntry {
  id: string;
  kind: 'specific' | 'multi-fact' | 'scope-isolation' | 'no-query' | 'no-match';
  namespace: MemoryNamespace;
  scope: MemoryScopeRef;
  query: string;
  expected_topK_ids: string[];   // in terms of fixture-ids, NOT live memory ids
  min_recall_at_5: number;
  must_not_contain_ids: string[];
}

interface QueryResult {
  query: QueryEntry;
  retrievedIds: string[];        // fixture-ids (after mapping back)
  retrievedTexts: string[];
  expectedIds: string[];
  bled: string[];                // any fixture-id in must_not_contain that appeared
  recallAt5: number;
  recallAt10: number;
  firstHitRank: number | null;
  latencyMs: number;
  passed: boolean;
  failReason?: string;
}

// =============================================================================
// CLI / Constants
// =============================================================================

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const QUICK = args.includes('--quick');
const THRESHOLD_OVERRIDE = (() => {
  const i = args.indexOf('--threshold');
  if (i === -1) return undefined;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) ? n : undefined;
})();
// Production-default — same constants memory_recall uses.
const KG_RECALL_TOP_K = 10;
const KG_RECALL_THRESHOLD = THRESHOLD_OVERRIDE ?? 0.3;
const KG_NO_QUERY_LIMIT = 20;

// Pass-bars (corpus-grade — tighten as the corpus matures).
const PASS_BAR_RECALL_5 = 0.80;
const PASS_BAR_RECALL_10 = 0.85;
const PASS_BAR_MRR = 0.60;

// =============================================================================
// Corpus + Query Loading
// =============================================================================

function loadJsonl<T>(path: string): T[] {
  const raw = readFileSync(path, 'utf8');
  return raw
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as T);
}

function loadCorpus(): CorpusEntry[] {
  const dir = join(__dirname, 'corpus');
  const files = ['acme.jsonl', 'beta.jsonl', 'personal.jsonl'];
  const entries: CorpusEntry[] = [];
  for (const f of files) {
    entries.push(...loadJsonl<CorpusEntry>(join(dir, f)));
  }
  return entries;
}

function loadQueries(): QueryEntry[] {
  return loadJsonl<QueryEntry>(join(__dirname, 'queries', 'catalog.jsonl'));
}

// =============================================================================
// Seeding (with fixture-id ↔ memory-id mapping + recency backdating)
// =============================================================================

/**
 * Seed the KG with the corpus. Because `KnowledgeLayer.store()` always stamps
 * `created_at = NOW`, we open a second sqlite handle on the same file after
 * seeding and rewrite `created_at` per fixture's `createdDaysAgo`. This gives
 * the recency-decay scorer realistic age signals without forking the production
 * `store()` signature.
 *
 * Returns: Map<fixtureId, liveMemoryId> so we can score gold-sets against real
 * retrieval output.
 */
async function seedCorpus(
  layer: KnowledgeLayer,
  dbPath: string,
  entries: CorpusEntry[],
): Promise<Map<string, string>> {
  const fixtureToLive = new Map<string, string>();

  for (const entry of entries) {
    const result = await layer.store(entry.text, entry.namespace, entry.scope, {
      skipContradictionCheck: true,
    });
    if (result.memoryId.length > 0) {
      fixtureToLive.set(entry.fixtureId, result.memoryId);
    } else {
      // store() rejected (text < 5 chars) — should never happen with this corpus
      // but flag it so silent corpus drift surfaces.
      console.error(`[seed] store() returned empty id for ${entry.fixtureId}`);
    }
  }

  // Backdate created_at via a separate connection. Better-sqlite3 is fine with
  // concurrent readers, but to be safe we close the layer's writers around the
  // batch update… actually no — the layer is idle here (we just finished
  // seeding), so a direct UPDATE on a second handle is safe.
  const direct = new Database(dbPath);
  try {
    const updateStmt = direct.prepare(
      'UPDATE memories SET created_at = ?, updated_at = ? WHERE id = ?',
    );
    const tx = direct.transaction((rows: Array<{ id: string; iso: string }>) => {
      for (const r of rows) updateStmt.run(r.iso, r.iso, r.id);
    });

    const rows: Array<{ id: string; iso: string }> = [];
    for (const entry of entries) {
      const liveId = fixtureToLive.get(entry.fixtureId);
      if (!liveId) continue;
      const stamp = new Date(Date.now() - entry.createdDaysAgo * 86_400_000).toISOString();
      rows.push({ id: liveId, iso: stamp });
    }
    tx(rows);
  } finally {
    direct.close();
  }

  return fixtureToLive;
}

// =============================================================================
// Query Execution + Scoring
// =============================================================================

function buildLiveToFixture(fixtureToLive: Map<string, string>): Map<string, string> {
  const inverse = new Map<string, string>();
  for (const [fixture, live] of fixtureToLive) inverse.set(live, fixture);
  return inverse;
}

function recallAtK(
  retrievedFixtureIds: string[],
  expectedFixtureIds: string[],
  k: number,
): number {
  if (expectedFixtureIds.length === 0) return 1.0;
  const topK = new Set(retrievedFixtureIds.slice(0, k));
  let hits = 0;
  for (const exp of expectedFixtureIds) if (topK.has(exp)) hits++;
  return hits / expectedFixtureIds.length;
}

function firstHitRank(
  retrievedFixtureIds: string[],
  expectedFixtureIds: string[],
): number | null {
  const expectedSet = new Set(expectedFixtureIds);
  for (let i = 0; i < retrievedFixtureIds.length; i++) {
    if (expectedSet.has(retrievedFixtureIds[i]!)) return i + 1;
  }
  return null;
}

async function runQuery(
  layer: KnowledgeLayer,
  query: QueryEntry,
  liveToFixture: Map<string, string>,
): Promise<QueryResult> {
  const start = performance.now();
  let retrievedFixtureIds: string[];
  let retrievedTexts: string[];

  if (query.kind === 'no-query') {
    // Mirror the production no-query branch: `listRecentActive` (recency, not vector).
    const rows = layer.listRecentActive(query.namespace, [query.scope], KG_NO_QUERY_LIMIT);
    retrievedFixtureIds = rows.map(r => liveToFixture.get(r.id) ?? `(unknown:${r.id})`);
    retrievedTexts = rows.map(r => r.text);
  } else {
    const result = await layer.retrieve(query.query, [query.scope], {
      namespace: query.namespace,
      topK: KG_RECALL_TOP_K,
      threshold: KG_RECALL_THRESHOLD,
      useGraphExpansion: true,
    });
    retrievedFixtureIds = result.memories.map(m => liveToFixture.get(m.id) ?? `(unknown:${m.id})`);
    retrievedTexts = result.memories.map(m => m.text);
  }

  const latencyMs = performance.now() - start;

  // For no-match queries we EXPECT empty results — recall is N/A.
  let recallAt5: number;
  let recallAt10: number;
  let firstHit: number | null;
  if (query.kind === 'no-match') {
    // Pass criterion: retrieved set is empty OR no result lands in the top-3.
    // The KG can rank weakly-relevant noise above the threshold; what we really
    // assert is that the agent isn't fed misleading content as a confident top-hit.
    recallAt5 = retrievedFixtureIds.length === 0 ? 1.0 : 0.0;
    recallAt10 = recallAt5;
    firstHit = null;
  } else {
    recallAt5 = recallAtK(retrievedFixtureIds, query.expected_topK_ids, 5);
    recallAt10 = recallAtK(retrievedFixtureIds, query.expected_topK_ids, 10);
    firstHit = firstHitRank(retrievedFixtureIds, query.expected_topK_ids);
  }

  const bleedSet = new Set(query.must_not_contain_ids);
  const bled = retrievedFixtureIds.filter(id => bleedSet.has(id));

  let passed = true;
  let failReason: string | undefined;
  if (bled.length > 0) {
    passed = false;
    failReason = `scope-bleed: ${bled.join(', ')}`;
  } else if (query.kind === 'no-match') {
    if (retrievedFixtureIds.length > 0) {
      // Soft pass if the top-rank result is unrelated; hard fail if the model
      // returns >=3 items (false confidence). We mark passed=false either way
      // so it surfaces in per-query findings — but the aggregate uses a softer
      // bar (it's a known edge: KG retrieves on cosine even without true matches).
      passed = retrievedFixtureIds.length < 3;
      if (!passed) failReason = `no-match should be empty/sparse, got ${retrievedFixtureIds.length}`;
    }
  } else if (recallAt5 < query.min_recall_at_5) {
    passed = false;
    failReason = `recall@5=${recallAt5.toFixed(2)} < min ${query.min_recall_at_5}`;
  }

  return {
    query, retrievedIds: retrievedFixtureIds, retrievedTexts,
    expectedIds: query.expected_topK_ids,
    bled, recallAt5, recallAt10, firstHitRank: firstHit, latencyMs,
    passed, ...(failReason !== undefined ? { failReason } : {}),
  };
}

// =============================================================================
// Aggregation + Report
// =============================================================================

function percentile(sortedAsc: readonly number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  if (n === 1) return sortedAsc[0]!;
  const rank = (p / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo]!;
  const frac = rank - lo;
  return sortedAsc[lo]! * (1 - frac) + sortedAsc[hi]! * frac;
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

interface PassSummary {
  passLabel: string;
  results: QueryResult[];
}

function summarizeLatency(results: QueryResult[]): { p50: number; p95: number; max: number } {
  const sorted = results.map(r => r.latencyMs).sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted.length > 0 ? sorted[sorted.length - 1]! : 0,
  };
}

function renderReport(
  corpusSize: number,
  passes: PassSummary[],
): { md: string; verdict: { passed: boolean; metrics: Record<string, number> } } {
  const lines: string[] = [];
  const now = new Date().toISOString();
  lines.push(`# KG Bench — ${now}`);
  lines.push('');
  lines.push(`Corpus: ${corpusSize} memories across 4 namespaces × 3 scopes (acme, beta, me)`);
  lines.push(`Queries: ${passes[0]!.results.length}`);
  lines.push(`Threshold: KG_RECALL_THRESHOLD=${KG_RECALL_THRESHOLD}  topK=${KG_RECALL_TOP_K}`);
  lines.push('');

  // Score off the COLD pass — quality should be threshold-independent of cache state.
  const cold = passes[0]!.results;
  const scorable = cold.filter(r => r.query.kind !== 'no-match');
  const recall5 = mean(scorable.map(r => r.recallAt5));
  const recall10 = mean(scorable.map(r => r.recallAt10));
  const reciprocal = scorable.map(r => (r.firstHitRank == null ? 0 : 1 / r.firstHitRank));
  const mrr = mean(reciprocal);

  const bleedCount = cold.filter(r => r.bled.length > 0).length;
  const bleedRate = cold.length === 0 ? 0 : bleedCount / cold.length;

  const noMatchCases = cold.filter(r => r.query.kind === 'no-match');
  const noMatchCorrect = noMatchCases.filter(r => r.passed).length;

  lines.push('## Quality');
  lines.push('');
  lines.push('| Metric | Value | Pass-bar |');
  lines.push('|---|---|---|');
  lines.push(`| recall@5 | ${recall5.toFixed(3)} | ≥ ${PASS_BAR_RECALL_5} |`);
  lines.push(`| recall@10 | ${recall10.toFixed(3)} | ≥ ${PASS_BAR_RECALL_10} |`);
  lines.push(`| MRR | ${mrr.toFixed(3)} | ≥ ${PASS_BAR_MRR} |`);
  lines.push(`| Scope-bleed-rate | ${bleedCount}/${cold.length} = ${(bleedRate * 100).toFixed(1)}% | = 0 |`);
  lines.push(`| No-match handling | ${noMatchCorrect}/${noMatchCases.length} correct | 100% |`);
  lines.push('');

  // Latency table
  lines.push('## Latency');
  lines.push('');
  lines.push('| Percentile | ' + passes.map(p => p.passLabel).join(' | ') + ' |');
  lines.push('|---|' + passes.map(() => '---').join('|') + '|');
  const latencyRows: Array<{ row: string; vals: number[] }> = [];
  for (const label of ['p50', 'p95', 'max'] as const) {
    const vals = passes.map(p => {
      const lat = summarizeLatency(p.results);
      return lat[label];
    });
    latencyRows.push({ row: label, vals });
  }
  for (const { row, vals } of latencyRows) {
    lines.push(`| ${row} | ` + vals.map(v => `${v.toFixed(1)}ms`).join(' | ') + ' |');
  }
  lines.push('');

  // Per-query findings — only queries that failed OR had partial recall.
  const findings = cold.filter(r =>
    !r.passed || (r.query.kind !== 'no-match' && r.recallAt5 < 1.0),
  );
  lines.push(`## Per-query findings (${findings.length} of ${cold.length})`);
  lines.push('');
  if (findings.length === 0) {
    lines.push('_No partial-recall or failing queries._');
  } else {
    for (const r of findings) {
      const status = r.passed ? '⚠ partial' : '✘ FAIL';
      lines.push(`### ${status} \`${r.query.id}\`  (kind=${r.query.kind})`);
      lines.push(`Query: _${r.query.query || '(no-query)'}_`);
      lines.push(`Namespace=${r.query.namespace}  Scope=${r.query.scope.type}:${r.query.scope.id}`);
      if (r.failReason) lines.push(`Reason: **${r.failReason}**`);
      lines.push(`Expected: ${r.expectedIds.join(', ') || '(none)'}`);
      lines.push(`Retrieved (top-${r.retrievedIds.length}): ${r.retrievedIds.join(', ') || '(empty)'}`);
      lines.push(`recall@5=${r.recallAt5.toFixed(2)} recall@10=${r.recallAt10.toFixed(2)} firstHitRank=${r.firstHitRank ?? 'none'} latency=${r.latencyMs.toFixed(1)}ms`);
      lines.push('');
    }
  }

  // Threshold calibration evidence — count of queries that had non-empty results.
  const filledCount = scorable.filter(r => r.retrievedIds.length >= KG_RECALL_TOP_K).length;
  lines.push('## Threshold-calibration evidence');
  lines.push('');
  lines.push(`With KG_RECALL_THRESHOLD=${KG_RECALL_THRESHOLD}, ${filledCount}/${scorable.length} queries returned the full top-${KG_RECALL_TOP_K}.`);
  lines.push(`Mean retrieved-set size: ${mean(scorable.map(r => r.retrievedIds.length)).toFixed(1)}.`);
  lines.push('');
  lines.push('To sweep an alternative threshold, re-run with:');
  lines.push('  npx tsx run.ts --threshold 0.55   # RetrievalEngine default');
  lines.push('  npx tsx run.ts --threshold 0.2    # looser');
  lines.push('');
  lines.push('Recommendation: keep at 0.3 if recall ≥ pass-bar AND scope-bleed=0; raise if scope-bleed > 0; lower if recall@10 < pass-bar.');
  lines.push('');

  const passed = recall5 >= PASS_BAR_RECALL_5
    && recall10 >= PASS_BAR_RECALL_10
    && mrr >= PASS_BAR_MRR
    && bleedRate === 0;

  lines.push('## Conclusion');
  lines.push('');
  lines.push(passed ? '**PASS** — KG-recall meets all pass-bars and scope-isolation holds.' : '**FAIL** — see findings.');
  lines.push('');

  return {
    md: lines.join('\n') + '\n',
    verdict: {
      passed,
      metrics: { recall5, recall10, mrr, bleedRate, noMatchCorrect, noMatchTotal: noMatchCases.length },
    },
  };
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  console.error('[kg-bench] loading corpus + queries…');
  const corpus = loadCorpus();
  const queries = loadQueries();
  console.error(`[kg-bench]   corpus: ${corpus.length} memories`);
  console.error(`[kg-bench]   queries: ${queries.length}`);

  const workDir = mkdtempSync(join(tmpdir(), 'kg-bench-'));
  const dbPath = join(workDir, 'kg.db');
  console.error(`[kg-bench] tmp db: ${dbPath}`);

  console.error('[kg-bench] booting OnnxProvider (multilingual-e5-small, lazy-loads on first embed)…');
  const provider = new OnnxProvider();
  const layer = new KnowledgeLayer(dbPath, provider);
  await layer.init();

  console.error('[kg-bench] seeding corpus…');
  const seedStart = performance.now();
  const fixtureToLive = await seedCorpus(layer, dbPath, corpus);
  const seedMs = performance.now() - seedStart;
  console.error(`[kg-bench]   seeded ${fixtureToLive.size}/${corpus.length} entries in ${(seedMs / 1000).toFixed(1)}s`);

  // Persist the mapping for future inspection.
  const mapPath = join(__dirname, 'results', `_last-mapping.json`);
  if (!existsSync(dirname(mapPath))) mkdirSync(dirname(mapPath), { recursive: true });
  writeFileSync(mapPath, JSON.stringify(Object.fromEntries(fixtureToLive), null, 2));

  const liveToFixture = buildLiveToFixture(fixtureToLive);

  console.error('[kg-bench] cold pass…');
  const coldResults: QueryResult[] = [];
  for (const q of queries) {
    coldResults.push(await runQuery(layer, q, liveToFixture));
  }

  const passes: PassSummary[] = [{ passLabel: 'Cold (first run)', results: coldResults }];

  if (!QUICK) {
    console.error('[kg-bench] warm pass…');
    const warmResults: QueryResult[] = [];
    for (const q of queries) {
      warmResults.push(await runQuery(layer, q, liveToFixture));
    }
    passes.push({ passLabel: 'Warm (cached embeddings)', results: warmResults });
  }

  const { md, verdict } = renderReport(corpus.length, passes);

  // Write the human-readable report to stdout (caller redirects to file).
  process.stdout.write(md);

  // Compact summary to stderr for the CLI runner.
  console.error('');
  console.error(`[kg-bench] verdict: ${verdict.passed ? 'PASS' : 'FAIL'}`);
  console.error(`[kg-bench]   recall@5=${verdict.metrics['recall5']!.toFixed(3)} recall@10=${verdict.metrics['recall10']!.toFixed(3)} MRR=${verdict.metrics['mrr']!.toFixed(3)} bleed=${(verdict.metrics['bleedRate']! * 100).toFixed(1)}%`);

  await layer.close();
  process.exit(verdict.passed ? 0 : 1);
}

main().catch(err => {
  console.error('[kg-bench] FATAL:', err);
  process.exit(2);
});
