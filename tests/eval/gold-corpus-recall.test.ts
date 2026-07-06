import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeLayer } from '../../src/core/knowledge-layer.js';
import { createEmbeddingProvider } from '../../src/core/embedding.js';
import { EngineDb } from '../../src/core/engine-db.js';
import { RunHistory } from '../../src/core/run-history.js';
import { ThreadStore } from '../../src/core/thread-store.js';
import { SubjectStore } from '../../src/core/subject-store.js';
import type { MemoryScopeRef } from '../../src/types/index.js';

/**
 * M5 — gold-corpus recall-quality harness.
 *
 * A labeled corpus + query set that measures the engine.db recall path with the
 * REAL ONNX embedder: precision@5, recall@10, MRR, and the graph-expansion
 * ablation (off vs on). It exists to (a) guard recall quality against regressions
 * and (b) be the instrument for tuning the ranking levers (VECTOR_WEIGHT /
 * GRAPH_BOOST / THREAD_BOOST / threshold / MMR_LAMBDA / expand caps / HyDE).
 *
 * The corpus is generated programmatically so the labels are correct BY
 * CONSTRUCTION: every project carries the SAME attribute vocabulary ("budget",
 * "deadline", …) in DE + EN, so a query for one project's attribute must retrieve
 * THAT project's fact and NOT a sibling project's same-attribute fact — the
 * cross-project interference test at the heart of the shared-scope isolation.
 *
 * Gated: real ONNX downloads ~118 MB (Xenova/multilingual-e5-small) on first use,
 * so it self-skips unless LYNOX_EVAL=1 — the same gate the other eval harnesses use
 * (run on demand + in the release gate).
 */
const RUN = process.env['LYNOX_EVAL'] === '1';

// ── Corpus definition ────────────────────────────────────────────────
// 3 clients × 2 projects; each project carries the same 5 attributes, phrased in
// DE and EN with a surface variant — overlapping vocabulary is the whole point.
const CLIENTS = [
  { org: 'Meridian AG', projects: ['Orion', 'Vega'] },
  { org: 'Nordwind GmbH', projects: ['Perseus', 'Andromeda'] },
  { org: 'Solaris Ltd', projects: ['Titan', 'Rhea'] },
];

interface Attr { key: string; phrasings: (p: string) => string[]; query: (p: string) => string }
const ATTRS: Attr[] = [
  {
    key: 'budget',
    phrasings: p => [`Projekt "${p}": das Budget beträgt CHF 30000.`, `Project "${p}" has an annual budget of CHF 30000.`],
    query: p => `Projekt "${p}" Budget`,
  },
  {
    key: 'deadline',
    phrasings: p => [`Projekt "${p}": die Deadline ist der 15. September.`, `Project "${p}" deadline is September 15th.`],
    query: p => `Projekt "${p}" Deadline Termin`,
  },
  {
    key: 'tech',
    phrasings: p => [`Projekt "${p}" nutzt PostgreSQL für die Datenbank.`, `Project "${p}" runs on a PostgreSQL database.`],
    query: p => `Projekt "${p}" Technologie Datenbank`,
  },
  {
    key: 'lead',
    phrasings: p => [`Projekt "${p}": Projektleiterin ist Frau Keller.`, `Project "${p}" is led by Ms Keller.`],
    query: p => `Projekt "${p}" Projektleitung`,
  },
  {
    key: 'status',
    phrasings: p => [`Projekt "${p}" ist derzeit in der Umsetzungsphase.`, `Project "${p}" is currently in the implementation phase.`],
    query: p => `Projekt "${p}" Status Phase`,
  },
];

interface Doc { id: string; project: string; attr: string }
interface Query { text: string; project: string; attr: string }

const scope: MemoryScopeRef = { type: 'context', id: 'http-api' };

interface Metrics { precisionAt5: number; recallAt10: number; mrr: number }

function evaluate(
  queries: Query[],
  docs: Doc[],
  ranking: (q: string) => string[],   // → retrieved memory ids, ranked
): Metrics {
  let sumP5 = 0, sumR10 = 0, sumMrr = 0;
  for (const q of queries) {
    const relevant = new Set(docs.filter(d => d.project === q.project && d.attr === q.attr).map(d => d.id));
    const ranked = ranking(q.text);
    const top5 = ranked.slice(0, 5);
    const top10 = ranked.slice(0, 10);
    sumP5 += top5.filter(id => relevant.has(id)).length / 5;
    sumR10 += relevant.size ? top10.filter(id => relevant.has(id)).length / relevant.size : 0;
    const firstRel = ranked.findIndex(id => relevant.has(id));
    sumMrr += firstRel >= 0 ? 1 / (firstRel + 1) : 0;
  }
  const n = queries.length;
  return { precisionAt5: sumP5 / n, recallAt10: sumR10 / n, mrr: sumMrr / n };
}

describe.skipIf(!RUN)('gold-corpus recall quality (real ONNX)', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterAll(async () => { for (const c of [...cleanups].reverse()) await c(); });

  it('meets recall floors and graph-expand does not lower recall', async () => {
    // Register each teardown as its resource is constructed (LIFO in afterAll), so a
    // throw during init() never leaks the temp dir or open DB handles.
    const dir = mkdtempSync(join(tmpdir(), 'lynox-gold-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const engine = new EngineDb(join(dir, 'engine.db'), 'vault-gold');
    cleanups.push(() => { try { engine.close(); } catch { /* already closed */ } });
    const runHistory = new RunHistory(join(dir, 'history.db'));
    cleanups.push(() => { try { runHistory.close(); } catch { /* already closed */ } });
    const layer = new KnowledgeLayer(
      join(dir, 'mem.db'), createEmbeddingProvider('onnx'), undefined, runHistory,
      engine, /*subjectGraph*/ true, /*reads*/ true,
    );
    cleanups.push(() => layer.close().catch(() => {}));
    await layer.init();
    const threads = new ThreadStore(runHistory.getDb());
    const subs = new SubjectStore(engine);

    // ── Seed the corpus, anchoring each memory to its project subject ──
    const docs: Doc[] = [];
    const queries: Query[] = [];
    let tid = 0;
    for (const { org, projects } of CLIENTS) {
      const orgId = subs.findOrCreate({ kind: 'organization', name: org }).id;
      for (const project of projects) {
        const projectId = subs.findOrCreateEngagement(project, orgId).id;
        const threadId = `t-${tid++}`;
        threads.createThread(threadId);
        threads.updateThread(threadId, { primary_subject_id: projectId });
        for (const attr of ATTRS) {
          for (const text of attr.phrasings(project)) {
            const res = await layer.store(text, 'knowledge', scope, { sourceThreadId: threadId });
            docs.push({ id: res.memoryId, project, attr: attr.key });
          }
          queries.push({ text: attr.query(project), project, attr: attr.key });
        }
      }
    }

    const retrieve = async (q: string, useGraphExpansion: boolean): Promise<string[]> => {
      const r = await layer.retrieve(q, [scope], { topK: 10, threshold: 0.3, useHyDE: false, useGraphExpansion });
      return r.memories.map(m => m.id);
    };
    // Pre-compute rankings (async) so the sync evaluate() can score them.
    const withExpand = new Map<string, string[]>();
    const noExpand = new Map<string, string[]>();
    for (const q of queries) {
      withExpand.set(q.text, await retrieve(q.text, true));
      noExpand.set(q.text, await retrieve(q.text, false));
    }

    const on = evaluate(queries, docs, q => withExpand.get(q) ?? []);
    const off = evaluate(queries, docs, q => noExpand.get(q) ?? []);

    // Human-readable report (visible with `--reporter=verbose` or on failure).
    const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
    process.stdout.write(
      `\n[gold-corpus] ${docs.length} memories, ${queries.length} queries (real ONNX)\n` +
      `  graph-expand ON : P@5=${pct(on.precisionAt5)} R@10=${pct(on.recallAt10)} MRR=${on.mrr.toFixed(3)}\n` +
      `  graph-expand OFF: P@5=${pct(off.precisionAt5)} R@10=${pct(off.recallAt10)} MRR=${off.mrr.toFixed(3)}\n` +
      `  graph-expand lift: P@5 ${pct(on.precisionAt5 - off.precisionAt5)}, MRR ${(on.mrr - off.mrr).toFixed(3)}\n`,
    );

    // Regression FLOORS (calibrated from the local baseline: R@10=1.00, P@5=0.20,
    // MRR=0.61 on the graph-expand path). Set below observed so benign embedder/model
    // drift doesn't false-fail; a real recall regression trips them. (P@5 is capped at
    // 0.40 by design — 2 relevant docs per query.) Tighten as levers are tuned.
    expect(on.recallAt10).toBeGreaterThanOrEqual(0.90);
    expect(on.precisionAt5).toBeGreaterThanOrEqual(0.15);
    expect(on.mrr).toBeGreaterThanOrEqual(0.50);

    // The proven "better, not just equal": graph-expansion strictly ADDS
    // subject-linked candidates, so it must never LOWER recall (it lifts it
    // 88%→100% at baseline — it surfaces relevant facts pure vector recall misses).
    expect(on.recallAt10).toBeGreaterThanOrEqual(off.recallAt10 - 1e-9);

    // FINDING surfaced by this harness (a tuning lever, NOT a pass/fail here): on
    // attribute-specific queries graph-expand LOWERS MRR (0.79→0.61) because
    // resolving the project pulls the WHOLE project's memories (all attributes),
    // diluting the top attribute hit. Levers: GRAPH_BOOST down-weight vs vector,
    // attribute-aware expansion, or MMR_LAMBDA. Tracked for post-A1 tuning.
    if (on.mrr < off.mrr - 1e-9) {
      process.stdout.write(`[gold-corpus] NOTE: graph-expand lowers MRR by ${(off.mrr - on.mrr).toFixed(3)} (ranking-dilution lever — see comment)\n`);
    }
  }, 180_000);
});
