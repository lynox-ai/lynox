import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeLayer } from './knowledge-layer.js';
import { AgentMemoryDb } from './agent-memory-db.js';
import { EngineDb } from './engine-db.js';
import { MemoryGraphStore } from './memory-graph-store.js';
import { provenanceRank, canSupersede } from './provenance.js';
import { ALL_PROVENANCE_KINDS, type ProvenanceKind } from '../types/memory.js';
import { MEMORY_WRITE_DECISION_LOG_FILE } from './memory-write-decision-log.js';
import type { EmbeddingProvider } from './embedding.js';
import type { MemoryScopeRef } from '../types/index.js';

/**
 * Memory Foundation Wave 2 — the write-trust gate.
 *
 * A strictly-lower-trust write must never retire a higher-trust memory (P1a contradiction
 * demote-to-coexist + tier-first consolidation keeper + both retire-primitive backstops),
 * and a higher-trust re-assert of a near-dup RAISES the stored fact via supersede-not-mutate
 * (P1b). All flag-gated: flag OFF → byte-identical. The would-be decision is shadow-logged
 * (text-free) independently of enforcement.
 */

const NS = 'knowledge' as const;

/** Constant-vector embedder → every pair is cosine 1.0, so the dedup/contradiction recall
 *  always surfaces the sibling; the heuristics (number/negation/state) are then the only
 *  thing that routes a pair to contradiction-vs-dedup. Deterministic + fast. */
class ConstantEmbedder implements EmbeddingProvider {
  readonly name = 'const-test';
  readonly model = 'const-test';
  readonly dimensions = 8;
  async embed(): Promise<number[]> { return [1, 0, 0, 0, 0, 0, 0, 0]; }
}

// ─────────────────────────────────────────────────────────────────────────────
// P0 — the trust primitive. THE security-critical direction test.
// ─────────────────────────────────────────────────────────────────────────────
describe('P0 — provenanceRank / canSupersede (trust total order)', () => {
  it('canSupersede DIRECTION: equal-or-higher retires, strictly-lower never (injection-critical)', () => {
    // A raw indexOf would INVERT these (ALL_PROVENANCE_KINDS is highest-trust-FIRST) and
    // turn the gate into an injection ENABLER. Assert the BEHAVIOUR, never a scalar rank.
    expect(canSupersede('user_asserted', 'agent_inferred')).toBe(true);
    expect(canSupersede('agent_inferred', 'user_asserted')).toBe(false);
    expect(canSupersede('external_unverified', 'user_asserted')).toBe(false);
    expect(canSupersede('external_unverified', 'agent_inferred')).toBe(false);
    // Equal trust may retire (newest-wins for same-tier conflicts).
    expect(canSupersede('agent_inferred', 'agent_inferred')).toBe(true);
    expect(canSupersede('user_asserted', 'user_asserted')).toBe(true);
    // tool_verified sits between agent_inferred and user_asserted.
    expect(canSupersede('tool_verified', 'agent_inferred')).toBe(true);
    expect(canSupersede('agent_inferred', 'tool_verified')).toBe(false);
  });

  it('the rank is a strict total order following the array position (highest-first → reverse)', () => {
    // user_asserted is index 0 in ALL_PROVENANCE_KINDS but MOST trusted → highest rank.
    expect(provenanceRank('user_asserted')).toBeGreaterThan(provenanceRank('tool_verified'));
    expect(provenanceRank('tool_verified')).toBeGreaterThan(provenanceRank('agent_inferred'));
    expect(provenanceRank('agent_inferred')).toBeGreaterThan(provenanceRank('external_unverified'));
    // A mid-array reorder must flip a behavioural pair (order is semantically load-bearing):
    // simulate swapping the two middle tiers and confirm canSupersede would change.
    const reordered: ProvenanceKind[] = ['user_asserted', 'agent_inferred', 'tool_verified', 'external_unverified'];
    const rankIn = (arr: readonly ProvenanceKind[], k: ProvenanceKind): number => (arr.length - 1) - arr.indexOf(k);
    // In the REAL order tool_verified outranks agent_inferred; in the reordered one it does not.
    expect(rankIn(ALL_PROVENANCE_KINDS, 'tool_verified') > rankIn(ALL_PROVENANCE_KINDS, 'agent_inferred')).toBe(true);
    expect(rankIn(reordered, 'tool_verified') > rankIn(reordered, 'agent_inferred')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P1a — trust-aware contradiction (decide-at-source), legacy store.
// ─────────────────────────────────────────────────────────────────────────────
describe('P1a — trust-aware contradiction (legacy store)', () => {
  let dir: string;
  const scope: MemoryScopeRef = { type: 'context', id: 'p1a' };

  const makeLayer = (gate: boolean): KnowledgeLayer =>
    // (dbPath, provider, client, runHistory, engineDb, subjGraph, memReads, scoringV2, shadow, TRUST_GATE)
    new KnowledgeLayer(join(dir, `mem-${gate}.db`), new ConstantEmbedder(),
      undefined, undefined, undefined, false, false, false, false, gate);

  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'lynox-mwtg-p1a-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }).catch(() => {}); });

  it('GATE ON: an agent_inferred write CANNOT retire a user_asserted truth → coexist', async () => {
    const layer = makeLayer(true);
    const truth = await layer.store('Orion budget is 30000 per year', NS, scope, { sourceChannel: 'ui' });
    const inject = await layer.store('Orion budget is 45000 per year', NS, scope, { sourceChannel: 'agent' });
    // The user truth survives; both facts coexist.
    expect(layer.getDb().getMemory(truth.memoryId)!.is_active).toBe(1);
    expect(inject.contradictions.some(c => c.existingMemoryId === truth.memoryId && c.resolution === 'coexist')).toBe(true);
    await layer.close();
  });

  it('GATE ON: an untrusted-turn write (external_unverified) can supersede NOTHING → coexist', async () => {
    const layer = makeLayer(true);
    const truth = await layer.store('Orion status is active', NS, scope, { sourceChannel: 'ui' });
    await layer.store('Orion status is completed', NS, scope, { sourceChannel: 'agent', sourceUntrusted: true });
    expect(layer.getDb().getMemory(truth.memoryId)!.is_active).toBe(1);
    await layer.close();
  });

  it('GATE ON: a higher-trust (ui) correction STILL supersedes an agent_inferred fact (no over-block)', async () => {
    const layer = makeLayer(true);
    const weak = await layer.store('Orion budget is 30000 per year', NS, scope, { sourceChannel: 'agent' });
    await layer.store('Orion budget is 45000 per year', NS, scope, { sourceChannel: 'ui' });
    expect(layer.getDb().getMemory(weak.memoryId)!.is_active).toBe(0); // retired by the higher-trust correction
    await layer.close();
  });

  it('GATE ON: two same-tier (agent) facts → newest wins (equal trust may retire)', async () => {
    const layer = makeLayer(true);
    const first = await layer.store('Orion status is active', NS, scope, { sourceChannel: 'agent' });
    await layer.store('Orion status is completed', NS, scope, { sourceChannel: 'agent' });
    expect(layer.getDb().getMemory(first.memoryId)!.is_active).toBe(0);
    await layer.close();
  });

  it('GATE OFF: an agent_inferred write retires the user_asserted row (legacy — no-op proof)', async () => {
    const layer = makeLayer(false);
    const truth = await layer.store('Orion budget is 30000 per year', NS, scope, { sourceChannel: 'ui' });
    await layer.store('Orion budget is 45000 per year', NS, scope, { sourceChannel: 'agent' });
    expect(layer.getDb().getMemory(truth.memoryId)!.is_active).toBe(0); // byte-identical legacy behaviour
    await layer.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P1b — dedup tier-raise via supersede-not-mutate, legacy store.
// ─────────────────────────────────────────────────────────────────────────────
describe('P1b — dedup tier-raise (supersede-not-mutate)', () => {
  let dir: string;
  const scope: MemoryScopeRef = { type: 'context', id: 'p1b' };
  const TEXT = 'The primary contact for Orion is Ada Lovelace';

  const makeLayer = (gate: boolean): KnowledgeLayer =>
    new KnowledgeLayer(join(dir, `mem-${gate}.db`), new ConstantEmbedder(),
      undefined, undefined, undefined, false, false, false, false, gate);

  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'lynox-mwtg-p1b-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }).catch(() => {}); });

  it('GATE ON: a ui re-assert of an agent_inferred near-dup RAISES it (fresh user_asserted row, old retired, confirmations carried)', async () => {
    const layer = makeLayer(true);
    const weak = await layer.store(TEXT, NS, scope, { sourceChannel: 'agent' });
    layer.getDb().confirmMemory(weak.memoryId);
    layer.getDb().confirmMemory(weak.memoryId); // cc = 2 on the old row
    const raised = await layer.store(TEXT, NS, scope, { sourceChannel: 'ui' });

    expect(raised.memoryId).not.toBe(weak.memoryId);
    expect(raised.deduplicated).toBe(true);
    const newRow = layer.getDb().getMemory(raised.memoryId)!;
    const oldRow = layer.getDb().getMemory(weak.memoryId)!;
    expect(newRow.source_type).toBe('user_asserted'); // raised to the protected tier
    expect(newRow.is_active).toBe(1);
    expect(oldRow.is_active).toBe(0);                  // old lower-trust row retired
    expect(oldRow.source_channel).toBe('agent');       // evidence NOT mutated on the old row
    expect(newRow.confirmation_count).toBe(2);          // carried forward, not dropped
    await layer.close();
  });

  it('GATE ON: a same-or-lower re-assert stays a PLAIN no-op-confirm (no raise)', async () => {
    const layer = makeLayer(true);
    const strong = await layer.store(TEXT, NS, scope, { sourceChannel: 'ui' });
    const reassert = await layer.store(TEXT, NS, scope, { sourceChannel: 'agent' }); // lower trust
    expect(reassert.memoryId).toBe(strong.memoryId); // same row, no new row minted
    expect(reassert.deduplicated).toBe(true);
    expect(reassert.stored).toBe(false);
    expect(layer.getDb().getMemory(strong.memoryId)!.source_type).toBe('user_asserted');
    await layer.close();
  });

  it('GATE OFF: a ui re-assert is a plain dedup no-op (old row unchanged, same id)', async () => {
    const layer = makeLayer(false);
    const weak = await layer.store(TEXT, NS, scope, { sourceChannel: 'agent' });
    const reassert = await layer.store(TEXT, NS, scope, { sourceChannel: 'ui' });
    expect(reassert.memoryId).toBe(weak.memoryId);       // byte-identical: no raise
    expect(reassert.stored).toBe(false);
    expect(layer.getDb().getMemory(weak.memoryId)!.source_type).toBe('agent_inferred'); // tier untouched
    await layer.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Backstops — the retire primitives refuse a downgrade when called directly.
// ─────────────────────────────────────────────────────────────────────────────
describe('Backstops — direct retire primitives (both stores)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'lynox-mwtg-bs-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }).catch(() => {}); });

  it('AgentMemoryDb.supersedMemory refuses a strictly-lower-trust retire under trustGate', () => {
    const db = new AgentMemoryDb(join(dir, 'bs.db'));
    db.setEmbeddingDimensions(8);
    const emb = [1, 0, 0, 0, 0, 0, 0, 0];
    const truth = db.createMemory({ text: 'truth', namespace: NS, scopeType: 'context', scopeId: 's', embedding: emb, sourceType: 'user_asserted', sourceChannel: 'ui' });
    const weak = db.createMemory({ text: 'weak', namespace: NS, scopeType: 'context', scopeId: 's', embedding: emb, sourceType: 'agent_inferred', sourceChannel: 'agent' });
    // A lower-trust write attempting to retire the user truth is refused.
    expect(db.supersedMemory(truth, weak, { trustGate: true })).toBe(false);
    expect(db.getMemory(truth)!.is_active).toBe(1);
    // The reverse (higher-trust retiring lower) is allowed.
    expect(db.supersedMemory(weak, truth, { trustGate: true })).toBe(true);
    expect(db.getMemory(weak)!.is_active).toBe(0);
    // Without the gate the retire is unconditional (legacy).
    const a = db.createMemory({ text: 'a', namespace: NS, scopeType: 'context', scopeId: 's2', embedding: emb, sourceType: 'user_asserted', sourceChannel: 'ui' });
    const b = db.createMemory({ text: 'b', namespace: NS, scopeType: 'context', scopeId: 's2', embedding: emb, sourceType: 'agent_inferred', sourceChannel: 'agent' });
    expect(db.supersedMemory(a, b)).toBe(true);
    expect(db.getMemory(a)!.is_active).toBe(0);
    db.close();
  });

  it('MemoryGraphStore.markSuperseded refuses a downgrade when passed a lower newTier', () => {
    const engine = new EngineDb(join(dir, 'engine.db'), 'vault-key-bs');
    const mgs = new MemoryGraphStore(engine);
    const emb = Buffer.alloc(8 * 8);
    mgs.upsertStub({ id: 'truth', text: 't', namespace: NS, scopeType: 'context', scopeId: 's', sourceType: 'user_asserted', embedding: emb });
    // A lower-trust supersede is refused (newTier below the stored tier).
    mgs.markSuperseded('truth', 'incoming', { newTier: 'agent_inferred' });
    expect(mgs.getStub('truth')!.is_active).toBe(1);
    // An equal-or-higher newTier retires it.
    mgs.markSuperseded('truth', 'incoming', { newTier: 'user_asserted' });
    expect(mgs.getStub('truth')!.is_active).toBe(0);
    // Undefined newTier (consolidation mirror / flag off) → unconditional legacy retire.
    mgs.upsertStub({ id: 'truth2', text: 't2', namespace: NS, scopeType: 'context', scopeId: 's', sourceType: 'user_asserted', embedding: emb });
    mgs.markSuperseded('truth2', 'incoming2');
    expect(mgs.getStub('truth2')!.is_active).toBe(0);
    engine.close();
  });

  it('consolidation keeper-sort is tier-first under the gate (user_asserted wins the merge)', () => {
    const db = new AgentMemoryDb(join(dir, 'consol.db'));
    db.setEmbeddingDimensions(8);
    const emb = [1, 0, 0, 0, 0, 0, 0, 0];
    // Two near-identical facts; the low-trust one has MORE confirmations (would win legacy).
    const weak = db.createMemory({ text: 'Orion lead is Ada', namespace: NS, scopeType: 'context', scopeId: 'c', embedding: emb, sourceType: 'agent_inferred', sourceChannel: 'agent' });
    for (let i = 0; i < 5; i++) db.confirmMemory(weak);
    const truth = db.createMemory({ text: 'Orion lead is Ada', namespace: NS, scopeType: 'context', scopeId: 'c', embedding: emb, sourceType: 'user_asserted', sourceChannel: 'ui' });

    const pairs = db.consolidateMemories(NS, 'context', 'c', 0.9, undefined, true, /* enforceTrustGate */ true);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.keeperId).toBe(truth);   // tier beats confirmation-count
    expect(pairs[0]!.victimId).toBe(weak);
    expect(db.getMemory(truth)!.is_active).toBe(1);
    expect(db.getMemory(weak)!.is_active).toBe(0);
    db.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Shadow — write-decision telemetry is text-free + measures before enforcement.
// ─────────────────────────────────────────────────────────────────────────────
describe('Shadow — write-decision telemetry (text-free, shadow-first)', () => {
  let dir: string;
  let prevDataDir: string | undefined;
  const scope: MemoryScopeRef = { type: 'context', id: 'shadow' };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lynox-mwtg-shadow-'));
    prevDataDir = process.env['LYNOX_DATA_DIR'];
    process.env['LYNOX_DATA_DIR'] = dir;
  });
  afterEach(async () => {
    if (prevDataDir === undefined) delete process.env['LYNOX_DATA_DIR'];
    else process.env['LYNOX_DATA_DIR'] = prevDataDir;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  const readDecisions = async (): Promise<Array<Record<string, unknown>>> => {
    // Fire-and-forget append: poll briefly for the flush.
    for (let i = 0; i < 40; i++) {
      try {
        const raw = await readFile(join(dir, MEMORY_WRITE_DECISION_LOG_FILE), 'utf8');
        const lines = raw.trim().split('\n').filter(Boolean);
        if (lines.length > 0) return lines.map(l => JSON.parse(l) as Record<string, unknown>);
      } catch { /* not yet written */ }
      await new Promise(r => setTimeout(r, 25));
    }
    return [];
  };

  it('records a demote decision WITHOUT the memory text, even when enforcement is OFF (measure-first)', async () => {
    // shadow ON (9th arg), trust gate OFF (10th arg) → measure the would-be decision, do not apply.
    const layer = new KnowledgeLayer(join(dir, 'mem.db'), new ConstantEmbedder(),
      undefined, undefined, undefined, false, false, false, /* shadow */ true, /* gate */ false);
    const truth = await layer.store('Orion budget is 30000 secret-token-abc', NS, scope, { sourceChannel: 'ui' });
    await layer.store('Orion budget is 45000 secret-token-abc', NS, scope, { sourceChannel: 'agent' });
    // Enforcement was OFF → the write path stayed legacy (truth retired). Assert before close.
    expect(layer.getDb().getMemory(truth.memoryId)!.is_active).toBe(0);
    await layer.close();

    const decisions = await readDecisions();
    const demote = decisions.find(d => d.decision === 'demote-coexist');
    expect(demote).toBeDefined();
    expect(demote!.newTier).toBe('agent_inferred');
    expect(demote!.existingTier).toBe('user_asserted');
    expect(demote!.enforced).toBe(false);        // shadow-first: measured, not applied
    expect(demote!.existingId).toBe(truth.memoryId);
    // PII discipline: no memory text anywhere in the record.
    for (const d of decisions) {
      expect(d).not.toHaveProperty('text');
      expect(d).not.toHaveProperty('body');
      expect(JSON.stringify(d)).not.toContain('secret-token-abc');
      expect(JSON.stringify(d)).not.toContain('Orion');
    }
  });
});
