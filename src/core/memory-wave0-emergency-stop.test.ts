import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { RetrievalEngine } from './retrieval-engine.js';
import { KnowledgeLayer } from './knowledge-layer.js';
import { AgentMemoryDb } from './agent-memory-db.js';
import { LocalProvider } from './embedding.js';
import { EntityResolver } from './entity-resolver.js';
import { appendRetrievalShadowLog, RETRIEVAL_SHADOW_LOG_FILE } from './retrieval-shadow-log.js';
import type { MemoryScopeRef } from '../types/index.js';

/**
 * Memory Foundation Wave 0 — the self-reinforcement emergency stop.
 *
 * Symmetric coverage (PRD §5.3): the legacy-path assertions live in the existing
 * suites (which run with the flag OFF by default); these pin the NEW behaviour when
 * `memory_scoring_v2` is ON, and re-assert the legacy branch side-by-side so the
 * dual-scorer contract is proven in one place. All Wave-0 changes are flag-gated
 * (0.1–0.5); 0.6 (tool force-floor) is unconditional and covered in memory.test.ts.
 */

const NS = 'knowledge' as const;

describe('Wave 0 — 0.2/0.3 read path: confMult dropped, confidence not rendered', () => {
  let tempDir: string;
  let db: AgentMemoryDb;
  let embedding: LocalProvider;
  let legacyEngine: RetrievalEngine;
  let v2Engine: RetrievalEngine;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-wave0-read-'));
    embedding = new LocalProvider();
    db = new AgentMemoryDb(join(tempDir, 're.db'));
    db.setEmbeddingDimensions(embedding.dimensions);
    const entityResolver = new EntityResolver(db, embedding);
    legacyEngine = new RetrievalEngine(db, embedding, entityResolver, undefined, undefined, false);
    v2Engine = new RetrievalEngine(db, embedding, entityResolver, undefined, undefined, true);
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('0.2: a heavily-confirmed row scores IDENTICALLY to an unconfirmed twin when the flag is ON', async () => {
    const text = 'The invoicing service runs the nightly reconciliation batch.';
    const scope: MemoryScopeRef = { type: 'context', id: 'score-iso' };
    const emb = await embedding.embed(text);
    const fresh = db.createMemory({ text, namespace: NS, scopeType: scope.type, scopeId: scope.id, embedding: emb });
    const confirmed = db.createMemory({ text, namespace: NS, scopeType: scope.type, scopeId: scope.id, embedding: emb });
    for (let i = 0; i < 20; i++) db.confirmMemory(confirmed); // cc=20, confidence pinned 1.0

    const opts = { topK: 10, threshold: 0.1, useHyDE: false, useGraphExpansion: false };

    const v2 = await v2Engine.retrieve(text, [scope], opts);
    const vFresh = v2.memories.find(m => m.id === fresh)!;
    const vConfirmed = v2.memories.find(m => m.id === confirmed)!;
    expect(vFresh).toBeDefined();
    expect(vConfirmed).toBeDefined();
    // No confMult: the retrieval-tally no longer moves the score at all.
    expect(vConfirmed.finalScore).toBeCloseTo(vFresh.finalScore, 10);

    const legacy = await legacyEngine.retrieve(text, [scope], opts);
    const lFresh = legacy.memories.find(m => m.id === fresh)!;
    const lConfirmed = legacy.memories.find(m => m.id === confirmed)!;
    // Legacy branch retained: the confirmed twin still scores strictly higher.
    expect(lConfirmed.finalScore).toBeGreaterThan(lFresh.finalScore);
  });

  it('0.2: an OLD never-retrieved row is no longer penalized by the sticky confirmDecay when ON', async () => {
    const text = 'The legacy archive export runs quarterly for compliance.';
    const scope: MemoryScopeRef = { type: 'context', id: 'age-iso' };
    const emb = await embedding.embed(text);
    const id = db.createMemory({ text, namespace: NS, scopeType: scope.type, scopeId: scope.id, embedding: emb });
    // Backdate creation ~200 days: legacy confirmDecay = max(0.5, 1 - 200/365) ≈ 0.452.
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    const raw = (db as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db;
    raw.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(old, id);

    const opts = { topK: 10, threshold: 0.1, useHyDE: false, useGraphExpansion: false };
    const v2 = await v2Engine.retrieve(text, [scope], opts);
    const legacy = await legacyEngine.retrieve(text, [scope], opts);
    const v2Score = v2.memories.find(m => m.id === id)!.finalScore;
    const legacyScore = legacy.memories.find(m => m.id === id)!.finalScore;
    // Wave 0 removes the confMult penalty (≤1.0), so the score rises — the
    // admission-widening the PRD calls out (§4, bound 2).
    expect(v2Score).toBeGreaterThan(legacyScore);
  });

  it('0.3: formatContext renders NO confidence= attribute when the flag is ON (still does when OFF)', async () => {
    const text = 'The support inbox is triaged every weekday morning.';
    const scope: MemoryScopeRef = { type: 'context', id: 'render-iso' };
    const emb = await embedding.embed(text);
    const id = db.createMemory({ text, namespace: NS, scopeType: scope.type, scopeId: scope.id, embedding: emb });
    for (let i = 0; i < 6; i++) db.confirmMemory(id); // confidence → 1.0

    const opts = { topK: 10, threshold: 0.1, useHyDE: false, useGraphExpansion: false };

    const v2Result = await v2Engine.retrieve(text, [scope], opts);
    const v2Out = v2Engine.formatContext(v2Result);
    expect(v2Out).toContain('<fact');
    expect(v2Out).not.toMatch(/confidence=/);

    const legacyResult = await legacyEngine.retrieve(text, [scope], opts);
    const legacyOut = legacyEngine.formatContext(legacyResult);
    expect(legacyOut).toMatch(/confidence="/);
  });
});

describe('Wave 0 — 0.1/0.4 write path: confirmation writes suppressed', () => {
  let tempDir: string;
  const scope: MemoryScopeRef = { type: 'context', id: 'write-iso' };

  const makeLayer = async (scoringV2: boolean): Promise<KnowledgeLayer> => {
    const layer = new KnowledgeLayer(
      join(tempDir, `${scoringV2 ? 'v2' : 'legacy'}.db`), new LocalProvider(),
      undefined, undefined, undefined, false, false, scoringV2,
    );
    await layer.init();
    return layer;
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-wave0-write-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('0.1: feedbackOnRetrieval("useful") does NOT confirm when ON, but DOES when OFF', async () => {
    const text = 'The onboarding checklist has fourteen required steps.';

    const v2 = await makeLayer(true);
    const rV2 = await v2.store(text, NS, scope);
    v2.feedbackOnRetrieval([rV2.memoryId], 'useful');
    expect(v2.getDb().getMemory(rV2.memoryId)!.confirmation_count).toBe(0);
    await v2.close();

    const legacy = await makeLayer(false);
    const rL = await legacy.store(text, NS, scope);
    legacy.feedbackOnRetrieval([rL.memoryId], 'useful');
    expect(legacy.getDb().getMemory(rL.memoryId)!.confirmation_count).toBe(1);
    await legacy.close();
  });

  it('0.1: the penalize side (a genuine correction) stays live even when ON', async () => {
    const v2 = await makeLayer(true);
    const r = await v2.store('The default timezone is set to Europe/Zurich.', NS, scope);
    const before = v2.getDb().getMemory(r.memoryId)!.confidence;
    v2.feedbackOnRetrieval([r.memoryId], 'wrong');
    const after = v2.getDb().getMemory(r.memoryId)!.confidence;
    expect(after).toBeLessThan(before); // penalize lowers — not suppressed
    await v2.close();
  });

  it('0.4: a dedup hit is a plain no-op (no confirm) when ON, but confirms when OFF', async () => {
    const text = 'PostgreSQL 16 is the required database engine for this project.';

    const v2 = await makeLayer(true);
    const first = await v2.store(text, NS, scope);
    const dupV2 = await v2.store(text, NS, scope);
    expect(dupV2.deduplicated).toBe(true);
    expect(dupV2.stored).toBe(false);
    expect(dupV2.memoryId).toBe(first.memoryId);
    expect(v2.getDb().getMemory(first.memoryId)!.confirmation_count).toBe(0);
    await v2.close();

    const legacy = await makeLayer(false);
    const firstL = await legacy.store(text, NS, scope);
    const dupL = await legacy.store(text, NS, scope);
    expect(dupL.deduplicated).toBe(true);
    expect(legacy.getDb().getMemory(firstL.memoryId)!.confirmation_count).toBe(1);
    await legacy.close();
  });
});

describe('Wave 0 — 0.5 consolidation: confirmation transfer suppressed', () => {
  let tempDir: string;
  let db: AgentMemoryDb;
  let embedding: LocalProvider;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-wave0-consol-'));
    embedding = new LocalProvider();
    db = new AgentMemoryDb(join(tempDir, 'consol.db'));
    db.setEmbeddingDimensions(embedding.dimensions);
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  const seedCluster = async (): Promise<{ keeper: string; victim: string }> => {
    const text = 'The weekly metrics digest is generated on Monday at 08:00.';
    const emb = await embedding.embed(text);
    const keeper = db.createMemory({ text, namespace: NS, scopeType: 'context', scopeId: 'c', embedding: emb });
    const victim = db.createMemory({ text, namespace: NS, scopeType: 'context', scopeId: 'c', embedding: emb });
    for (let i = 0; i < 5; i++) db.confirmMemory(keeper); // cc=5 → keeper (most confirmed)
    for (let i = 0; i < 3; i++) db.confirmMemory(victim); // cc=3
    return { keeper, victim };
  };

  it('transfers the victim confirmations to the keeper by default (legacy)', async () => {
    const { keeper } = await seedCluster();
    const pairs = db.consolidateMemories(NS, 'context', 'c', 0.85);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.victimConfirmations).toBe(3);
    expect(db.getMemory(keeper)!.confirmation_count).toBe(8); // 5 + 3
  });

  it('does NOT transfer confirmations when transferConfirmations is false (Wave 0), but still merges', async () => {
    const { keeper, victim } = await seedCluster();
    const pairs = db.consolidateMemories(NS, 'context', 'c', 0.85, undefined, /* transferConfirmations */ false);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.victimConfirmations).toBe(0); // zeroed → engine.db mirror is a no-op
    expect(db.getMemory(keeper)!.confirmation_count).toBe(5); // unchanged, NOT 8
    // The merge itself still happened: the victim is superseded (inactive).
    expect(db.getMemory(victim)!.is_active).toBe(0);
  });
});

describe('Wave 0 — §5.1 shadow mode: measured distribution, filters nothing', () => {
  let tempDir: string;
  let db: AgentMemoryDb;
  let embedding: LocalProvider;
  let prevDataDir: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-wave0-shadow-'));
    // Contain the JSONL sink inside the temp dir instead of the real ~/.lynox.
    prevDataDir = process.env['LYNOX_DATA_DIR'];
    process.env['LYNOX_DATA_DIR'] = tempDir;
    embedding = new LocalProvider();
    db = new AgentMemoryDb(join(tempDir, 'shadow.db'));
    db.setEmbeddingDimensions(embedding.dimensions);
  });

  afterEach(async () => {
    db.close();
    if (prevDataDir === undefined) delete process.env['LYNOX_DATA_DIR'];
    else process.env['LYNOX_DATA_DIR'] = prevDataDir;
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  const makeEngine = (shadowLog: boolean): RetrievalEngine =>
    new RetrievalEngine(db, embedding, new EntityResolver(db, embedding), undefined, undefined, false, shadowLog);

  it('publishes one retrievalGate record per retrieve when ON, with per-candidate cosine/tier/subject/wouldPass', async () => {
    const text = 'The billing cron retries a failed charge three times.';
    const scope: MemoryScopeRef = { type: 'context', id: 'shadow-on' };
    const emb = await embedding.embed(text);
    const id = db.createMemory({ text, namespace: NS, scopeType: scope.type, scopeId: scope.id, embedding: emb, sourceType: 'user_asserted' });

    const captured: unknown[] = [];
    const handler = (msg: unknown): void => { captured.push(msg); };
    subscribe('lynox:retrieval:gate', handler);
    try {
      await makeEngine(true).retrieve(text, [scope], {
        topK: 10, threshold: 0.1, useHyDE: false, useGraphExpansion: false, threadId: 'thread-xyz',
      });
    } finally {
      unsubscribe('lynox:retrieval:gate', handler);
    }

    expect(captured).toHaveLength(1);
    const entry = captured[0] as {
      threadId: string; queryHash: string; embeddingModel: string; embeddingProvider: string;
      candidates: Array<{ id: string; rawCosine: number; sourceType: string; subjectId: string | null; wouldPass: boolean }>;
    };
    expect(entry.threadId).toBe('thread-xyz');
    expect(entry.queryHash).toMatch(/^[0-9a-f]{16}$/); // hashed, never raw query text
    expect(entry.embeddingModel).toBe('local');
    expect(entry.embeddingProvider).toBe('local');
    const c = entry.candidates.find(x => x.id === id)!;
    expect(c).toBeDefined();
    expect(c.rawCosine).toBeGreaterThan(0.9); // exact-text self-match
    expect(c.sourceType).toBe('user_asserted'); // the row's real tier, verbatim
    expect(c.wouldPass).toBe(true); // a >0.9-cosine self-match clears threshold*0.3
  });

  it('emits nothing when the flag is OFF', async () => {
    const text = 'The nightly backup uploads to the encrypted bucket.';
    const scope: MemoryScopeRef = { type: 'context', id: 'shadow-off' };
    const emb = await embedding.embed(text);
    db.createMemory({ text, namespace: NS, scopeType: scope.type, scopeId: scope.id, embedding: emb });

    const captured: unknown[] = [];
    const handler = (msg: unknown): void => { captured.push(msg); };
    subscribe('lynox:retrieval:gate', handler);
    try {
      await makeEngine(false).retrieve(text, [scope], {
        topK: 10, threshold: 0.1, useHyDE: false, useGraphExpansion: false,
      });
    } finally {
      unsubscribe('lynox:retrieval:gate', handler);
    }
    expect(captured).toHaveLength(0);
  });

  it('the JSONL sink writes a parseable record to the data dir', async () => {
    await appendRetrievalShadowLog({
      ts: 1_700_000_000_000,
      threadId: 'thread-1',
      queryHash: 'deadbeefdeadbeef',
      embeddingModel: 'multilingual-e5-small',
      embeddingProvider: 'onnx',
      candidates: [{ id: 'm1', rawCosine: 0.73, sourceType: 'agent_inferred', subjectId: null, wouldPass: true }],
    });
    const raw = await readFile(join(tempDir, RETRIEVAL_SHADOW_LOG_FILE), 'utf8');
    const parsed = JSON.parse(raw.trim()) as { queryHash: string; candidates: Array<{ rawCosine: number }> };
    expect(parsed.queryHash).toBe('deadbeefdeadbeef');
    expect(parsed.candidates[0]!.rawCosine).toBeCloseTo(0.73, 5);
  });

  it('the sink swallows a write failure — a telemetry error never surfaces (fire-and-forget)', async () => {
    // Point the data dir at a FILE, so appendFile(join(file, sink)) fails ENOTDIR.
    const notADir = join(tempDir, 'not-a-dir');
    await writeFile(notADir, 'x');
    process.env['LYNOX_DATA_DIR'] = notADir;
    await expect(appendRetrievalShadowLog({
      ts: 1, threadId: undefined, queryHash: 'x', embeddingModel: 'm', embeddingProvider: 'p', candidates: [],
    })).resolves.toBeUndefined(); // never throws, never rejects
  });
});

describe('Wave 0 — KnowledgeLayer integration wiring (shipped path, not just the DB layer)', () => {
  let tempDir: string;
  let prevDataDir: string | undefined;
  const scope: MemoryScopeRef = { type: 'context', id: 'kl-wiring' };

  const layer = (scoringV2: boolean, shadowLog: boolean, tag: string): Promise<KnowledgeLayer> => {
    const l = new KnowledgeLayer(
      join(tempDir, `${tag}.db`), new LocalProvider(),
      undefined, undefined, undefined, false, false, scoringV2, shadowLog,
    );
    return l.init().then(() => l);
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lynox-wave0-kl-'));
    prevDataDir = process.env['LYNOX_DATA_DIR'];
    process.env['LYNOX_DATA_DIR'] = tempDir; // contain any shadow JSONL writes
  });

  afterEach(async () => {
    if (prevDataDir === undefined) delete process.env['LYNOX_DATA_DIR'];
    else process.env['LYNOX_DATA_DIR'] = prevDataDir;
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('0.5: KnowledgeLayer.consolidateMemories suppresses the transfer when ON (exercises the !memoryScoringV2 negation)', async () => {
    const text = 'The release train ships every second Thursday afternoon.';
    const emb = await new LocalProvider().embed(text); // deterministic — matches the layer provider

    const v2 = await layer(true, false, 'consol-v2');
    const kV = v2.getDb().createMemory({ text, namespace: NS, scopeType: 'context', scopeId: 'kl', embedding: emb });
    const vV = v2.getDb().createMemory({ text, namespace: NS, scopeType: 'context', scopeId: 'kl', embedding: emb });
    for (let i = 0; i < 5; i++) v2.getDb().confirmMemory(kV);
    for (let i = 0; i < 3; i++) v2.getDb().confirmMemory(vV);
    expect(v2.consolidateMemories(NS, 'context', 'kl')).toBe(1);
    expect(v2.getDb().getMemory(kV)!.confirmation_count).toBe(5); // NOT 8 — layer passed !scoringV2 = false
    await v2.close();

    const legacy = await layer(false, false, 'consol-legacy');
    const kL = legacy.getDb().createMemory({ text, namespace: NS, scopeType: 'context', scopeId: 'kl', embedding: emb });
    const vL = legacy.getDb().createMemory({ text, namespace: NS, scopeType: 'context', scopeId: 'kl', embedding: emb });
    for (let i = 0; i < 5; i++) legacy.getDb().confirmMemory(kL);
    for (let i = 0; i < 3; i++) legacy.getDb().confirmMemory(vL);
    expect(legacy.consolidateMemories(NS, 'context', 'kl')).toBe(1);
    expect(legacy.getDb().getMemory(kL)!.confirmation_count).toBe(8); // 5 + 3 transferred
    await legacy.close();
  });

  it('wires scoringV2 and retrievalShadowLog INDEPENDENTLY (guards the ctor arg order)', async () => {
    const opts = { topK: 5, threshold: 0.1, useHyDE: false, useGraphExpansion: false };
    const drain = async (l: KnowledgeLayer, q: string): Promise<number> => {
      const captured: unknown[] = [];
      const handler = (m: unknown): void => { captured.push(m); };
      subscribe('lynox:retrieval:gate', handler);
      try { await l.retrieve(q, [scope], opts); } finally { unsubscribe('lynox:retrieval:gate', handler); }
      return captured.length;
    };

    // scoringV2 ON, shadowLog OFF.
    const a = await layer(true, false, 'iso-a');
    const rA = await a.store('Widget X runs on the blue pipeline.', NS, scope);
    a.feedbackOnRetrieval([rA.memoryId], 'useful');
    expect(a.getDb().getMemory(rA.memoryId)!.confirmation_count).toBe(0); // scoringV2 ON → no confirm
    expect(await drain(a, 'Widget X runs on the blue pipeline.')).toBe(0); // shadowLog OFF → no emit
    await a.close();

    // The mirror image: scoringV2 OFF, shadowLog ON. A swapped ctor would flip both.
    const b = await layer(false, true, 'iso-b');
    const rB = await b.store('Widget Y runs on the green pipeline.', NS, scope);
    b.feedbackOnRetrieval([rB.memoryId], 'useful');
    expect(b.getDb().getMemory(rB.memoryId)!.confirmation_count).toBe(1); // scoringV2 OFF → confirm
    expect(await drain(b, 'Widget Y runs on the green pipeline.')).toBeGreaterThan(0); // shadowLog ON → emit
    await b.close();
  });
});
