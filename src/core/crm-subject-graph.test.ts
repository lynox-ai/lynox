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

  it('name-dedup: two contacts with the same name → one person subject', () => {
    const { crm, ds, engine } = makeCrm({ flag: true });
    crm.upsertContact({ name: 'Jane Doe', email: 'jane@a.com', company: 'Acme GmbH' });
    crm.upsertContact({ name: 'jane doe', email: 'jane@b.com', company: 'Acme GmbH' }); // same name (diff email + case)

    const subs = new SubjectStore(engine!);
    expect(subs.listSubjects({ kind: 'person' })).toHaveLength(1);       // one person (name-deduped)
    expect(subs.listSubjects({ kind: 'organization' })).toHaveLength(1); // one org (name-deduped)
    // detail MERGEd, not wiped — the later email wins.
    expect(subs.getPersonDetail(subs.findCanonical('Jane Doe', 'person')!.id)!.email).toBe('jane@b.com');
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
});
