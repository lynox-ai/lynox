import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KnowledgeLayer } from './knowledge-layer.js';
import { EngineDb } from './engine-db.js';
import { MemoryGraphStore } from './memory-graph-store.js';
import { MEMORY_WRITE_DECISION_LOG_FILE } from './memory-write-decision-log.js';
import type { EmbeddingProvider } from './embedding.js';
import type { ExtractionResult } from './entity-extractor.js';
import type { MemoryScopeRef } from '../types/index.js';

/**
 * Memory Foundation Wave 2 — the write-trust BACKSTOP's refusal must be CONSULTED.
 *
 * `AgentMemoryDb.supersedMemory` returns `false` when it refuses a lower-trust retire.
 * Both production call sites used to discard that answer and carry on writing the
 * supersedes edge (and, on the tier-raise path, transferring the confirmation count and
 * mirroring the retire onto engine.db) — so a refusal left the retire undone but every
 * piece of bookkeeping around it done. Retire fail-CLOSED, bookkeeping fail-OPEN.
 *
 * ⚠️ These tests do NOT stub the refusal — they REPRODUCE the only condition under which
 * it fires, because "the backstop can never refuse here" was the assumption that made
 * discarding the value look safe. The two checks read the existing row's tier from
 * DIFFERENT stores: the caller's decision takes it from the recall row (engine.db under
 * the S5b read cutover, via `_dedupRecall`), the backstop looks it up in agent-memory.db.
 * Setting engine.db's copy of one row's tier below its legacy copy is exactly the
 * dual-store divergence `DEF-dk-trust-gate-consistency` (a) describes, and it is what
 * these tests do — with raw SQL, so the divergence is data, not a mocked verdict.
 */

// Extraction mocked EMPTY: these memories are deliberately subject-less, so no LLM call
// and the supersession mirror is exercised on its own (it runs even when the subject-less
// branch skips the graph links — see `_persistWithSubjects`).
vi.mock('./entity-extractor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./entity-extractor.js')>();
  return { ...actual, extractEntities: vi.fn(async (): Promise<ExtractionResult> => ({ entities: [], relations: [] })) };
});

const NS = 'knowledge' as const;

/** Constant vector → every pair is cosine 1.0, so recall always surfaces the sibling and
 *  the number/negation/state heuristics alone decide contradiction-vs-dedup. */
class ConstantEmbedder implements EmbeddingProvider {
  readonly name = 'const-backstop';
  readonly model = 'const-backstop';
  readonly dimensions = 8;
  async embed(): Promise<number[]> { return [1, 0, 0, 0, 0, 0, 0, 0]; }
}

describe('Backstop — a refused retire is consulted, not discarded', () => {
  const scope: MemoryScopeRef = { type: 'context', id: 'orion' };
  const dirs: string[] = [];
  const engines: EngineDb[] = [];
  const layers: KnowledgeLayer[] = [];
  let dir: string;
  let prevDataDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-backstop-'));
    dirs.push(dir);
    prevDataDir = process.env['LYNOX_DATA_DIR'];
    process.env['LYNOX_DATA_DIR'] = dir;      // where the decision sink is written
  });

  afterEach(async () => {
    vi.restoreAllMocks();          // the spy below is per-test; do not let it outlive its test
    if (prevDataDir === undefined) delete process.env['LYNOX_DATA_DIR'];
    else process.env['LYNOX_DATA_DIR'] = prevDataDir;
    for (const l of layers) await l.close().catch(() => {});
    for (const e of engines) { try { e.close(); } catch { /* already closed */ } }
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    layers.length = 0; engines.length = 0; dirs.length = 0;
  });

  /** Mirror ON + read cutover ON + shadow ON + trust gate ENFORCING. */
  function newLayer(): { layer: KnowledgeLayer; engine: EngineDb } {
    const engine = new EngineDb(join(dir, 'engine.db'), 'vault-key-backstop');
    engines.push(engine);
    const layer = new KnowledgeLayer(
      join(dir, 'mem.db'), new ConstantEmbedder(), undefined, undefined, engine,
      /* subjectGraph */ true, /* memoryGraphReads */ true, /* scoringV2 */ false,
      /* shadow */ true, /* trust gate */ true,
    );
    layers.push(layer);
    return { layer, engine };
  }

  /**
   * Push engine.db's copy of one row's tier BELOW its legacy copy. This is the divergence
   * itself, written as data — recall (engine.db) then reports a tier the incoming write may
   * retire while the backstop (agent-memory.db) still holds the tier it may not.
   */
  function divergeEngineTier(engine: EngineDb, id: string, tier: string): void {
    const changed = engine.getDb()
      .prepare('UPDATE memories SET source_type = ? WHERE id = ?').run(tier, id).changes;
    // Guard the FIXTURE: a mirror that never wrote the stub would make every assertion
    // below pass for the wrong reason (no candidate → no decision → no refusal).
    expect(changed).toBe(1);
  }

  /**
   * Poll until a line matching `want` exists, THEN return the whole sink.
   *
   * The exit condition is the point. The appends are fire-and-forget and serialized per
   * file, and every one of these writes emits at least two decisions — so "the file is
   * non-empty" is reached while the line under test is still queued, and returning there
   * turns a real assertion into a coin flip. Proved rather than reasoned: a 30 ms delay per
   * append made both refusal tests fail on `expected [] to have a length of 1`.
   *
   * It doubles as the POSITIVE CONTROL for the absence assertion: a test that expects NO
   * refusal must first wait for a decision it does expect, or an unflushed sink reads as
   * proof of absence. Any measurement whose result is "nothing is there" needs a companion
   * that proves the instrument would have seen something.
   */
  const decisionsOnce = async (want: string): Promise<Array<Record<string, unknown>>> => {
    for (let i = 0; i < 60; i++) {
      try {
        const raw = await readFile(join(dir, MEMORY_WRITE_DECISION_LOG_FILE), 'utf8');
        const lines = raw.trim().split('\n').filter(Boolean)
          .map(l => JSON.parse(l) as Record<string, unknown>);
        if (lines.some(d => d.decision === want)) return lines;
      } catch { /* not yet flushed */ }
      await new Promise(r => setTimeout(r, 25));
    }
    throw new Error(`decision '${want}' never appeared in the sink`);
  };

  it('contradiction path: a refused retire demotes the resolution to coexist — no edge, no mirror', async () => {
    const { layer, engine } = newLayer();
    const truth = await layer.store('Orion budget is 30000', NS, scope, { sourceChannel: 'ui' });
    expect(layer.getDb().getMemory(truth.memoryId)!.source_type).toBe('user_asserted');

    // engine.db now says external_unverified, agent-memory.db still says user_asserted.
    // Deliberately a tier that is neither store's real value AND differs from the incoming
    // write's own tier — so the telemetry below can only report it by reading the recall
    // row, not by echoing `derivedTier`.
    divergeEngineTier(engine, truth.memoryId, 'external_unverified');

    // An agent_inferred write. The demotion loop reads the tier from the engine.db recall
    // row (external_unverified → strictly lower → allowed, NOT demoted); the backstop reads
    // the legacy row (user_asserted → strictly higher → refused).
    const res = await layer.store('Orion budget is 45000', NS, scope, { sourceChannel: 'agent' });

    // 1. The truth survives in the authoritative store — this held before the fix too.
    expect(layer.getDb().getMemory(truth.memoryId)!.is_active).toBe(1);
    // 2. No supersedes edge claiming a retire that never happened.
    expect(layer.getDb().listAllSupersedes().filter(s => s.old_memory_id === truth.memoryId)).toEqual([]);
    // 3. The RESOLUTION was demoted, so the by-reference array the engine.db mirrors read
    //    afterwards no longer says `superseded`. Without this the stub is retired on
    //    engine.db while the legacy row stays active — the truth invisible under the read
    //    cutover, which is worse than either store being wrong alone.
    expect(res.contradictions.find(c => c.existingMemoryId === truth.memoryId)?.resolution).toBe('coexist');
    expect(new MemoryGraphStore(engine).getStub(truth.memoryId)!.is_active).toBe(1);

    await layer.close();
    const decisions = await decisionsOnce('backstop-refused');
    const refused = decisions.filter(d => d.decision === 'backstop-refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]!.existingId).toBe(truth.memoryId);
    expect(refused[0]!.newTier).toBe('agent_inferred');
    // The AUTHORITATIVE tier — the one the backstop compared, from agent-memory.db. Not the
    // recall row's `external_unverified` (which the preceding `supersede` line carries) and
    // not an echo of `newTier`: reporting either would log the disagreement as an agreement.
    expect(refused[0]!.existingTier).toBe('user_asserted');
    expect(decisions.find(d => d.decision === 'supersede')!.existingTier).toBe('external_unverified');
    expect(refused[0]!.enforced).toBe(true);
    // PII discipline holds for the new variant too — the emit site sits next to the text.
    expect(JSON.stringify(refused[0])).not.toContain('Orion');
  });

  it('tier-raise path: a refused retire rolls the whole raise back to a plain dedup no-op', async () => {
    const { layer, engine } = newLayer();
    const truth = await layer.store('Orion lead is Ada Lovelace', NS, scope, { sourceChannel: 'ui' });
    const before = layer.getDb().getMemory(truth.memoryId)!;
    expect(before.source_type).toBe('user_asserted');

    // engine.db says external_unverified (rank 0), agent-memory.db still user_asserted (3).
    divergeEngineTier(engine, truth.memoryId, 'external_unverified');

    // agent_inferred (rank 1) strictly outranks what recall reports → the caller decides
    // `tier-raise`. The backstop compares against user_asserted → refuses.
    const res = await layer.store('Orion lead is Ada Lovelace', NS, scope, { sourceChannel: 'agent' });

    // The raise is all-or-nothing: the outcome is the plain dedup no-op.
    expect(res.stored).toBe(false);
    expect(res.deduplicated).toBe(true);
    expect(res.memoryId).toBe(truth.memoryId);

    // No fresh row was left behind by the rolled-back transaction.
    const all = layer.getDb().findSimilarMemories([1, 0, 0, 0, 0, 0, 0, 0], 10, 0,
      { namespace: NS, scopeTypes: ['context'], scopeIds: ['orion'], activeOnly: false });
    expect(all.map(m => m.id)).toEqual([truth.memoryId]);
    // ...no edge, and the confirmation count was not carried onto a row that never replaced it.
    expect(layer.getDb().listAllSupersedes()).toEqual([]);
    expect(layer.getDb().getMemory(truth.memoryId)!.is_active).toBe(1);
    // ...and the mirror never ran, so engine.db did not retire a stub whose legacy twin lives.
    expect(new MemoryGraphStore(engine).getStub(truth.memoryId)!.is_active).toBe(1);

    await layer.close();
    const decisions = await decisionsOnce('backstop-refused');
    const refused = decisions.filter(d => d.decision === 'backstop-refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]!.existingId).toBe(truth.memoryId);
    // The backstop's own side (agent-memory.db); the `tier-raise` line before it carries the
    // recall row's. Together the two lines are the two halves of the disagreement.
    expect(refused[0]!.existingTier).toBe('user_asserted');
    expect(decisions.find(d => d.decision === 'tier-raise')!.existingTier).toBe('external_unverified');
    expect(JSON.stringify(refused[0])).not.toContain('Ada Lovelace');
  });

  it('no divergence → the raise applies as before (the fix does not block the happy path)', async () => {
    const { layer, engine } = newLayer();
    const stored = await layer.store('Vega owner is Grace Hopper', NS, scope, { sourceChannel: 'agent' });
    expect(layer.getDb().getMemory(stored.memoryId)!.source_type).toBe('agent_inferred');

    // Both stores agree. A `ui` re-assert strictly outranks agent_inferred → a real raise.
    const res = await layer.store('Vega owner is Grace Hopper', NS, scope, { sourceChannel: 'ui' });
    expect(res.stored).toBe(true);
    expect(res.deduplicated).toBe(true);
    expect(res.memoryId).not.toBe(stored.memoryId);
    expect(layer.getDb().getMemory(stored.memoryId)!.is_active).toBe(0);
    expect(layer.getDb().getMemory(res.memoryId)!.source_type).toBe('user_asserted');
    expect(layer.getDb().listAllSupersedes()).toHaveLength(1);
    expect(new MemoryGraphStore(engine).getStub(stored.memoryId)!.is_active).toBe(0);

    await layer.close();
    // Wait for a decision we DO expect before claiming the absence of one we do not — an
    // unflushed sink is empty, and an empty sink proves nothing.
    expect((await decisionsOnce('tier-raise')).filter(d => d.decision === 'backstop-refused')).toEqual([]);
  });

  it('a refused write does NOT get to confirm the row it was refused from retiring', async () => {
    // The refusal path must not share the `wouldRaise === false` no-op-CONFIRM branch. That
    // branch means "an equal-or-lower re-assert of a row we agree about"; a refusal means the
    // authoritative store ranks this write strictly BELOW the row. Confirming anyway hands a
    // write we decided not to trust a +0.05 confidence bump and a +1 confirmation on every
    // repeat — in both stores — and recall ranking reads both. Live by default:
    // `memory_scoring_v2` is unset, so the confirm branch is the one that runs.
    const { layer, engine } = newLayer();
    const truth = await layer.store('Perseus deadline is March', NS, scope, { sourceChannel: 'ui' });
    const before = layer.getDb().getMemory(truth.memoryId)!;
    const stubBefore = new MemoryGraphStore(engine).getStub(truth.memoryId)!;
    divergeEngineTier(engine, truth.memoryId, 'external_unverified');

    // Five repeats — the shape an injected re-assert would take. Each is refused.
    for (let i = 0; i < 5; i++) {
      await layer.store('Perseus deadline is March', NS, scope, { sourceChannel: 'agent' });
    }

    const after = layer.getDb().getMemory(truth.memoryId)!;
    expect(after.confirmation_count).toBe(before.confirmation_count);
    expect(after.confidence).toBe(before.confidence);
    // ...and the mirror was not driven either — an amplification that only reached engine.db
    // would still move recall ranking under the read cutover.
    const stubAfter = new MemoryGraphStore(engine).getStub(truth.memoryId)!;
    expect(stubAfter.confirmation_count).toBe(stubBefore.confirmation_count);
    expect(stubAfter.confidence).toBe(stubBefore.confidence);
  });

  it('an unreadable row is reported as NOTHING, never as a fabricated tier', async () => {
    // `existingTier` must be the tier the backstop compared. If that row cannot be read
    // there is no honest value to put there — every `ProvenanceKind` asserts a trust level,
    // so any placeholder invents one, and a sink whose whole job is to count disagreements
    // is worse for containing invented ones than for missing a line.
    const { layer, engine } = newLayer();
    const truth = await layer.store('Cygnus owner is Ada', NS, scope, { sourceChannel: 'ui' });
    divergeEngineTier(engine, truth.memoryId, 'external_unverified');

    const db = layer.getDb();
    const realGetMemory = db.getMemory.bind(db);
    vi.spyOn(db, 'getMemory').mockImplementation(
      (id: string) => (id === truth.memoryId ? null : realGetMemory(id)),
    );

    // The refusal itself is untouched — `supersedMemory` reads the tiers with its own
    // statements, so only the REPORTING loses its input.
    const res = await layer.store('Cygnus owner is Ada', NS, scope, { sourceChannel: 'agent' });
    expect(res.stored).toBe(false);
    expect(res.memoryId).toBe(truth.memoryId);

    await layer.close();
    const decisions = await decisionsOnce('tier-raise');
    expect(decisions.filter(d => d.decision === 'backstop-refused')).toEqual([]);
  });

  it('a refusal is NOT reported when the transaction that found it rolls back', async () => {
    // The sink is a fire-and-forget append: emitting from inside the transaction records a
    // refusal for a write that a later contradiction can still roll back, and records it
    // again on the retry — inflating the very rate the sink exists to establish. Refusals
    // are therefore collected and emitted only after the transaction commits.
    //
    // Reaching a rollback AFTER a refusal needs TWO `superseded` contradictions in one
    // write, and the retire is what normally prevents two contradicting facts from both
    // staying active — so the retire is neutralised while the fixture is built. What is
    // under test here is WHERE the emit sits, not the refusal logic (covered above).
    const { layer, engine } = newLayer();
    const db = layer.getDb();
    let refuseOnce = false;                                   // explicit, not mockReset — that
    vi.spyOn(db, 'supersedMemory').mockImplementation(() => {  // restores the real impl in vitest 4
      if (refuseOnce) { refuseOnce = false; return false; }
      return true;                                            // report success, retire nothing
    });
    const first = await layer.store('Draco budget is 100', NS, scope, { sourceChannel: 'agent' });
    await layer.store('Draco budget is 200', NS, scope, { sourceChannel: 'agent' });
    // The engine.db MIRROR is not stubbed, so it retired the first row's stub even though the
    // stubbed retire left the legacy row active — and recall reads engine.db under the
    // cutover. Revive the stub, or the third write sees one candidate instead of two. (That
    // the fixture trips over this at all is the divergence this PR is about, from the other
    // side: one store retired, the other not.)
    engine.getDb().prepare('UPDATE memories SET is_active = 1 WHERE id = ?').run(first.memoryId);

    refuseOnce = true;                                        // refuse the first, accept the second
    vi.spyOn(db, 'createSupersedes').mockImplementation(() => { throw new Error('rollback'); });

    await expect(layer.store('Draco budget is 300', NS, scope, { sourceChannel: 'agent' }))
      .rejects.toThrow('rollback');

    await layer.close();
    // `supersede` is the positive control: the pre-transaction decision loop emitted it, so
    // the sink is demonstrably flushed and the absence below is a measurement, not silence.
    const decisions = await decisionsOnce('supersede');
    expect(decisions.filter(d => d.decision === 'backstop-refused')).toEqual([]);
  });

  it('a REAL failure inside the raise still propagates — the rollback catch is not a swallow', async () => {
    // The refusal aborts the raise transaction by throwing a sentinel, so `_raiseTier` has
    // to catch. A catch that returns `null` for ANY error would turn a genuine write failure
    // into a silent "deduplicated, nothing to do" — the write lost with no signal, which is
    // the fail-open direction this whole PR is closing. Only the sentinel may be absorbed.
    const { layer } = newLayer();
    const stored = await layer.store('Lyra owner is Alan Turing', NS, scope, { sourceChannel: 'agent' });
    const boom = new Error('disk full');
    vi.spyOn(layer.getDb(), 'addConfirmations').mockImplementation(() => { throw boom; });

    // A `ui` re-assert strictly outranks agent_inferred → the raise runs and hits the throw.
    await expect(layer.store('Lyra owner is Alan Turing', NS, scope, { sourceChannel: 'ui' }))
      .rejects.toThrow('disk full');
    // ...and the aborted transaction left nothing behind.
    expect(layer.getDb().getMemory(stored.memoryId)!.is_active).toBe(1);
    expect(layer.getDb().listAllSupersedes()).toEqual([]);
  });
});
