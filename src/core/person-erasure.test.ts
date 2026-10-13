import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { KnowledgeLayer } from './knowledge-layer.js';
import { LocalProvider } from './embedding.js';
import { EngineDb, UndecryptableTextError } from './engine-db.js';
import { MemoryGraphStore } from './memory-graph-store.js';
import { SubjectStore } from './subject-store.js';
import { KnowledgeStore } from './knowledge-store.js';
import { DATA_DIR_INVENTORY } from './data-dir-inventory.js';
import {
  PERSON_ERASURE_NOT_COVERED, PERSON_ERASURE_REACH, erasePerson, personMatcher, previewPersonErasure,
  type PersonErasureDeps, type PersonErasurePreview, type PersonErasureResult,
} from './person-erasure.js';

/**
 * Erasing one person, on real stores: engine.db (durable entries, subjects, memory stubs) and
 * the legacy agent-memory.db. Every name here is invented.
 */
describe('person erasure', () => {
  const provider = new LocalProvider();
  const dirs: string[] = [];
  const engines: EngineDb[] = [];
  const layers: KnowledgeLayer[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const l of layers) await l.close().catch(() => {});
    for (const e of engines) { try { e.close(); } catch { /* already closed */ } }
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    layers.length = 0; engines.length = 0; dirs.length = 0;
  });

  async function setup(): Promise<{ deps: PersonErasureDeps; engine: EngineDb; layer: KnowledgeLayer; subjects: SubjectStore; knowledge: KnowledgeStore; stubs: MemoryGraphStore; raw: Database.Database }> {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-person-erasure-'));
    dirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), 'vault-key-person-erasure');
    engines.push(engine);
    const layer = new KnowledgeLayer(join(dir, 'mem.db'), provider, undefined, undefined, engine, true, true);
    layers.push(layer);
    await layer.init();
    const subjects = new SubjectStore(engine);
    const knowledge = new KnowledgeStore(engine, subjects, null);
    const deps: PersonErasureDeps = { engineDb: engine, subjects, knowledge, layer, mask: t => t };
    return { deps, engine, layer, subjects, knowledge, stubs: new MemoryGraphStore(engine), raw: engine.getDb() };
  }

  /** A memory in both stores, linked to `subjectId` through the junction when one is given. */
  function memory(f: Awaited<ReturnType<typeof setup>>, text: string, subjectId?: string): string {
    const id = f.layer.getDb().createMemory({ text, namespace: 'knowledge', scopeType: 'global', scopeId: '', embedding: [0.1, 0.2, 0.3] });
    f.stubs.upsertStub({ id, text, namespace: 'knowledge', scopeType: 'global', scopeId: '' });
    if (subjectId !== undefined) f.stubs.linkSubjects(id, [subjectId]);
    return id;
  }

  /** Anna, with a bound entry, a bound memory and an email; Bob's entry and memory mention her. */
  async function seed(): Promise<Awaited<ReturnType<typeof setup>> & {
    anna: string; bob: string; annaEntry: string; annaMemory: string; mentionEntry: string; mentionMemory: string; unrelated: string;
  }> {
    const f = await setup();
    const anna = f.subjects.createSubject({ kind: 'person', name: 'Anna Wiesental', aliases: ['Anna Wiesental', 'Anni'] });
    f.subjects.setPersonDetail(anna, { email: 'anna@wiesental.invalid', phone: '+41 00 000 00 00' });
    const bob = f.subjects.createSubject({ kind: 'person', name: 'Bob Talgrund' });
    const annaEntry = f.knowledge.write({ text: 'Prefers calls before ten', subjectName: 'Anna Wiesental', subjectKind: 'person', sourceChannel: 'user', sourceUntrusted: false }).id;
    const mentionEntry = f.knowledge.write({ text: 'Works with Anna Wiesental on the tender', subjectName: 'Bob Talgrund', subjectKind: 'person', sourceChannel: 'user', sourceUntrusted: false }).id;
    const unrelated = f.knowledge.write({ text: 'Invoices go out on the first', subjectName: 'Bob Talgrund', subjectKind: 'person', sourceChannel: 'user', sourceUntrusted: false }).id;
    const annaMemory = memory(f, 'Anna asked for the revised offer', anna);
    const mentionMemory = memory(f, 'Bob forwarded the mail from anna@wiesental.invalid', bob);
    return { ...f, anna, bob, annaEntry, annaMemory, mentionEntry, mentionMemory, unrelated };
  }

  function preview(f: { deps: PersonErasureDeps }, id: string): PersonErasurePreview {
    const p = previewPersonErasure(f.deps, id);
    if ('refused' in p) throw new Error(`refused: ${p.refused}`);
    return p;
  }

  function erased(r: ReturnType<typeof erasePerson>): PersonErasureResult {
    if ('refused' in r) throw new Error(`refused: ${r.refused}`);
    return r;
  }

  /** Rows written in the same second come back in id order, so compare as a set. */
  const pairs = (rows: ReadonlyArray<{ id: string; matchedBy: string }>): string[] => rows.map(r => `${r.id}:${r.matchedBy}`).sort();

  const entryExists = (f: { raw: Database.Database }, id: string): boolean =>
    f.raw.prepare('SELECT 1 FROM knowledge_entries WHERE id = ?').get(id) !== undefined;
  const subjectExists = (f: { raw: Database.Database }, id: string): boolean =>
    f.raw.prepare('SELECT 1 FROM subjects WHERE id = ?').get(id) !== undefined;

  it('previews what is bound to the person and, apart, what only names them', async () => {
    const f = await seed();
    const p = preview(f, f.anna);
    expect(p.subject).toEqual({ id: f.anna, name: 'Anna Wiesental', aliases: ['Anni'] });
    expect(pairs(p.entries)).toEqual(pairs([{ id: f.annaEntry, matchedBy: 'subject' }, { id: f.mentionEntry, matchedBy: 'mention' }]));
    expect(pairs(p.memories)).toEqual(pairs([{ id: f.annaMemory, matchedBy: 'subject' }, { id: f.mentionMemory, matchedBy: 'mention' }]));
    expect(p.entries.find(e => e.id === f.annaEntry)?.text).toBe('Prefers calls before ten');
    expect(p.notCovered).toEqual(PERSON_ERASURE_NOT_COVERED);
  });

  it('keeps every text out of the plan: it is derived from ids alone', async () => {
    const f = await seed();
    const before = preview(f, f.anna).plan;
    f.raw.prepare('UPDATE knowledge_entries SET text = ? WHERE id = ?').run(f.engine.enc('Prefers calls after four'), f.annaEntry);
    expect(preview(f, f.anna).plan).toBe(before);
  });

  it('erases what is bound to the person from both stores, and the person', async () => {
    const f = await seed();
    const p = preview(f, f.anna);
    const r = erased(erasePerson(f.deps, { subjectId: f.anna, plan: p.plan, entryIds: [], memoryIds: [] }));
    expect(r.erased).toBe(true);
    expect(r.done).toEqual(['durable_knowledge', 'memories_legacy', 'memories_engine', 'subject']);
    expect(r.counts).toEqual({ entries: 1, legacyMemories: 1, memoryStubs: 1, subjects: 1 });
    expect(entryExists(f, f.annaEntry)).toBe(false);
    expect(f.layer.getDb().getMemory(f.annaMemory)).toBeNull();
    expect(f.stubs.getStub(f.annaMemory)).toBeNull();
    expect(subjectExists(f, f.anna)).toBe(false);
    expect(f.subjects.getPersonDetail(f.anna)).toBeNull();
  });

  it('leaves a name match the owner did not select', async () => {
    const f = await seed();
    const p = preview(f, f.anna);
    const r = erased(erasePerson(f.deps, { subjectId: f.anna, plan: p.plan, entryIds: [], memoryIds: [] }));
    expect(entryExists(f, f.mentionEntry)).toBe(true);
    expect(f.layer.getDb().getMemory(f.mentionMemory)).not.toBeNull();
    expect(f.stubs.getStub(f.mentionMemory)).not.toBeNull();
    expect(r.left).toEqual({ entries: 1, memories: 1, blocks: [] });
    expect(entryExists(f, f.unrelated)).toBe(true);
    expect(subjectExists(f, f.bob)).toBe(true);
  });

  it('erases a name match the owner selected', async () => {
    const f = await seed();
    const p = preview(f, f.anna);
    const r = erased(erasePerson(f.deps, { subjectId: f.anna, plan: p.plan, entryIds: [f.mentionEntry], memoryIds: [f.mentionMemory] }));
    expect(r.erased).toBe(true);
    expect(entryExists(f, f.mentionEntry)).toBe(false);
    expect(f.layer.getDb().getMemory(f.mentionMemory)).toBeNull();
    expect(f.stubs.getStub(f.mentionMemory)).toBeNull();
    expect(r.left).toEqual({ entries: 0, memories: 0, blocks: [] });
    expect(entryExists(f, f.unrelated)).toBe(true);
  });

  it('refuses an id outside what the preview found, and erases nothing', async () => {
    const f = await seed();
    const p = preview(f, f.anna);
    const r = erasePerson(f.deps, { subjectId: f.anna, plan: p.plan, entryIds: [f.unrelated], memoryIds: [] });
    expect(r).toEqual({ refused: 'unknown_ids', ids: [f.unrelated] });
    const m = erasePerson(f.deps, { subjectId: f.anna, plan: p.plan, entryIds: [], memoryIds: ['no-such-memory'] });
    expect(m).toEqual({ refused: 'unknown_ids', ids: ['no-such-memory'] });
    expect(entryExists(f, f.unrelated)).toBe(true);
    expect(entryExists(f, f.annaEntry)).toBe(true);
    expect(subjectExists(f, f.anna)).toBe(true);
  });

  it('refuses when the set changed after the preview, and erases nothing', async () => {
    const f = await seed();
    const p = preview(f, f.anna);
    const late = f.knowledge.write({ text: 'Moved to the Bern office', subjectName: 'Anna Wiesental', subjectKind: 'person', sourceChannel: 'user', sourceUntrusted: false }).id;
    expect(erasePerson(f.deps, { subjectId: f.anna, plan: p.plan, entryIds: [], memoryIds: [] })).toEqual({ refused: 'plan_changed' });
    expect(entryExists(f, late)).toBe(true);
    expect(entryExists(f, f.annaEntry)).toBe(true);
    expect(subjectExists(f, f.anna)).toBe(true);
  });

  it('refuses the owner\'s own subject, a non-person and an unknown id', async () => {
    const f = await setup();
    const self = f.subjects.createSubject({ kind: 'person', name: 'Owner Selbst', isSelf: true });
    const org = f.subjects.createSubject({ kind: 'organization', name: 'Wiesental Holz' });
    expect(previewPersonErasure(f.deps, self)).toEqual({ refused: 'is_self' });
    expect(previewPersonErasure(f.deps, org)).toEqual({ refused: 'not_a_person' });
    expect(previewPersonErasure(f.deps, 'no-such-subject')).toEqual({ refused: 'not_found' });
    expect(erasePerson(f.deps, { subjectId: self, plan: 'x', entryIds: [], memoryIds: [] })).toEqual({ refused: 'is_self' });
    expect(subjectExists(f, self)).toBe(true);
  });

  it('follows a merge: a request on the merged-away id erases the canonical and its shell', async () => {
    const f = await setup();
    const canon = f.subjects.createSubject({ kind: 'person', name: 'Clara Bergli' });
    const dup = f.subjects.createSubject({ kind: 'person', name: 'C. Bergli' });
    const onDup = f.knowledge.write({ text: 'Signs the contracts', subjectName: 'C. Bergli', subjectKind: 'person', sourceChannel: 'user', sourceUntrusted: false }).id;
    const merged = f.subjects.mergeSubjects(dup, canon);
    expect(merged.ok).toBe(true);
    const p = preview(f, dup);
    expect(p.subject.id).toBe(canon);
    expect(p.subject.aliases).toContain('C. Bergli');
    expect(p.entries.map(e => [e.id, e.matchedBy])).toEqual([[onDup, 'subject']]);
    erased(erasePerson(f.deps, { subjectId: dup, plan: p.plan, entryIds: [], memoryIds: [] }));
    expect(subjectExists(f, canon)).toBe(false);
    expect(subjectExists(f, dup)).toBe(false);
    expect(entryExists(f, onDup)).toBe(false);
  });

  it('shows an unresolved hint as a name match, not as bound', async () => {
    const f = await seed();
    const hinted = f.raw.prepare('SELECT id FROM knowledge_entries WHERE id = ?').get(f.unrelated) as { id: string };
    f.raw.prepare('UPDATE knowledge_entries SET subject_id = NULL, subject_hint = ? WHERE id = ?').run('anni', hinted.id);
    const p = preview(f, f.anna);
    expect(p.entries.find(e => e.id === hinted.id)?.matchedBy).toBe('hint');
    erased(erasePerson(f.deps, { subjectId: f.anna, plan: p.plan, entryIds: [], memoryIds: [] }));
    expect(entryExists(f, hinted.id)).toBe(true);
  });

  it('names an always-loaded block that mentions the person, without editing it', async () => {
    const f = await seed();
    f.knowledge.setBlockContent('playbook', 'Copy Anni on every offer.');
    const p = preview(f, f.anna);
    expect(p.blocksMentioning).toEqual(['playbook']);
    const r = erased(erasePerson(f.deps, { subjectId: f.anna, plan: p.plan, entryIds: [], memoryIds: [] }));
    expect(r.left.blocks).toEqual(['playbook']);
    expect(f.knowledge.getBlock('playbook')?.content).toBe('Copy Anni on every offer.');
  });

  it('throws instead of answering "nothing found" when a stored text cannot be decrypted', async () => {
    const f = await seed();
    const foreign = new EngineDb(join(dirs[0]!, 'foreign.db'), 'another-vault-key');
    engines.push(foreign);
    f.raw.prepare('UPDATE knowledge_entries SET text = ? WHERE id = ?').run(foreign.enc('Works with Anna Wiesental'), f.unrelated);
    expect(() => previewPersonErasure(f.deps, f.anna)).toThrow(UndecryptableTextError);
    expect(() => erasePerson(f.deps, { subjectId: f.anna, plan: 'x', entryIds: [], memoryIds: [] })).toThrow(UndecryptableTextError);
    expect(subjectExists(f, f.anna)).toBe(true);
  });

  it('throws the same for a memory stub it cannot decrypt', async () => {
    const f = await seed();
    const foreign = new EngineDb(join(dirs[0]!, 'foreign.db'), 'another-vault-key');
    engines.push(foreign);
    f.raw.prepare('UPDATE memories SET text = ? WHERE id = ?').run(foreign.enc('Bob forwarded the mail'), f.mentionMemory);
    expect(() => previewPersonErasure(f.deps, f.anna)).toThrow(UndecryptableTextError);
  });

  it('refuses before the first step when the audit row cannot be written', async () => {
    const f = await seed();
    const p = preview(f, f.anna);
    const r = erasePerson(f.deps, { subjectId: f.anna, plan: p.plan, entryIds: [], memoryIds: [], beforeErase: () => { throw new Error('log down'); } });
    expect(r).toEqual({ refused: 'audit_unavailable' });
    expect(entryExists(f, f.annaEntry)).toBe(true);
    expect(subjectExists(f, f.anna)).toBe(true);
  });

  it('hands the audit hook the counts it will erase', async () => {
    const f = await seed();
    const p = preview(f, f.anna);
    const seen: Array<{ entries: number; memories: number }> = [];
    erased(erasePerson(f.deps, { subjectId: f.anna, plan: p.plan, entryIds: [f.mentionEntry], memoryIds: [], beforeErase: c => { seen.push(c); } }));
    expect(seen).toEqual([{ entries: 2, memories: 1 }]);
  });

  it('stops at a failed legacy step, and a new preview and erase finish it', async () => {
    const f = await seed();
    const p = preview(f, f.anna);
    vi.spyOn(f.layer, 'purgeLegacyMemoriesForErasure').mockImplementationOnce(() => { throw new Error('disk I/O error'); });
    const r = erased(erasePerson(f.deps, { subjectId: f.anna, plan: p.plan, entryIds: [], memoryIds: [] }));
    expect(r).toMatchObject({ erased: false, done: ['durable_knowledge'], failed: 'memories_legacy', error: 'disk I/O error' });
    expect(entryExists(f, f.annaEntry)).toBe(false);
    expect(f.layer.getDb().getMemory(f.annaMemory)).not.toBeNull();
    expect(f.stubs.getStub(f.annaMemory)).not.toBeNull();
    expect(subjectExists(f, f.anna)).toBe(true);

    const again = preview(f, f.anna);
    expect(again.memories.find(m => m.id === f.annaMemory)?.matchedBy).toBe('subject');
    const done = erased(erasePerson(f.deps, { subjectId: f.anna, plan: again.plan, entryIds: [], memoryIds: [] }));
    expect(done.erased).toBe(true);
    expect(f.layer.getDb().getMemory(f.annaMemory)).toBeNull();
    expect(f.stubs.getStub(f.annaMemory)).toBeNull();
    expect(subjectExists(f, f.anna)).toBe(false);
  });

  it('stops at a failed engine.db step with the legacy row gone, and a retry still finds the stub', async () => {
    const f = await seed();
    const p = preview(f, f.anna);
    vi.spyOn(f.layer, 'purgeMemoryStubsForErasure').mockImplementationOnce(() => { throw new Error('database is locked'); });
    const r = erased(erasePerson(f.deps, { subjectId: f.anna, plan: p.plan, entryIds: [f.mentionEntry], memoryIds: [f.mentionMemory] }));
    expect(r).toMatchObject({ erased: false, done: ['durable_knowledge', 'memories_legacy'], failed: 'memories_engine' });
    expect(f.layer.getDb().getMemory(f.annaMemory)).toBeNull();
    expect(f.stubs.getStub(f.annaMemory)).not.toBeNull();
    expect(subjectExists(f, f.anna)).toBe(true);

    // Bound by the junction, and the selected mention by its stub text, read in engine.db.
    const again = preview(f, f.anna);
    expect(pairs(again.memories)).toEqual(pairs([{ id: f.annaMemory, matchedBy: 'subject' }, { id: f.mentionMemory, matchedBy: 'mention' }]));
    erased(erasePerson(f.deps, { subjectId: f.anna, plan: again.plan, entryIds: [], memoryIds: [f.mentionMemory] }));
    expect(f.stubs.getStub(f.annaMemory)).toBeNull();
    expect(f.stubs.getStub(f.mentionMemory)).toBeNull();
    expect(subjectExists(f, f.anna)).toBe(false);
  });

  it('stops at a failed subject step with the memories gone, and a retry erases the person', async () => {
    const f = await seed();
    const p = preview(f, f.anna);
    vi.spyOn(f.subjects, 'eraseSubject').mockImplementationOnce(() => { throw new Error('constraint failed'); });
    const r = erased(erasePerson(f.deps, { subjectId: f.anna, plan: p.plan, entryIds: [], memoryIds: [] }));
    expect(r).toMatchObject({ erased: false, done: ['durable_knowledge', 'memories_legacy', 'memories_engine'], failed: 'subject' });
    expect(subjectExists(f, f.anna)).toBe(true);
    const again = preview(f, f.anna);
    expect(erased(erasePerson(f.deps, { subjectId: f.anna, plan: again.plan, entryIds: [], memoryIds: [] })).erased).toBe(true);
    expect(subjectExists(f, f.anna)).toBe(false);
  });
});

describe('personMatcher', () => {
  it('matches whole words, case-insensitive', () => {
    const m = personMatcher(['Anna Wiesental', 'anna@wiesental.invalid']);
    expect(m('met anna wiesental today')).toBe(true);
    expect(m('mail ANNA@WIESENTAL.INVALID')).toBe(true);
    expect(m('Anna Wiesentaler')).toBe(false);
    expect(m('xAnna Wiesental')).toBe(false);
  });

  it('ignores forms too short to search', () => {
    const m = personMatcher(['Al', ' ']);
    expect(m('Al said so')).toBe(false);
  });
});

describe('PERSON_ERASURE_REACH', () => {
  it('decides every data-dir entry the full erasure handles, and names nothing else', () => {
    const erasable = DATA_DIR_INVENTORY.filter(e => e.erase.by !== 'keep').map(e => e.name).sort();
    expect(Object.keys(PERSON_ERASURE_REACH).sort()).toEqual(erasable);
  });

  it('uses every key it lists as not covered, except the downloaded exports, which live off the box', () => {
    const used = new Set<string>();
    for (const v of Object.values(PERSON_ERASURE_REACH)) if (Array.isArray(v)) for (const k of v) used.add(k);
    expect(PERSON_ERASURE_NOT_COVERED.filter(k => !used.has(k))).toEqual(['exports']);
  });
});
