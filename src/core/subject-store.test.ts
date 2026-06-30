import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { SubjectStore } from './subject-store.js';

describe('SubjectStore (Foundation Rework v2 — S1a)', () => {
  const tmpDirs: string[] = [];

  function makeStore(key = ''): { store: SubjectStore; engine: EngineDb } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-subj-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), key);
    return { store: new SubjectStore(engine), engine };
  }

  afterEach(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it('findOrCreate dedups person/organization by canonical name (case-insensitive)', () => {
    const { store, engine } = makeStore();
    const a = store.findOrCreate({ kind: 'organization', name: 'Acme Industries' });
    expect(a.created).toBe(true);
    const b = store.findOrCreate({ kind: 'organization', name: 'acme industries' });
    expect(b.created).toBe(false);
    expect(b.id).toBe(a.id);
    // exactly one row
    expect(store.listSubjects({ kind: 'organization' })).toHaveLength(1);
    engine.close();
  });

  it('findOrCreate dedups via alias', () => {
    const { store, engine } = makeStore();
    const a = store.findOrCreate({ kind: 'person', name: 'Robert Smith', aliases: ['Robert Smith', 'Bob Smith'] });
    const b = store.findOrCreate({ kind: 'person', name: 'bob smith' });
    expect(b.created).toBe(false);
    expect(b.id).toBe(a.id);
    engine.close();
  });

  it('folds genuinely-new alias surface forms on dedup, without case-variant dups', () => {
    const { store, engine } = makeStore();
    const a = store.findOrCreate({ kind: 'organization', name: 'Globex' });
    // A bare case-variant adds nothing — 'GLOBEX' is already covered by 'Globex'.
    store.findOrCreate({ kind: 'organization', name: 'GLOBEX' });
    expect(JSON.parse(store.getSubject(a.id)!.aliases)).toEqual(['Globex']);
    // A genuinely-new surface form IS folded into the existing subject.
    store.findOrCreate({ kind: 'organization', name: 'Globex', aliases: ['GBX Inc'] });
    const aliases = JSON.parse(store.getSubject(a.id)!.aliases) as string[];
    expect(aliases).toContain('Globex');
    expect(aliases).toContain('GBX Inc');
    engine.close();
  });

  it('does NOT name-dedup engagement/product (identity is not the name)', () => {
    const { store, engine } = makeStore();
    const a = store.findOrCreate({ kind: 'engagement', name: 'Website Redesign' });
    const b = store.findOrCreate({ kind: 'engagement', name: 'Website Redesign' });
    expect(b.created).toBe(true);
    expect(b.id).not.toBe(a.id);
    expect(store.listSubjects({ kind: 'engagement' })).toHaveLength(2);
    engine.close();
  });

  it('encrypts people.email/phone at rest but keeps subjects.name plaintext', () => {
    const { store, engine } = makeStore('vault-key-for-subjects-1');
    const { id } = store.findOrCreate({ kind: 'person', name: 'Jane Roe' });
    store.setPersonDetail(id, { email: 'jane@example.com', phone: '+41791234567', type: 'customer' });

    // Raw row: name is plaintext (indexable), email/phone are ciphertext.
    const rawSubject = engine.getDb().prepare('SELECT name FROM subjects WHERE id = ?').get(id) as { name: string };
    expect(rawSubject.name).toBe('Jane Roe');
    const rawPerson = engine.getDb().prepare('SELECT email, phone FROM people WHERE subject_id = ?').get(id) as { email: string; phone: string };
    expect(rawPerson.email).toMatch(/^enc:/);
    expect(rawPerson.email).not.toContain('jane@example.com');
    expect(rawPerson.phone).toMatch(/^enc:/);

    // Read back through the store: decrypted.
    const detail = store.getPersonDetail(id)!;
    expect(detail.email).toBe('jane@example.com');
    expect(detail.phone).toBe('+41791234567');
    expect(detail.type).toBe('customer');
    engine.close();
  });

  it('upserts detail without duplicating the row', () => {
    const { store, engine } = makeStore('k');
    const { id } = store.findOrCreate({ kind: 'person', name: 'Sam Doe' });
    store.setPersonDetail(id, { email: 'a@x.com' });
    store.setPersonDetail(id, { email: 'b@x.com', role: 'CTO' });
    expect(store.getPersonDetail(id)!.email).toBe('b@x.com');
    expect(store.getPersonDetail(id)!.role).toBe('CTO');
    expect(engine.getDb().prepare("SELECT COUNT(*) c FROM people WHERE subject_id = ?").get(id)).toMatchObject({ c: 1 });
    engine.close();
  });

  it('archiving frees the canonical dedup slot', () => {
    const { store, engine } = makeStore();
    const a = store.findOrCreate({ kind: 'organization', name: 'Initech' });
    store.archiveSubject(a.id);
    const b = store.findOrCreate({ kind: 'organization', name: 'Initech' });
    expect(b.created).toBe(true);          // archived row no longer blocks
    expect(b.id).not.toBe(a.id);
    expect(store.listSubjects({ kind: 'organization' })).toHaveLength(1);             // active only
    expect(store.listSubjects({ kind: 'organization', includeArchived: true })).toHaveLength(2);
    engine.close();
  });

  it('scopes dedup by owner_user_id', () => {
    const { store, engine } = makeStore();
    const a = store.findOrCreate({ kind: 'organization', name: 'Umbrella', ownerUserId: 'u1' });
    const b = store.findOrCreate({ kind: 'organization', name: 'Umbrella', ownerUserId: 'u2' });
    expect(b.created).toBe(true);
    expect(b.id).not.toBe(a.id);
    engine.close();
  });
});
