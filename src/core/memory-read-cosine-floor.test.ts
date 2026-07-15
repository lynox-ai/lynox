import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RetrievalEngine, passesReadCosineFloor } from './retrieval-engine.js';
import { AgentMemoryDb } from './agent-memory-db.js';
import { LocalProvider } from './embedding.js';
import { EntityResolver } from './entity-resolver.js';
import type { MemoryScopeRef } from '../types/index.js';

/**
 * Memory Foundation Wave 2 (P2) — the read-side raw-cosine floor.
 *
 * The floor is applied ONLY to purely-vector-surfaced candidates (graph/FTS/run-surfaced
 * facts are exempt so a graph-reachable user_asserted truth is never dropped — refute
 * RF-ARCH1), gated on `memory_write_trust_gate`, and STRICTLY TIGHTENING (`A && B ⊆ A`).
 * The production constant is 0 (byte-identical) until the shadow window closes; these tests
 * exercise the LOGIC at multiple floor values via the exported pure helper, plus the
 * byte-identical integration guarantee at floor 0.
 */

const NS = 'knowledge' as const;
const VECTOR_WEIGHT = 0.55; // mirror of the engine constant (finalScore recovery basis)

describe('P2 — passesReadCosineFloor (the pure floor decision)', () => {
  const vec = (cosine: number): { vectorScore: number; graphBoost: number; ftsScore: number; runBoost: number } =>
    ({ vectorScore: cosine * VECTOR_WEIGHT, graphBoost: 0, ftsScore: 0, runBoost: 0 });

  it('floor 0 → EVERY candidate passes (byte-identical)', () => {
    expect(passesReadCosineFloor(vec(0.0), 0)).toBe(true);
    expect(passesReadCosineFloor(vec(0.3), 0)).toBe(true);
    expect(passesReadCosineFloor(vec(0.95), 0)).toBe(true);
  });

  it('floor 0.5: a purely-vector SUB-floor candidate is dropped; an above-floor one is kept', () => {
    expect(passesReadCosineFloor(vec(0.30), 0.5)).toBe(false); // 0.30 < 0.50 → dropped
    expect(passesReadCosineFloor(vec(0.50), 0.5)).toBe(true);  // exactly at floor → kept
    expect(passesReadCosineFloor(vec(0.90), 0.5)).toBe(true);
  });

  it('floor 0.5: graph / FTS / run / no-cosine candidates are EXEMPT even below the floor', () => {
    const low = 0.10 * VECTOR_WEIGHT;
    expect(passesReadCosineFloor({ vectorScore: low, graphBoost: 0.15, ftsScore: 0, runBoost: 0 }, 0.5)).toBe(true); // graph-reachable
    expect(passesReadCosineFloor({ vectorScore: low, graphBoost: 0, ftsScore: 0.2, runBoost: 0 }, 0.5)).toBe(true); // FTS
    expect(passesReadCosineFloor({ vectorScore: low, graphBoost: 0, ftsScore: 0, runBoost: 0.1 }, 0.5)).toBe(true); // run-boosted
    expect(passesReadCosineFloor({ vectorScore: 0, graphBoost: 0.15, ftsScore: 0, runBoost: 0 }, 0.5)).toBe(true);  // pure graph, no cosine
  });
});

describe('P2 — read-floor integration is byte-identical at floor 0 (flag on == flag off)', () => {
  let dir: string;
  let db: AgentMemoryDb;
  let embedding: LocalProvider;
  const scope: MemoryScopeRef = { type: 'context', id: 'floor' };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lynox-p2-floor-'));
    embedding = new LocalProvider();
    db = new AgentMemoryDb(join(dir, 'floor.db'));
    db.setEmbeddingDimensions(embedding.dimensions);
  });
  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('a flag-ON engine (floor 0) returns the SAME candidate set as a flag-OFF engine', async () => {
    // Seed a spread of relevances: an exact match + a weak off-topic near-miss.
    const texts = [
      'The invoicing service runs the nightly reconciliation batch.',
      'The marketing team scheduled a webinar about garden furniture.',
      'A reconciliation report is generated after the nightly batch completes.',
    ];
    for (const t of texts) {
      const emb = await embedding.embed(t);
      db.createMemory({ text: t, namespace: NS, scopeType: scope.type, scopeId: scope.id, embedding: emb, sourceType: 'agent_inferred' });
    }
    const entityResolver = new EntityResolver(db, embedding);
    // (db, provider, entityResolver, client, runHistory, scoringV2, shadowLog, TRUST_GATE)
    const off = new RetrievalEngine(db, embedding, entityResolver, undefined, undefined, false, false, false);
    const on = new RetrievalEngine(db, embedding, entityResolver, undefined, undefined, false, false, true);

    const opts = { topK: 10, threshold: 0.3, useHyDE: false, useGraphExpansion: false };
    const query = 'nightly reconciliation batch';
    const rOff = await off.retrieve(query, [scope], opts);
    const rOn = await on.retrieve(query, [scope], opts);

    const idsOff = rOff.memories.map(m => m.id).sort();
    const idsOn = rOn.memories.map(m => m.id).sort();
    expect(idsOn).toEqual(idsOff); // floor 0 → identical recall, gate is inert
  });
});
