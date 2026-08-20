import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { SubjectStore, makeSubjectColumnBridge, NAME_DEDUPED_SUBJECT_KINDS, normalizeSubjectName } from './subject-store.js';
import { DataStore } from './data-store.js';
import type { DataStoreSubjectKind } from '../types/index.js';

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

  // ── getAncestors — the Slice C context-scoping walk-up ──────────
  describe('getAncestors (Context-Hierarchy Scoping — Slice C)', () => {
    it('walks parent_id up, nearest-first, excluding the subject itself', () => {
      const { store } = makeStore();
      const kunde = store.findOrCreate({ kind: 'organization', name: 'Kunde X' }).id;
      const projekt = store.createSubject({ kind: 'engagement', name: 'Projekt A', parentId: kunde });
      const task = store.createSubject({ kind: 'other', name: 'Sub-task', parentId: projekt });

      const anc = store.getAncestors(task);
      expect(anc.map(s => s.id)).toEqual([projekt, kunde]); // parent, then grandparent
      expect(anc.map(s => s.name)).toEqual(['Projekt A', 'Kunde X']);
    });

    it('returns [] for a root subject (no parent) and for an unknown id', () => {
      const { store } = makeStore();
      const root = store.findOrCreate({ kind: 'organization', name: 'Root Co' }).id;
      expect(store.getAncestors(root)).toEqual([]);
      expect(store.getAncestors('ghost-id')).toEqual([]);
    });

    it('is cycle-safe — a parent_id loop across several setParent calls terminates', () => {
      const { store } = makeStore();
      // Build A→B→C then close the loop C→A (each edge legal on its own; the cycle
      // only exists across the calls — exactly what setParent cannot catch alone).
      const a = store.createSubject({ kind: 'other', name: 'A' });
      const b = store.createSubject({ kind: 'other', name: 'B', parentId: a });
      const c = store.createSubject({ kind: 'other', name: 'C', parentId: b });
      store.setParent(a, c); // A's parent = C → cycle A→C→B→A

      const anc = store.getAncestors(a);
      // Terminates (no infinite loop / hang) and never revisits the start.
      expect(anc.map(s => s.id)).toEqual([c, b]); // stops when it would revisit A
      expect(anc.map(s => s.id)).not.toContain(a);
    });

    it('honours the depth cap on a long chain', () => {
      const { store } = makeStore();
      let prev: string | null = null;
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        const id: string = prev
          ? store.createSubject({ kind: 'other', name: `N${i}`, parentId: prev })
          : store.createSubject({ kind: 'other', name: `N${i}` });
        ids.push(id);
        prev = id;
      }
      const leaf = ids[ids.length - 1]!;
      // Full chain (9 ancestors) with a generous cap …
      expect(store.getAncestors(leaf)).toHaveLength(9);
      // … but a tight cap bounds the walk.
      expect(store.getAncestors(leaf, 3)).toHaveLength(3);
    });

    it('ends the walk cleanly at a dangling parent ref (purged ancestor)', () => {
      const { store, engine } = makeStore();
      const kunde = store.findOrCreate({ kind: 'organization', name: 'Kunde Y' }).id;
      const projekt = store.createSubject({ kind: 'engagement', name: 'Projekt B', parentId: kunde });
      // Simulate a purged parent: drop the FK to allow an orphaned parent_id, then
      // hard-delete the ancestor so getSubject(parent_id) returns null mid-walk.
      engine.getDb().pragma('foreign_keys = OFF');
      engine.getDb().prepare('DELETE FROM subjects WHERE id = ?').run(kunde);
      expect(store.getAncestors(projekt)).toEqual([]); // walk ends, no throw
    });
  });

  // The exact bridge the engine injects into DataStore (Record-on-spine), tested
  // end-to-end against a REAL SubjectStore + REAL DataStore — the wiring coverage:
  // a subject column stores a real subject_id (write), filters + displays by name
  // (query), an unknown kind hits the defensive floor, and find is get-ONLY.
  describe('makeSubjectColumnBridge (Record-on-spine R1/R1.5 wiring)', () => {
    function makeWired(): { store: SubjectStore; engine: EngineDb; ds: DataStore } {
      const dir = mkdtempSync(join(tmpdir(), 'lynox-subj-ds-'));
      tmpDirs.push(dir);
      const engine = new EngineDb(join(dir, 'engine.db'), '');
      const store = new SubjectStore(engine);
      const ds = new DataStore(join(dir, 'datastore.db'));
      ds.setSubjectBridge(makeSubjectColumnBridge(store));
      return { store, engine, ds };
    }

    function seedAppointments(ds: DataStore): void {
      ds.createCollection({
        name: 'appointments',
        scope: { type: 'context', id: '' },
        columns: [
          { name: 'note', type: 'string' },
          { name: 'patient', type: 'subject', subjectKind: 'person' },
        ],
      });
      ds.insertRecords({
        collection: 'appointments',
        records: [
          { note: 'first', patient: 'Anna Meier' },
          { note: 'again', patient: 'anna meier' }, // case-variant → same subject
        ],
      });
    }

    it('stores a real subject_id and dedups the same identity to one subject', () => {
      const { store, engine, ds } = makeWired();
      seedAppointments(ds);

      const { rows } = ds.queryRecords({ collection: 'appointments', sort: [{ field: '_id', order: 'asc' }] });
      const id = rows[0]!['patient'] as string;
      // Resolved to a real subject row of the declared kind.
      expect(store.getSubject(id)?.kind).toBe('person');
      expect(store.getSubject(id)?.name).toBe('Anna Meier');
      // Dedup: both rows point at the one subject; exactly one person exists.
      expect(rows[1]!['patient']).toBe(id);
      expect(store.listSubjects({ kind: 'person' })).toHaveLength(1);
      ds.close();
      engine.close();
    });

    it('filters by name (case-insensitive) and hydrates the canonical name (round-trip)', () => {
      const { engine, ds } = makeWired();
      seedAppointments(ds);

      const { rows, total } = ds.queryRecords({
        collection: 'appointments',
        filter: { patient: 'anna meier' }, // lower-case surface form
        subjectsByName: true,
        sort: [{ field: '_id', order: 'asc' }],
      });
      // Both Anna rows match the one subject; cells show the CANONICAL name.
      expect(total).toBe(2);
      expect(rows.every(r => r['patient'] === 'Anna Meier')).toBe(true);
      ds.close();
      engine.close();
    });

    it('filtering an unknown name returns 0 rows and mints NO subject (find is get-only)', () => {
      const { store, engine, ds } = makeWired();
      seedAppointments(ds);

      const { total } = ds.queryRecords({
        collection: 'appointments',
        filter: { patient: 'Nobody Here' },
        subjectsByName: true,
      });
      expect(total).toBe(0);
      // The graph is unchanged — a filter must never create a subject.
      expect(store.listSubjects({ kind: 'person' })).toHaveLength(1);
      ds.close();
      engine.close();
    });

    it('floors an unknown kind to person rather than throwing', () => {
      const { store } = makeWired();
      const bridge = makeSubjectColumnBridge(store);
      const id = bridge.resolve('Mystery', 'not_a_real_kind');
      expect(store.getSubject(id!)?.kind).toBe('person');
    });
  });

  // F8 drift guard: the subject-column kind list is stated in TWO places — the
  // runtime NAME_DEDUPED_SUBJECT_KINDS (SoT here) and the config-leaf type
  // DataStoreSubjectKind (can't import core). If they diverge, a subject column
  // could offer a kind the resolver can't dedup (the exact trap R1 closes).
  describe('subject-column kind list stays in sync', () => {
    it('config DataStoreSubjectKind matches the runtime NAME_DEDUPED_SUBJECT_KINDS', () => {
      // Runtime: exactly the four name-deduped kinds (order-independent).
      expect([...NAME_DEDUPED_SUBJECT_KINDS].sort()).toEqual(['organization', 'person', 'product', 'service']);
      // Compile-time: config type and runtime list must be mutually assignable —
      // this resolves to `true` only if neither side has drifted, else `never`
      // (and `const _: never = true` fails to typecheck).
      type BothWays =
        [DataStoreSubjectKind] extends [(typeof NAME_DEDUPED_SUBJECT_KINDS)[number]]
          ? ([(typeof NAME_DEDUPED_SUBJECT_KINDS)[number]] extends [DataStoreSubjectKind] ? true : never)
          : never;
      const bidirectional: BothWays = true;
      expect(bidirectional).toBe(true);
    });
  });
});

describe('normalizeSubjectName (M4 subject-dedup)', () => {
  it('trims, collapses whitespace, strips trailing punctuation', () => {
    expect(normalizeSubjectName('organization', '  Meridian   AG  ')).toBe('Meridian AG');
    expect(normalizeSubjectName('organization', 'Meridian AG.')).toBe('Meridian AG');
    expect(normalizeSubjectName('person', 'Maria Keller!')).toBe('Maria Keller');
  });
  it('strips a leading generic project word for engagements only', () => {
    expect(normalizeSubjectName('engagement', 'Projekt Orion')).toBe('Orion');
    expect(normalizeSubjectName('engagement', 'Project Alpha')).toBe('Alpha');
    expect(normalizeSubjectName('engagement', 'Projet Lune')).toBe('Lune');   // French
    expect(normalizeSubjectName('engagement', 'PROJEKT Orion')).toBe('Orion'); // case-insensitive
    expect(normalizeSubjectName('engagement', 'Projekt: Vega')).toBe('Vega');
    // NOT an engagement → the leading word is kept.
    expect(normalizeSubjectName('organization', 'Project Alpha')).toBe('Project Alpha');
    // A name that IS just the generic word (or starts without a separator) is kept.
    expect(normalizeSubjectName('engagement', 'Projekt')).toBe('Projekt');
    expect(normalizeSubjectName('engagement', 'Projektron')).toBe('Projektron');
  });
  it('never returns empty', () => {
    expect(normalizeSubjectName('engagement', '   ')).toBe('');   // trimmed input is empty → returns it
    expect(normalizeSubjectName('person', '...')).toBe('...');    // all-punct → falls back to trimmed input
  });
});

describe('SubjectStore.findOrCreateEngagement (M4 subject-dedup)', () => {
  const tmpDirs: string[] = [];
  function makeStore(): { store: SubjectStore; engine: EngineDb } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-eng-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    return { store: new SubjectStore(engine), engine };
  }
  afterEach(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it('dedups the same project name to one row', () => {
    const { store, engine } = makeStore();
    const org = store.findOrCreate({ kind: 'organization', name: 'Kunde A' }).id;
    const a = store.findOrCreateEngagement('Website', org);
    const b = store.findOrCreateEngagement('Website', org);
    expect(b.created).toBe(false);
    expect(b.id).toBe(a.id);
    expect(store.listSubjects({ kind: 'engagement' })).toHaveLength(1);
    engine.close();
  });

  it('converges "Projekt Orion" and "Orion" onto one row (normalized name + alias)', () => {
    const { store, engine } = makeStore();
    const org = store.findOrCreate({ kind: 'organization', name: 'Kunde A' }).id;
    const a = store.findOrCreateEngagement('Projekt Orion', org);
    const b = store.findOrCreateEngagement('Orion', org);
    expect(b.id).toBe(a.id);
    expect(store.listSubjects({ kind: 'engagement' })).toHaveLength(1);
    // canonical name is the normalized form; the surface form is kept as an alias.
    const row = store.getSubject(a.id)!;
    expect(row.name).toBe('Orion');
    expect(JSON.parse(row.aliases) as string[]).toContain('Projekt Orion');
    engine.close();
  });

  it('keeps the SAME project name under DIFFERENT clients as two distinct rows (isolation)', () => {
    const { store, engine } = makeStore();
    const orgA = store.findOrCreate({ kind: 'organization', name: 'Kunde A' }).id;
    const orgB = store.findOrCreate({ kind: 'organization', name: 'Kunde B' }).id;
    const a = store.findOrCreateEngagement('Website', orgA);
    const b = store.findOrCreateEngagement('Website', orgB);
    expect(b.id).not.toBe(a.id);
    expect(store.listSubjects({ kind: 'engagement' })).toHaveLength(2);
    engine.close();
  });

  it('adopts an unparented same-named project under the given client', () => {
    const { store, engine } = makeStore();
    // Extraction created it unparented (no anchor yet).
    const orphan = store.findOrCreateEngagement('Orion', null);
    expect(store.getSubject(orphan.id)!.parent_id).toBeNull();
    // Later a client is known → adopt the orphan, don't mint a new row.
    const org = store.findOrCreate({ kind: 'organization', name: 'Kunde A' }).id;
    const adopted = store.findOrCreateEngagement('Orion', org);
    expect(adopted.id).toBe(orphan.id);
    expect(store.getSubject(orphan.id)!.parent_id).toBe(org);
    expect(store.listSubjects({ kind: 'engagement' })).toHaveLength(1);
    engine.close();
  });

  it('does NOT attribute an unanchored (null-parent) extraction resolve to an arbitrary client', () => {
    const { store, engine } = makeStore();
    const orgA = store.findOrCreate({ kind: 'organization', name: 'Kunde A' }).id;
    store.findOrCreateEngagement('Orion', orgA);   // "Orion" exists ONLY under client A
    // Extraction has no human gate → a bare "Orion" mention with no anchor must NOT
    // silently reuse client A's project; it gets a fresh UNPARENTED row (isolation).
    const bare = store.findOrCreateEngagement('Orion', null);
    expect(bare.created).toBe(true);
    expect(store.getSubject(bare.id)!.parent_id).toBeNull();
    expect(store.listSubjects({ kind: 'engagement' })).toHaveLength(2);
    engine.close();
  });

  it('the human-confirmed tool path MAY reuse a client-parented row on a null-parent resolve', () => {
    const { store, engine } = makeStore();
    const orgA = store.findOrCreate({ kind: 'organization', name: 'Kunde A' }).id;
    const under = store.findOrCreateEngagement('Orion', orgA);
    // set_thread_context({project:'Orion'}) with no customer → opt-in reuses A's row
    // (the handler names client A back to the user), no new row.
    const viaTool = store.findOrCreateEngagement('Orion', null, { allowParentedReuseOnNullParent: true });
    expect(viaTool.id).toBe(under.id);
    expect(store.listSubjects({ kind: 'engagement' })).toHaveLength(1);
    engine.close();
  });

  it('normalize-fallback in findOrCreate converges trailing-punct org variants', () => {
    const { store, engine } = makeStore();
    const a = store.findOrCreate({ kind: 'organization', name: 'Meridian AG' });
    const b = store.findOrCreate({ kind: 'organization', name: 'Meridian AG.' });
    expect(b.id).toBe(a.id);
    expect(store.listSubjects({ kind: 'organization' })).toHaveLength(1);
    engine.close();
  });
});

describe('findByNameAnyKind — one name, any kind', () => {
  const tmpDirs: string[] = [];
  afterEach(() => { for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  function make(): SubjectStore {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-anykind-'));
    tmpDirs.push(dir);
    return new SubjectStore(new EngineDb(join(dir, 'engine.db'), ''));
  }

  it('unknown name → null, single product → its row with its kind', () => {
    const s = make();
    expect(s.findByNameAnyKind('Nobody')).toEqual({ ambiguous: false, row: null });
    s.findOrCreate({ kind: 'product', name: 'Vireo' });
    const r = s.findByNameAnyKind('Vireo');
    expect(!r.ambiguous && r.row?.kind).toBe('product');
  });

  it('the same name under two kinds is AMBIGUOUS with both candidates', () => {
    const s = make();
    const p = s.findOrCreate({ kind: 'product', name: 'Wikipedia' });
    const o = s.findOrCreate({ kind: 'organization', name: 'Wikipedia' });
    const r = s.findByNameAnyKind('Wikipedia');
    expect(r.ambiguous).toBe(true);
    if (r.ambiguous) {
      const want = [p, o].map(x => (x.ambiguous ? '' : x.id)).sort();
      expect([...r.candidateIds].sort()).toEqual(want);
    }
  });

  it('an alias hit counts — and canonical shadows alias WITHIN a kind (no double count)', () => {
    const s = make();
    s.findOrCreate({ kind: 'person', name: 'Ada Fischer', aliases: ['Ada'] });
    const viaAlias = s.findByNameAnyKind('Ada');
    expect(!viaAlias.ambiguous && viaAlias.row?.kind).toBe('person');
    // Canonical + its own alias on ONE subject must resolve, not read as ambiguous.
    s.findOrCreate({ kind: 'organization', name: 'Meridian', aliases: ['Meridian'] });
    const r = s.findByNameAnyKind('Meridian');
    expect(!r.ambiguous && r.row?.kind).toBe('organization');
  });

  it('two same-named engagements under different parents are ambiguous', () => {
    const s = make();
    const a = s.findOrCreate({ kind: 'organization', name: 'Alpha AG' });
    const b = s.findOrCreate({ kind: 'organization', name: 'Beta AG' });
    s.findOrCreateEngagement('Website', a.ambiguous ? null : a.id);
    s.findOrCreateEngagement('Website', b.ambiguous ? null : b.id);
    const r = s.findByNameAnyKind('Website');
    expect(r.ambiguous).toBe(true);
  });

  it('canonical shadows a same-kind alias on ANOTHER subject — no false ambiguity', () => {
    const s = make();
    const a = s.findOrCreate({ kind: 'organization', name: 'Meridian' });
    s.findOrCreate({ kind: 'organization', name: 'Meridian Group', aliases: ['Meridian'] });
    const r = s.findByNameAnyKind('Meridian');
    // Within a kind the canonical owner of the name wins outright (same order as
    // findOrCreate); the alias on the sibling must not turn this into a question.
    expect(!r.ambiguous && r.row?.id).toBe(a.ambiguous ? '' : a.id);
  });

  it('normalizes the probe: "Projekt Orion" finds an engagement stored plainly as "Orion"', () => {
    const s = make();
    s.findOrCreateEngagement('Orion', null); // no "Projekt Orion" surface form ever stored
    const r = s.findByNameAnyKind('Projekt Orion');
    expect(!r.ambiguous && r.row?.kind).toBe('engagement');
  });

  it('matches an engagement through its ALIAS, JS-folded (non-ASCII survives)', () => {
    const s = make();
    s.findOrCreateEngagement('Orion', null, { aliases: ['Projekt Örion-Launch'] });
    const r = s.findByNameAnyKind('projekt örion-launch');
    expect(!r.ambiguous && r.row?.kind).toBe('engagement');
  });

  it('finds a RAW-named engagement (backfilled rows are not normalized at create)', () => {
    const s = make();
    // findOrCreate does not name-dedup engagements — it inserts the raw name,
    // exactly like the legacy backfill does.
    s.findOrCreate({ kind: 'engagement', name: 'Projekt Raw' });
    const r = s.findByNameAnyKind('Raw');
    expect(!r.ambiguous && r.row?.kind).toBe('engagement');
  });

  it('kinds option narrows the probe', () => {
    const s = make();
    s.findOrCreate({ kind: 'product', name: 'Vireo' });
    expect(s.findByNameAnyKind('Vireo', { kinds: ['organization'] })).toEqual({ ambiguous: false, row: null });
  });
});

// ── DEF-0015: the reference oracle + the orphan reap ──────────────────────────
//
// After a GDPR erase the legacy orphan-entity delete reaped the entity; engine.db's cascade
// runs memory→junction only, so the minted `subjects` row survived with its plaintext name.
// `referenceReason` is the ONE oracle that decides whether anything still holds a subject;
// `reapOrphans` deletes what nothing holds. Every reference kind below is a row that MUST keep
// a subject alive — and the cooccurrence case is the one that must NOT (derived data; counting
// it would make the reap a no-op on every real corpus).
import { MemoryGraphStore } from './memory-graph-store.js';
import { RelationshipStore } from './relationship-store.js';
import type { SubjectExternalRefs } from './subject-store.js';

describe('SubjectStore.referenceReason + reapOrphans (DEF-0015 orphan-subject reap)', () => {
  const tmpDirs: string[] = [];
  const NONE: SubjectExternalRefs = { isThreadAnchor: () => false, hasRecords: () => false };

  function make(): { store: SubjectStore; engine: EngineDb; mem: MemoryGraphStore } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-subj-reap-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    return { store: new SubjectStore(engine), engine, mem: new MemoryGraphStore(engine) };
  }
  function stub(mem: MemoryGraphStore, id: string, subjectId?: string): void {
    mem.upsertStub({ id, text: `t-${id}`, namespace: 'knowledge', scopeType: 'context', scopeId: 'c', subjectId: subjectId ?? null });
  }

  afterEach(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it('an unreferenced subject has no reason — archived or not; a missing id says so', () => {
    const { store, engine } = make();
    const id = store.createSubject({ kind: 'organization', name: 'Ghost GmbH' });
    expect(store.referenceReason(id, NONE)).toBeNull();
    store.archiveSubject(id);
    // An archived row still carries the plaintext name → still reapable.
    expect(store.referenceReason(id, NONE)).toBeNull();
    expect(store.referenceReason('no-such-id', NONE)).toBe('missing');
    engine.close();
  });

  it('every engine.db holder keeps a subject — junction, primary, knowledge entry, each verb-layer column, hierarchy, merge redirect, detail, self', () => {
    const { store, engine, mem } = make();
    const db = engine.getDb();
    const org = (n: string): string => store.createSubject({ kind: 'organization', name: n });

    // memory_subjects junction
    const a = org('A'); stub(mem, 'm-a'); mem.linkSubjects('m-a', [a]);
    expect(store.referenceReason(a, NONE)).toBe('referenced-by-memory_subjects');
    // memories.subject_id (primary, no junction row)
    const b = org('B'); stub(mem, 'm-b', b);
    expect(store.referenceReason(b, NONE)).toBe('referenced-by-memories.subject_id');
    // knowledge_entries.subject_id (the durable-knowledge store)
    const c = org('C');
    db.prepare("INSERT INTO knowledge_entries (id, subject_id, text) VALUES ('k1', ?, 'x')").run(c);
    expect(store.referenceReason(c, NONE)).toBe('referenced-by-knowledge_entries.subject_id');
    // tasks — both columns
    const d = org('D'); db.prepare("INSERT INTO tasks (id, title, subject_id) VALUES ('t1', 'x', ?)").run(d);
    expect(store.referenceReason(d, NONE)).toBe('referenced-by-tasks.subject_id');
    const d2 = store.createSubject({ kind: 'person', name: 'Dana' });
    db.prepare("INSERT INTO tasks (id, title, assignee_subject_id) VALUES ('t2', 'x', ?)").run(d2);
    expect(store.referenceReason(d2, NONE)).toBe('referenced-by-tasks.assignee_subject_id');
    // triggers / connections / artifacts / engine.db threads mirror
    const e = org('E'); db.prepare("INSERT INTO triggers (id, title, subject_id) VALUES ('tr1', 'x', ?)").run(e);
    expect(store.referenceReason(e, NONE)).toBe('referenced-by-triggers.subject_id');
    const f = org('F'); db.prepare("INSERT INTO connections (id, kind, name, subject_id) VALUES ('cn1', 'api', 'x', ?)").run(f);
    expect(store.referenceReason(f, NONE)).toBe('referenced-by-connections.subject_id');
    const g = org('G'); db.prepare("INSERT INTO artifacts (id, type, subject_id) VALUES ('ar1', 'doc', ?)").run(g);
    expect(store.referenceReason(g, NONE)).toBe('referenced-by-artifacts.subject_id');
    const h = org('H'); db.prepare("INSERT INTO threads (id, primary_subject_id) VALUES ('th1', ?)").run(h);
    expect(store.referenceReason(h, NONE)).toBe('referenced-by-threads.primary_subject_id');
    // relationships — either end
    const i = org('I'); const j = org('J');
    new RelationshipStore(engine).createRelationship({ fromSubjectId: i, toSubjectId: j, kind: 'partner_of' });
    expect(store.referenceReason(i, NONE)).toBe('referenced-by-relationships.from_subject_id');
    expect(store.referenceReason(j, NONE)).toBe('referenced-by-relationships.to_subject_id');
    // engagements — provider / client pointers
    const k = org('K'); const eng = store.createSubject({ kind: 'engagement', name: 'Projekt K' });
    db.prepare('INSERT INTO engagements (subject_id, client_subject_id) VALUES (?, ?)').run(eng, k);
    expect(store.referenceReason(k, NONE)).toBe('referenced-by-engagements.client_subject_id');
    // hierarchy: a child keeps its parent
    const parent = org('Parent'); const child = store.createSubject({ kind: 'engagement', name: 'Child', parentId: parent });
    expect(store.referenceReason(parent, NONE)).toBe('referenced-by-subjects.parent_id');
    // merge redirect: a dup pointing at its canonical keeps the canonical
    const canon = org('Canon'); const dup = org('Dup');
    db.prepare('UPDATE subjects SET merged_into = ? WHERE id = ?').run(canon, dup);
    expect(store.referenceReason(canon, NONE)).toBe('merge-target');
    // detail WITH data keeps; a detail row of all NULLs does not
    const p1 = store.createSubject({ kind: 'person', name: 'Petra' }); store.setPersonDetail(p1, { email: 'p@example.com' });
    expect(store.referenceReason(p1, NONE)).toBe('has-detail');
    const p2 = store.createSubject({ kind: 'person', name: 'Paul' }); store.setPersonDetail(p2, {});
    expect(store.referenceReason(p2, NONE)).toBeNull();
    // the operator self is never reapable
    const self = store.createSubject({ kind: 'organization', name: 'My Firm', isSelf: true });
    expect(store.referenceReason(self, NONE)).toBe('is_self');
    // the engagement subject itself (detail row exists, client pointer set) keeps via detail
    expect(store.referenceReason(eng, NONE)).toBe('has-detail');
    void child;
    engine.close();
  });

  it('the cross-DB anchors keep a subject: a history.db thread anchor, a datastore.db record', () => {
    const { store, engine } = make();
    const x = store.createSubject({ kind: 'organization', name: 'X' });
    expect(store.referenceReason(x, { isThreadAnchor: id => id === x, hasRecords: () => false })).toBe('thread-anchor');
    expect(store.referenceReason(x, { isThreadAnchor: () => false, hasRecords: id => id === x })).toBe('record');
    engine.close();
  });

  it('a cooccurrence row is DERIVED and does NOT keep a subject — both ends stay reapable', () => {
    const { store, engine, mem } = make();
    const a = store.createSubject({ kind: 'organization', name: 'A' });
    const b = store.createSubject({ kind: 'organization', name: 'B' });
    mem.bumpCooccurrences([a, b]);
    expect(engine.getDb().prepare('SELECT count(*) c FROM subject_cooccurrences').get()).toEqual({ c: 1 });
    expect(store.referenceReason(a, NONE)).toBeNull();
    expect(store.referenceReason(b, NONE)).toBeNull();
    // and the reap takes the derived rows with it (cascade)
    expect(store.reapOrphans([a, b], NONE).sort()).toEqual([a, b].sort());
    expect(engine.getDb().prepare('SELECT count(*) c FROM subject_cooccurrences').get()).toEqual({ c: 0 });
    engine.close();
  });

  it('reapOrphans runs to a fixpoint — a parent released by its reaped child goes too, in either order', () => {
    for (const order of ['parent-first', 'child-first'] as const) {
      const { store, engine } = make();
      const parent = store.createSubject({ kind: 'organization', name: 'Kunde' });
      const child = store.createSubject({ kind: 'engagement', name: 'Projekt', parentId: parent });
      const ids = order === 'parent-first' ? [parent, child] : [child, parent];
      expect(store.reapOrphans(ids, NONE).sort()).toEqual([parent, child].sort());
      expect(store.getSubject(parent)).toBeNull();
      expect(store.getSubject(child)).toBeNull();
      engine.close();
    }
  });

  it('reapOrphans keeps a parent whose child is still held, skips missing ids, never touches self', () => {
    const { store, engine, mem } = make();
    const parent = store.createSubject({ kind: 'organization', name: 'Kunde' });
    const child = store.createSubject({ kind: 'engagement', name: 'Projekt', parentId: parent });
    stub(mem, 'm1'); mem.linkSubjects('m1', [child]);
    const self = store.createSubject({ kind: 'person', name: 'Me', isSelf: true });
    expect(store.reapOrphans([parent, child, self, 'gone'], NONE)).toEqual([]);
    expect(store.getSubject(parent)).not.toBeNull();
    expect(store.getSubject(child)).not.toBeNull();
    expect(store.getSubject(self)).not.toBeNull();
    engine.close();
  });

  it('hasRecordsForSubject — the datastore.db half of the oracle — sees a subject-typed cell and nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-subj-reap-ds-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    const store = new SubjectStore(engine);
    const ds = new DataStore(join(dir, 'datastore.db'));
    ds.setSubjectBridge(makeSubjectColumnBridge(store));
    ds.createCollection({
      name: 'appointments',
      scope: { type: 'context', id: '' },
      columns: [{ name: 'note', type: 'string' }, { name: 'patient', type: 'subject', subjectKind: 'person' }],
    });
    ds.insertRecords({ collection: 'appointments', records: [{ note: 'first', patient: 'Anna Meier' }] });
    const anna = store.findCanonical('Anna Meier', 'person')!.id;
    const other = store.createSubject({ kind: 'person', name: 'Nobody' });
    expect(ds.hasRecordsForSubject(anna)).toBe(true);
    expect(ds.hasRecordsForSubject(other)).toBe(false);
    // a collection without a subject column is skipped, not scanned
    ds.createCollection({ name: 'plain', scope: { type: 'context', id: '' }, columns: [{ name: 'x', type: 'string' }] });
    ds.insertRecords({ collection: 'plain', records: [{ x: anna }] });
    expect(ds.hasRecordsForSubject(other)).toBe(false);
    ds.close();
    engine.close();
  });
});

describe('SubjectStore.referenceReason — detail-row defaults (DEF-0015)', () => {
  const tmpDirs: string[] = [];
  const NONE: SubjectExternalRefs = { isThreadAnchor: () => false, hasRecords: () => false };
  afterEach(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); tmpDirs.length = 0; });

  it('a bare detail row (only the NOT NULL default classifier) is no reference; a deliberate non-default type is', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-subj-detail-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    const store = new SubjectStore(engine);
    const p = store.createSubject({ kind: 'person', name: 'Plain' });
    store.setPersonDetail(p, {});                                  // type = DEFAULT 'contact'
    expect(store.referenceReason(p, NONE)).toBeNull();
    store.setPersonDetail(p, { type: 'customer' });                // a deliberate classification
    expect(store.referenceReason(p, NONE)).toBe('has-detail');
    const o = store.createSubject({ kind: 'organization', name: 'Org' });
    store.setOrganizationDetail(o, {});                            // type = DEFAULT 'other'
    expect(store.referenceReason(o, NONE)).toBeNull();
    store.setOrganizationDetail(o, { country: 'CH' });
    expect(store.referenceReason(o, NONE)).toBe('has-detail');
    engine.close();
  });
});
