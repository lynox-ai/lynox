import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { AgentMemoryDb } from './agent-memory-db.js';
import { SubjectStore } from './subject-store.js';
import { SubjectGraphBackfill } from './subject-graph-backfill.js';

/**
 * S5a memory-statement backfill (the opt-in Pass 3 of SubjectGraphBackfill): the
 * legacy agent-memory.db `memories` must land in engine.db byte-for-byte (text via
 * the enc boundary, embedding + lifecycle raw), linked to the subjects their
 * mentions resolved to, with supersedes + derived co-occurrences replayed — and a
 * re-run must be convergent (embeddings + counts included).
 */
describe('SubjectGraphBackfill — S5a memory pass (includeMemories)', () => {
  const tmpDirs: string[] = [];

  function setup(): { engineDb: EngineDb; memoryDb: AgentMemoryDb; subjects: SubjectStore } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-s5a-'));
    tmpDirs.push(dir);
    const engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key-s5a');
    const memoryDb = new AgentMemoryDb(join(dir, 'agent-memory.db'));
    return { engineDb, memoryDb, subjects: new SubjectStore(engineDb) };
  }

  afterEach(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  function entity(memoryDb: AgentMemoryDb, name: string, type: string): string {
    return memoryDb.createEntity({ canonicalName: name, entityType: type, scopeType: 'global', scopeId: 'g' });
  }
  function memRow(engineDb: EngineDb, id: string): {
    text: string; subject_id: string | null; embedding: Buffer | null;
    is_active: number; superseded_by: string | null; confidence: number;
  } {
    return engineDb.getDb().prepare(
      'SELECT text, subject_id, embedding, is_active, superseded_by, confidence FROM memories WHERE id = ?',
    ).get(id) as never;
  }

  it('replays every legacy memory into engine.db with text (dec) + embedding byte-identical', () => {
    const { engineDb, memoryDb } = setup();
    const alice = entity(memoryDb, 'Alice', 'person');
    const emb = [0.11, -0.22, 0.33, 0.44];
    const m1 = memoryDb.createMemory({
      text: 'Alice prefers async standups.', namespace: 'business',
      scopeType: 'global', scopeId: 'g', embedding: emb,
    });
    memoryDb.createMention(m1, alice);
    memoryDb.confirmMemory(m1);   // bumps confidence off the 0.75 default → proves the carry

    const counts = new SubjectGraphBackfill(engineDb, memoryDb).run({ includeMemories: true });

    expect(counts.memoriesMapped).toBe(1);
    expect(counts.memoriesSubjectless).toBe(0);
    const legacy = memoryDb.getMemory(m1)!;
    const back = memRow(engineDb, m1);
    // text: enc'd at rest in engine.db, decrypts back to the legacy plaintext.
    expect(engineDb.dec(back.text)).toBe('Alice prefers async standups.');
    expect(legacy.text).toBe('Alice prefers async standups.');
    // embedding: raw BLOB copy, byte-for-byte (no re-embed).
    expect(back.embedding).not.toBeNull();
    expect(back.embedding!.equals(legacy.embedding!)).toBe(true);
    // confidence carried from legacy (a non-default value, so this isn't just the DEFAULT).
    expect(legacy.confidence).toBeGreaterThan(0.75);
    expect(back.confidence).toBeCloseTo(legacy.confidence, 6);
    engineDb.close(); memoryDb.close();
  });

  it('links a memory to the subjects its mentions resolved to (mentions → memory_subjects)', () => {
    const { engineDb, memoryDb, subjects } = setup();
    const alice = entity(memoryDb, 'Alice', 'person');
    const acme = entity(memoryDb, 'Acme', 'organization');
    const gdpr = entity(memoryDb, 'GDPR', 'concept'); // non-subject kind → not linked
    const m = memoryDb.createMemory({
      text: 'Alice at Acme raised a GDPR question.', namespace: 'business',
      scopeType: 'global', scopeId: 'g', embedding: [0.1, 0.2],
    });
    memoryDb.createMention(m, alice);
    memoryDb.createMention(m, acme);
    memoryDb.createMention(m, gdpr);

    new SubjectGraphBackfill(engineDb, memoryDb).run({ includeMemories: true });

    const aliceSid = subjects.findCanonical('Alice', 'person')!.id;
    const acmeSid = subjects.findCanonical('Acme', 'organization')!.id;
    const linked = (engineDb.getDb().prepare('SELECT subject_id FROM memory_subjects WHERE memory_id = ?')
      .all(m) as Array<{ subject_id: string }>).map(r => r.subject_id).sort();
    expect(linked).toEqual([aliceSid, acmeSid].sort());
    // primary = a person/org the memory concerns (mirror policy treats person & org
    // equally → order-dependent), never the dropped concept, never null.
    expect([aliceSid, acmeSid]).toContain(memRow(engineDb, m).subject_id);
    engineDb.close(); memoryDb.close();
  });

  it('STORES a subject-less memory (regression: the mirror early-return dropped it)', () => {
    const { engineDb, memoryDb } = setup();
    // A memory whose only mention is a concept (no subject kind) → subject-less.
    const gdpr = entity(memoryDb, 'GDPR', 'concept');
    const m = memoryDb.createMemory({
      text: 'GDPR requires a DPA with every processor.', namespace: 'business',
      scopeType: 'global', scopeId: 'g', embedding: [0.5, 0.6],
    });
    memoryDb.createMention(m, gdpr);

    const counts = new SubjectGraphBackfill(engineDb, memoryDb).run({ includeMemories: true });

    expect(counts.memoriesMapped).toBe(1);
    expect(counts.memoriesSubjectless).toBe(1);
    const back = memRow(engineDb, m);
    expect(back).toBeTruthy();                 // stored despite no subject
    expect(back.subject_id).toBeNull();
    expect(engineDb.dec(back.text)).toBe('GDPR requires a DPA with every processor.');
    // No junction rows for a subject-less memory.
    expect((engineDb.getDb().prepare('SELECT COUNT(*) n FROM memory_subjects WHERE memory_id = ?')
      .get(m) as { n: number }).n).toBe(0);
    engineDb.close(); memoryDb.close();
  });

  it('carries is_active + superseded_by and replays the supersedes junction', () => {
    const { engineDb, memoryDb } = setup();
    const alice = entity(memoryDb, 'Alice', 'person');
    const older = memoryDb.createMemory({
      text: 'Alice uses Slack.', namespace: 'business', scopeType: 'global', scopeId: 'g', embedding: [0.1],
    });
    const newer = memoryDb.createMemory({
      text: 'Alice uses Teams now.', namespace: 'business', scopeType: 'global', scopeId: 'g', embedding: [0.2],
    });
    memoryDb.createMention(older, alice);
    memoryDb.createMention(newer, alice);
    memoryDb.supersedMemory(older, newer);            // older.is_active=0, superseded_by=newer
    memoryDb.createSupersedes(newer, older, 'contradiction');

    new SubjectGraphBackfill(engineDb, memoryDb).run({ includeMemories: true });

    const backOld = memRow(engineDb, older);
    expect(backOld.is_active).toBe(0);
    expect(backOld.superseded_by).toBe(newer);
    expect(memRow(engineDb, newer).is_active).toBe(1);
    // supersedes junction replayed.
    const sup = engineDb.getDb().prepare('SELECT reason FROM supersedes WHERE new_memory_id = ? AND old_memory_id = ?')
      .get(newer, older) as { reason: string } | undefined;
    expect(sup?.reason).toBe('contradiction');
    engineDb.close(); memoryDb.close();
  });

  it('rebuilds co-occurrences from the junction and is idempotent on a re-run (no doubling)', () => {
    const { engineDb, memoryDb, subjects } = setup();
    const alice = entity(memoryDb, 'Alice', 'person');
    const acme = entity(memoryDb, 'Acme', 'organization');
    const m1 = memoryDb.createMemory({ text: 'Alice works at Acme.', namespace: 'business', scopeType: 'global', scopeId: 'g', embedding: [0.1] });
    const m2 = memoryDb.createMemory({ text: 'Alice met Acme leadership.', namespace: 'business', scopeType: 'global', scopeId: 'g', embedding: [0.2] });
    for (const m of [m1, m2]) { memoryDb.createMention(m, alice); memoryDb.createMention(m, acme); }

    const backfill = new SubjectGraphBackfill(engineDb, memoryDb);
    const first = backfill.run({ includeMemories: true });
    const aliceSid = subjects.findCanonical('Alice', 'person')!.id;
    const acmeSid = subjects.findCanonical('Acme', 'organization')!.id;
    const [a, b] = aliceSid < acmeSid ? [aliceSid, acmeSid] : [acmeSid, aliceSid];
    const coCount = (): number => (engineDb.getDb().prepare(
      'SELECT count FROM subject_cooccurrences WHERE subject_a_id = ? AND subject_b_id = ?').get(a, b) as { count: number } | undefined)?.count ?? 0;

    // 2 memories co-mention (Alice, Acme) → count 2.
    expect(coCount()).toBe(2);

    const second = backfill.run({ includeMemories: true });
    // Re-run: memories not doubled, co-occurrence NOT incremented (rebuilt from junction).
    expect(second.memoriesMapped).toBe(first.memoriesMapped);
    expect((engineDb.getDb().prepare('SELECT COUNT(*) n FROM memories').get() as { n: number }).n).toBe(2);
    expect(coCount()).toBe(2);
    engineDb.close(); memoryDb.close();
  });

  it('re-run is convergent for embedding bytes AND the supersedes junction (not just counts)', () => {
    const { engineDb, memoryDb } = setup();
    const alice = entity(memoryDb, 'Alice', 'person');
    const emb = [0.7, -0.1, 0.25];
    const older = memoryDb.createMemory({ text: 'Alice uses Slack.', namespace: 'business', scopeType: 'global', scopeId: 'g', embedding: emb });
    const newer = memoryDb.createMemory({ text: 'Alice uses Teams now.', namespace: 'business', scopeType: 'global', scopeId: 'g', embedding: [0.2] });
    memoryDb.createMention(older, alice);
    memoryDb.createMention(newer, alice);
    memoryDb.supersedMemory(older, newer);
    memoryDb.createSupersedes(newer, older, 'contradiction');

    const backfill = new SubjectGraphBackfill(engineDb, memoryDb);
    const first = backfill.run({ includeMemories: true });
    const supCount = (): number => (engineDb.getDb().prepare('SELECT COUNT(*) n FROM supersedes').get() as { n: number }).n;
    expect(first.supersedesMapped).toBe(1);
    expect(supCount()).toBe(1);

    const second = backfill.run({ includeMemories: true });
    // embedding still byte-identical after the 2nd run …
    expect(memRow(engineDb, older).embedding!.equals(memoryDb.getMemory(older)!.embedding!)).toBe(true);
    // … the supersedes junction not doubled …
    expect(supCount()).toBe(1);
    // … supersedesMapped now 0 (nothing NEW replayed — the pair already exists) …
    expect(second.supersedesMapped).toBe(0);
    // … and the memory set not doubled.
    expect(second.memoriesMapped).toBe(first.memoriesMapped);
    expect((engineDb.getDb().prepare('SELECT COUNT(*) n FROM memories').get() as { n: number }).n).toBe(2);
    engineDb.close(); memoryDb.close();
  });

  it('replays a supersedes pair whose BOTH memories are subject-less (the exact S5a regression)', () => {
    const { engineDb, memoryDb } = setup();
    // Neither memory mentions a subject-bearing entity → both are subject-less.
    const gdpr = entity(memoryDb, 'GDPR', 'concept');
    const older = memoryDb.createMemory({ text: 'GDPR needs a DPA.', namespace: 'business', scopeType: 'global', scopeId: 'g', embedding: [0.1] });
    const newer = memoryDb.createMemory({ text: 'GDPR needs a DPA and a SCC.', namespace: 'business', scopeType: 'global', scopeId: 'g', embedding: [0.2] });
    memoryDb.createMention(older, gdpr);
    memoryDb.createMention(newer, gdpr);
    memoryDb.supersedMemory(older, newer);
    memoryDb.createSupersedes(newer, older, 'contradiction');

    const counts = new SubjectGraphBackfill(engineDb, memoryDb).run({ includeMemories: true });

    // Both subject-less memories are STILL stored (the old mirror early-return dropped them) …
    expect(counts.memoriesMapped).toBe(2);
    expect(counts.memoriesSubjectless).toBe(2);
    expect(memRow(engineDb, older).subject_id).toBeNull();
    expect(memRow(engineDb, newer).subject_id).toBeNull();
    // … the supersedes junction lands (both stubs exist → FK guard passes) …
    expect(counts.supersedesMapped).toBe(1);
    const sup = engineDb.getDb().prepare('SELECT reason FROM supersedes WHERE new_memory_id = ? AND old_memory_id = ?')
      .get(newer, older) as { reason: string } | undefined;
    expect(sup?.reason).toBe('contradiction');
    // … and the lifecycle carried.
    expect(memRow(engineDb, older).is_active).toBe(0);
    expect(memRow(engineDb, older).superseded_by).toBe(newer);
    engineDb.close(); memoryDb.close();
  });

  it('backfills MORE than one page of memories (page-boundary regression)', () => {
    const { engineDb, memoryDb } = setup();
    for (let i = 0; i < 7; i++) {
      memoryDb.createMemory({
        text: `Fact number ${i} about the business.`, namespace: 'business',
        scopeType: 'global', scopeId: 'g', embedding: [i / 10],
      });
    }
    const counts = new SubjectGraphBackfill(engineDb, memoryDb).run({ pageSize: 2, includeMemories: true });
    expect(counts.memoriesMapped).toBe(7);
    expect((engineDb.getDb().prepare('SELECT COUNT(*) n FROM memories').get() as { n: number }).n).toBe(7);
    engineDb.close(); memoryDb.close();
  });
});
