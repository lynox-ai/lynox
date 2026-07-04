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

  it('setParent sets, clears, and rejects a self-parent (Context-Hierarchy Scoping Slice A)', () => {
    const { store, engine } = makeStore();
    const kunde = store.findOrCreate({ kind: 'organization', name: 'Kunde X' });
    const projekt = store.createSubject({ kind: 'engagement', name: 'Projekt A' });
    expect(store.getSubject(projekt)?.parent_id).toBe(null); // no parent at insert
    // set the Projekt→Kunde hierarchy edge (the walk-up substrate)
    store.setParent(projekt, kunde.id);
    expect(store.getSubject(projekt)?.parent_id).toBe(kunde.id);
    // clear with null
    store.setParent(projekt, null);
    expect(store.getSubject(projekt)?.parent_id).toBe(null);
    // the 1-cycle (self-parent) is rejected
    expect(() => store.setParent(projekt, projekt)).toThrow(/own parent/);
    // a non-existent parent is rejected by the parent_id self-FK (foreign_keys=ON) — no dangling ref
    expect(() => store.setParent(projekt, 'ghost-subject-id')).toThrow();
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

  it('does NOT name-dedup engagement (identity is provider×client×period, not the name)', () => {
    const { store, engine } = makeStore();
    const a = store.findOrCreate({ kind: 'engagement', name: 'Website Redesign' });
    const b = store.findOrCreate({ kind: 'engagement', name: 'Website Redesign' });
    expect(b.created).toBe(true);
    expect(b.id).not.toBe(a.id);
    expect(store.listSubjects({ kind: 'engagement' })).toHaveLength(2);
    engine.close();
  });

  it('name-dedups product and service (catalogue identity is the name, case-insensitive)', () => {
    const { store, engine } = makeStore();
    const p1 = store.findOrCreate({ kind: 'product', name: 'Widget Pro' });
    const p2 = store.findOrCreate({ kind: 'product', name: 'widget pro' });
    expect(p2.created).toBe(false);
    expect(p2.id).toBe(p1.id);
    expect(store.listSubjects({ kind: 'product' })).toHaveLength(1);

    const s1 = store.findOrCreate({ kind: 'service', name: 'SEO Retainer' });
    const s2 = store.findOrCreate({ kind: 'service', name: 'SEO Retainer' });
    expect(s2.created).toBe(false);
    expect(s2.id).toBe(s1.id);
    // a product and a service of the same name are distinct (dedup is per-kind)
    const px = store.findOrCreate({ kind: 'product', name: 'SEO Retainer' });
    expect(px.created).toBe(true);
    expect(px.id).not.toBe(s1.id);
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

  it('person detail upsert MERGES — an omitted field is preserved, not nulled', () => {
    const { store, engine } = makeStore('k');
    const { id } = store.findOrCreate({ kind: 'person', name: 'Pat Lee' });
    store.setPersonDetail(id, { email: 'pat@x.com', phone: '+41790000000', type: 'customer' });
    // A later incremental call setting only role must NOT wipe email/phone/type.
    store.setPersonDetail(id, { role: 'CEO' });
    const d = store.getPersonDetail(id)!;
    expect(d.email).toBe('pat@x.com');
    expect(d.phone).toBe('+41790000000');
    expect(d.type).toBe('customer');
    expect(d.role).toBe('CEO');
    engine.close();
  });

  it('organization detail: vat_id encrypted at rest, domain plaintext, merge-preserving', () => {
    const { store, engine } = makeStore('k');
    const { id } = store.findOrCreate({ kind: 'organization', name: 'Globex' });
    store.setOrganizationDetail(id, { domain: 'globex.example', vat_id: 'CHE-123.456.789', country: 'CH', type: 'customer' });
    const raw = engine.getDb().prepare('SELECT domain, vat_id FROM organizations WHERE subject_id = ?').get(id) as { domain: string; vat_id: string };
    expect(raw.domain).toBe('globex.example');        // plaintext (public-ish + lookup key)
    expect(raw.vat_id).toMatch(/^enc:/);              // PII → encrypted
    expect(raw.vat_id).not.toContain('CHE-123');
    const d = store.getOrganizationDetail(id)!;
    expect(d.vat_id).toBe('CHE-123.456.789');         // decrypted on read
    expect(d.type).toBe('customer');
    // merge: setting only country preserves domain/vat/type
    store.setOrganizationDetail(id, { country: 'DE' });
    const d2 = store.getOrganizationDetail(id)!;
    expect(d2.country).toBe('DE');
    expect(d2.domain).toBe('globex.example');
    expect(d2.vat_id).toBe('CHE-123.456.789');
    engine.close();
  });

  it('findByAlias does not false-match a substring of a longer alias', () => {
    const { store, engine } = makeStore();
    store.findOrCreate({ kind: 'person', name: 'Bobby Tables', aliases: ['Bobby Tables', 'Bobby'] });
    // 'Bob' is a substring of the alias 'Bobby' but NOT an alias → must create new.
    const r = store.findOrCreate({ kind: 'person', name: 'Bob' });
    expect(r.created).toBe(true);
    engine.close();
  });

  it('round-trips create params (isSelf/parentId/status) and returns null for a missing id', () => {
    const { store, engine } = makeStore();
    const parent = store.findOrCreate({ kind: 'organization', name: 'Holding' }).id;
    const childId = store.createSubject({ kind: 'organization', name: 'Subsidiary', isSelf: true, parentId: parent, status: 'active' });
    const row = store.getSubject(childId)!;
    expect(row.is_self).toBe(1);
    expect(row.parent_id).toBe(parent);
    expect(row.status).toBe('active');
    expect(store.getSubject('nope')).toBeNull();
    engine.close();
  });
});

describe('SubjectStore S4a — self-person + assignee resolution', () => {
  const tmpDirs: string[] = [];
  const engines: EngineDb[] = [];

  function makeStore(): { store: SubjectStore; engine: EngineDb } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-subj4-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    engines.push(engine);
    return { store: new SubjectStore(engine), engine };
  }

  afterEach(() => {
    for (const e of engines) { try { e.close(); } catch { /* already closed */ } }
    engines.length = 0;
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it('findOrCreateSelfPerson is an idempotent singleton (one is_self person)', () => {
    const { store } = makeStore();
    const a = store.findOrCreateSelfPerson();
    const b = store.findOrCreateSelfPerson();
    expect(b).toBe(a);
    expect(store.listSubjects({ kind: 'person' })).toHaveLength(1);
    expect(store.findSelfPerson()?.id).toBe(a);
    expect(store.findSelfPerson()?.is_self).toBe(1);
  });

  it("the self-person seed does NOT merge into a same-named person subject", () => {
    const { store } = makeStore();
    // a real person happens to carry the display sentinel name
    const other = store.findOrCreate({ kind: 'person', name: 'Me' });
    const self = store.findOrCreateSelfPerson();
    expect(self).not.toBe(other.id);        // distinct rows (seed bypasses name-dedup)
    expect(store.findSelfPerson()?.id).toBe(self);
  });

  it('resolveAssigneeToSubjectId: user→self, name→person, null/empty→null', () => {
    const { store } = makeStore();
    const self = store.resolveAssigneeToSubjectId('user');
    expect(self).toBe(store.findSelfPerson()?.id);
    const person = store.resolveAssigneeToSubjectId('Sarah');
    expect(store.getSubject(person!)?.name).toBe('Sarah');
    expect(store.resolveAssigneeToSubjectId(null)).toBeNull();
    expect(store.resolveAssigneeToSubjectId('')).toBeNull();
    expect(store.resolveAssigneeToSubjectId('  ')).toBeNull();
  });

  it('resolveAssigneeToSubjectId dedups a repeated named assignee', () => {
    const { store } = makeStore();
    const a = store.resolveAssigneeToSubjectId('Bob');
    const b = store.resolveAssigneeToSubjectId('bob'); // case-insensitive canonical
    expect(b).toBe(a);
  });

  it('resolveAssigneeFilter never creates: unseeded → null, else the existing match', () => {
    const { store } = makeStore();
    expect(store.resolveAssigneeFilter('user')).toBeNull();   // no self-person yet
    expect(store.resolveAssigneeFilter('Ghost')).toBeNull();  // no such person
    expect(store.listSubjects()).toHaveLength(0);             // filter minted nothing
    // once they exist, the filter resolves to them
    const self = store.findOrCreateSelfPerson();
    const sarah = store.resolveAssigneeToSubjectId('Sarah');
    expect(store.resolveAssigneeFilter('user')).toBe(self);
    expect(store.resolveAssigneeFilter('Sarah')).toBe(sarah);
  });
});
