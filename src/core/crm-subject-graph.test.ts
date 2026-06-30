import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DataStore } from './data-store.js';
import { CRM } from './crm.js';
import { EngineDb } from './engine-db.js';
import { SubjectStore } from './subject-store.js';
import { RelationshipStore } from './relationship-store.js';

/**
 * S1c integration: the flag-gated additive mirror from CRM.upsertContact into
 * the engine.db subject-graph (contact → person subject + detail, company →
 * organization subject, joined by a `works_for` edge). The ds_contacts write
 * stays authoritative; the mirror is isolated behind the flag + a swallowing
 * try/catch. No LLM — CRM writes are deterministic.
 */
const TEST_VAULT_KEY = 'unit-test-vault-key-0123456789abcdef';

describe('CRM → engine.db subject-graph mirror (S1c)', () => {
  const tmpDirs: string[] = [];

  function makeCrm(opts: { flag: boolean; withEngine?: boolean; key?: string }): {
    crm: CRM; ds: DataStore; engine: EngineDb | null;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-crm-sg-'));
    tmpDirs.push(dir);
    const ds = new DataStore(join(dir, 'datastore.db'));
    const engine = (opts.withEngine ?? true)
      ? new EngineDb(join(dir, 'engine.db'), opts.key ?? TEST_VAULT_KEY)
      : null;
    const crm = new CRM(ds, { engineDb: engine ?? undefined, subjectGraphEnabled: opts.flag });
    return { crm, ds, engine };
  }

  afterEach(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it('flag ON: contact→person(+detail), company→org, works_for edge; PII encrypted at rest', () => {
    const { crm, ds, engine } = makeCrm({ flag: true });
    crm.upsertContact({ name: 'Alice Schmidt', email: 'Alice@Acme.com', phone: '+41791234567', company: 'Acme GmbH', type: 'customer' });

    // ds_contacts is authoritative (email lower-cased on write).
    expect(crm.findContact({ name: 'Alice Schmidt' })!.email).toBe('alice@acme.com');

    const subs = new SubjectStore(engine!);
    expect(subs.listSubjects().map(s => s.name).sort()).toEqual(['Acme GmbH', 'Alice Schmidt']);
    const person = subs.findCanonical('Alice Schmidt', 'person')!;
    const org = subs.findCanonical('Acme GmbH', 'organization')!;

    // PersonDetail round-trips through dec()…
    const detail = subs.getPersonDetail(person.id)!;
    expect(detail.email).toBe('alice@acme.com');
    expect(detail.phone).toBe('+41791234567');
    expect(detail.type).toBe('customer');
    // …but the raw columns are ciphertext; the subject name stays plaintext (dedup index).
    const raw = engine!.getDb().prepare('SELECT email, phone FROM people WHERE subject_id = ?').get(person.id) as { email: string; phone: string };
    expect(raw.email).toMatch(/^enc:/);
    expect(raw.email).not.toContain('alice@acme.com');
    expect(raw.phone).toMatch(/^enc:/);

    // works_for edge person→org.
    const rels = new RelationshipStore(engine!);
    const from = rels.getRelationshipsFrom(person.id);
    expect(from).toHaveLength(1);
    expect(from[0]!.kind).toBe('works_for');
    expect(from[0]!.to_subject_id).toBe(org.id);

    engine!.close();
    ds.close();
  });

  it('flag OFF: ds_contacts written, engine.db subject-graph untouched (additive proof)', () => {
    const { crm, ds, engine } = makeCrm({ flag: false });
    crm.upsertContact({ name: 'Bob', email: 'bob@x.com', company: 'Globex' });

    expect(crm.findContact({ name: 'Bob' })!.email).toBe('bob@x.com'); // legacy ran
    expect(new SubjectStore(engine!).listSubjects()).toHaveLength(0);   // nothing mirrored

    engine!.close();
    ds.close();
  });

  it('name-dedup: same name → one person subject + one idempotent works_for edge', () => {
    const { crm, ds, engine } = makeCrm({ flag: true });
    crm.upsertContact({ name: 'Jane Doe', email: 'jane@a.com', company: 'Acme GmbH' });
    crm.upsertContact({ name: 'jane doe', email: 'jane@b.com', company: 'Acme GmbH' }); // same name (diff email + case)

    const subs = new SubjectStore(engine!);
    expect(subs.listSubjects({ kind: 'person' })).toHaveLength(1);       // one person (name-deduped)
    expect(subs.listSubjects({ kind: 'organization' })).toHaveLength(1); // one org (name-deduped)
    const person = subs.findCanonical('Jane Doe', 'person')!;
    // detail MERGEd, not wiped — the later email wins.
    expect(subs.getPersonDetail(person.id)!.email).toBe('jane@b.com');
    // the works_for edge is idempotent on re-save — exactly one, NOT one-per-upsert
    // (the common path: every inbound contact upserts the same person+company).
    expect(new RelationshipStore(engine!).getRelationshipsFrom(person.id)).toHaveLength(1);
    // ds_contacts keeps both rows (email-keyed identity).
    expect(crm.listContacts()).toHaveLength(2);

    engine!.close();
    ds.close();
  });

  it('no company: person subject only, no org, no edge', () => {
    const { crm, ds, engine } = makeCrm({ flag: true });
    crm.upsertContact({ name: 'Solo Person', email: 'solo@x.com' });

    const subs = new SubjectStore(engine!);
    expect(subs.listSubjects({ kind: 'person' })).toHaveLength(1);
    expect(subs.listSubjects({ kind: 'organization' })).toHaveLength(0);
    const person = subs.findCanonical('Solo Person', 'person')!;
    expect(new RelationshipStore(engine!).getRelationshipsFrom(person.id)).toHaveLength(0);

    engine!.close();
    ds.close();
  });

  it('whitespace-only company: person subject only, no org/edge (trim guard)', () => {
    const { crm, ds, engine } = makeCrm({ flag: true });
    crm.upsertContact({ name: 'Eve', email: 'eve@x.com', company: '   ' });

    const subs = new SubjectStore(engine!);
    expect(subs.listSubjects({ kind: 'person' })).toHaveLength(1);
    expect(subs.listSubjects({ kind: 'organization' })).toHaveLength(0);
    expect(new RelationshipStore(engine!).getRelationshipsFrom(subs.findCanonical('Eve', 'person')!.id)).toHaveLength(0);

    engine!.close();
    ds.close();
  });

  it('company present but no person detail: person+org+edge, people detail row null', () => {
    const { crm, ds, engine } = makeCrm({ flag: true });
    crm.upsertContact({ name: 'Frank', company: 'Stark Industries' }); // no email/phone/type

    const subs = new SubjectStore(engine!);
    const person = subs.findCanonical('Frank', 'person')!;
    const org = subs.findCanonical('Stark Industries', 'organization')!;
    expect(subs.getPersonDetail(person.id)).toBeNull(); // detail write skipped — nothing to store
    const from = new RelationshipStore(engine!).getRelationshipsFrom(person.id);
    expect(from).toHaveLength(1);
    expect(from[0]!.kind).toBe('works_for');
    expect(from[0]!.to_subject_id).toBe(org.id);

    engine!.close();
    ds.close();
  });

  it('whitespace-only name: no person subject mirrored (guard returns)', () => {
    const { crm, ds, engine } = makeCrm({ flag: true });
    crm.upsertContact({ name: '   ', email: 'ws@x.com' });

    expect(new SubjectStore(engine!).listSubjects()).toHaveLength(0); // mirror skipped
    expect(crm.listContacts()).toHaveLength(1);                       // ds write still happened

    engine!.close();
    ds.close();
  });

  it('name-only contact: no empty people detail row written', () => {
    const { crm, ds, engine } = makeCrm({ flag: true });
    crm.upsertContact({ name: 'Nameless Co Contact' }); // no email/phone/type/company

    const subs = new SubjectStore(engine!);
    const person = subs.findCanonical('Nameless Co Contact', 'person')!;
    expect(subs.getPersonDetail(person.id)).toBeNull(); // detail write skipped — nothing to store

    engine!.close();
    ds.close();
  });

  it('mirror failure is isolated: a broken engine.db never fails the ds_contacts write', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const { crm, ds, engine } = makeCrm({ flag: true });
    try {
      engine!.close(); // subsequent mirror writes throw on the closed connection
      crm.upsertContact({ name: 'Carol', email: 'carol@x.com', company: 'Initech' });

      expect(crm.findContact({ name: 'Carol' })!.email).toBe('carol@x.com'); // ds write committed
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[lynox:subject-graph] CRM contact mirror failed'));
    } finally {
      errSpy.mockRestore();
      ds.close();
    }
  });

  it('no engineDb provided: upsertContact works, nothing mirrored, no crash', () => {
    const { crm, ds } = makeCrm({ flag: true, withEngine: false });
    crm.upsertContact({ name: 'Dave', email: 'dave@x.com', company: 'Hooli' });
    expect(crm.findContact({ name: 'Dave' })!.email).toBe('dave@x.com');
    ds.close();
  });

  describe('S2 backfillSubjectGraph — mirror PRE-EXISTING contacts', () => {
    it('mirrors every ds_contacts row a flag-OFF era left behind (person+detail, org, works_for); idempotent', () => {
      const dir = mkdtempSync(join(tmpdir(), 'lynox-crm-s2-'));
      tmpDirs.push(dir);
      const ds = new DataStore(join(dir, 'datastore.db'));
      const engine = new EngineDb(join(dir, 'engine.db'), TEST_VAULT_KEY);

      // Era 1: flag OFF — contacts land in ds_contacts only, never mirrored.
      const crmOff = new CRM(ds, { engineDb: engine, subjectGraphEnabled: false });
      crmOff.upsertContact({ name: 'Beatrice Vogt', email: 'bea@helvetia.ch', phone: '+41790000001', company: 'Helvetia AG', type: 'customer' });
      crmOff.upsertContact({ name: 'Quentin Zephyr', email: 'q@zephyr.io', company: 'Zephyr Robotics' });
      expect(new SubjectStore(engine).listSubjects()).toHaveLength(0); // nothing mirrored yet

      // Era 2: flag ON — the S2 backfill replays the existing rows.
      const crmOn = new CRM(ds, { engineDb: engine, subjectGraphEnabled: true });
      const r1 = crmOn.backfillSubjectGraph();
      expect(r1.contacts).toBe(2);

      const subs = new SubjectStore(engine);
      expect(subs.listSubjects().map(s => s.name).sort())
        .toEqual(['Beatrice Vogt', 'Helvetia AG', 'Quentin Zephyr', 'Zephyr Robotics']);
      const bea = subs.findCanonical('Beatrice Vogt', 'person')!;
      const detail = subs.getPersonDetail(bea.id)!;
      expect(detail.email).toBe('bea@helvetia.ch');     // decrypts
      expect(detail.phone).toBe('+41790000001');
      const rawEmail = (engine.getDb().prepare('SELECT email FROM people WHERE subject_id = ?').get(bea.id) as { email: string }).email;
      expect(rawEmail).toMatch(/^enc:/);                  // encrypted at rest
      const rels = new RelationshipStore(engine);
      expect(rels.getRelationshipsFrom(bea.id)[0]!.kind).toBe('works_for');

      // Idempotent: a second backfill re-visits both rows but adds no duplicate subjects/edges.
      expect(crmOn.backfillSubjectGraph().contacts).toBe(2);
      expect(subs.listSubjects()).toHaveLength(4);
      expect((engine.getDb().prepare('SELECT COUNT(*) n FROM relationships').get() as { n: number }).n).toBe(2);

      ds.close(); engine.close();
    });

    it('flag OFF / no engineDb: backfill is a no-op', () => {
      const { crm, ds } = makeCrm({ flag: false });
      crm.upsertContact({ name: 'Ed', email: 'ed@x.com' });
      expect(crm.backfillSubjectGraph()).toEqual({ contacts: 0 });
      ds.close();
    });
  });
});
