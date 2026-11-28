import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { DataStore, rowStampOf, type RowStamp } from './data-store.js';
import { CRM } from './crm.js';
import { ConversationGrants } from './conversation-grants.js';
import { createToolContext } from './tool-context.js';
import { dataStoreInsertTool } from '../tools/builtin/data-store.js';
import { contactsSaveTool } from '../tools/builtin/contacts.js';
import { dataStoreWriter } from './bulk-apply.js';
import type { IAgent } from '../types/index.js';
import { OWNER_PRINCIPAL } from './request-principal.js';

/**
 * Who wrote a data-store row: `_written_by` is the last writer's author tag, and
 * `_written_untrusted` stays set once any write came from a turn that had read content from
 * outside. Both are columns the store writes itself; a user column of the same meaning
 * (`source`) is never read for this.
 */

const SCOPE = { type: 'global' as const, id: '' };
const stamp = (writtenBy: string | null, untrusted = false): RowStamp => ({ grants: [], runId: null, writtenBy, untrusted });

describe('DataStore: who wrote a row', () => {
  let dir: string;
  let ds: DataStore;
  let crm: CRM;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-ds-written-'));
    ds = new DataStore(join(dir, 'datastore.db'));
    crm = new CRM(ds);
  });

  afterEach(() => {
    try { ds.close(); } catch { /* closed by the test */ }
    rmSync(dir, { recursive: true, force: true });
  });

  const db = (): Database.Database => ds['db'] as Database.Database;
  const cells = (collection: string): Array<{ w: string | null; u: string | null }> =>
    db().prepare(`SELECT _written_by AS w, _written_untrusted AS u FROM "ds_${collection}" ORDER BY _id`).all() as Array<{ w: string | null; u: string | null }>;
  const keyed = (name = 'leads'): void => {
    ds.createCollection({ name, scope: SCOPE, columns: [{ name: 'email', type: 'string' }, { name: 'source', type: 'string' }], uniqueKey: ['email'] });
  };

  describe('what a write records', () => {
    it('stores the writer and the untrusted mark', () => {
      keyed();
      ds.insertRecords({ collection: 'leads', records: [{ email: 'a@x' }], stamp: stamp('owner') });
      ds.insertRecords({ collection: 'leads', records: [{ email: 'b@x' }], stamp: stamp('owner', true) });
      ds.insertRecords({ collection: 'leads', records: [{ email: 'c@x' }], stamp: stamp(null) });
      expect(cells('leads')).toEqual([{ w: 'owner', u: null }, { w: 'owner', u: '1' }, { w: null, u: null }]);
    });

    it('the last writer wins on an upsert', () => {
      keyed();
      ds.insertRecords({ collection: 'leads', records: [{ email: 'a@x' }], stamp: stamp('owner') });
      ds.insertRecords({ collection: 'leads', records: [{ email: 'a@x' }], stamp: stamp('mandate:helper@example.invalid') });
      expect(cells('leads')).toEqual([{ w: 'mandate:helper@example.invalid', u: null }]);
    });

    it('the untrusted mark survives a later clean write, on insertRecords and putRowVerbatim alike', () => {
      keyed();
      ds.insertRecords({ collection: 'leads', records: [{ email: 'a@x' }], stamp: stamp('owner', true) });
      ds.insertRecords({ collection: 'leads', records: [{ email: 'a@x' }], stamp: stamp('owner') });
      expect(cells('leads')).toEqual([{ w: 'owner', u: '1' }]);
      ds.putRowVerbatim('leads', { email: 'a@x', source: null }, stamp('owner'));
      expect(cells('leads')).toEqual([{ w: 'owner', u: '1' }]);
    });

    it('putRowVerbatim records its writer and marks an untrusted write', () => {
      keyed();
      ds.putRowVerbatim('leads', { email: 'a@x', source: null }, stamp('owner'));
      expect(cells('leads')).toEqual([{ w: 'owner', u: null }]);
      ds.putRowVerbatim('leads', { email: 'a@x', source: null }, stamp('trigger:t-1', true));
      expect(cells('leads')).toEqual([{ w: 'trigger:t-1', u: '1' }]);
    });

    it('a bulk apply writes as unknown', async () => {
      keyed();
      ds.insertRecords({ collection: 'leads', records: [{ email: 'a@x' }], stamp: stamp('owner') });
      await dataStoreWriter(ds, 'leads')!.write('a@x', { absent: false, value: { email: 'a@x', source: 'x' } });
      expect(cells('leads')).toEqual([{ w: null, u: null }]);
    });

    it('a table created before the columns gets them at boot, NULL in every old row', () => {
      keyed();
      ds.insertRecords({ collection: 'leads', records: [{ email: 'a@x' }], stamp: stamp('owner') });
      db().exec('ALTER TABLE ds_leads DROP COLUMN _written_by; ALTER TABLE ds_leads DROP COLUMN _written_untrusted;');
      const path = ds['db'].name as string;
      ds.close();
      ds = new DataStore(path);
      expect(() => ds.insertRecords({ collection: 'leads', records: [{ email: 'b@x' }], stamp: stamp('owner') })).toThrow(/has not been migrated/);
      const result = ds.ensureSourceColumns();
      expect(result.migrated).toEqual(['leads']);
      expect(cells('leads')).toEqual([{ w: null, u: null }]);
    });
  });

  describe('sourceOfRow and contactOrigin', () => {
    // A stamp with an empty grant set is stored as `[]`, which reads as unknown, as A5 reads it.
    it('reads the stamp of the row, not its user columns', () => {
      keyed();
      ds.insertRecords({ collection: 'leads', records: [{ email: 'a@x', source: 'agent' }], stamp: stamp('trigger:t-1') });
      expect(ds.sourceOfRow('leads', 'email', 'a@x')).toEqual({ writtenBy: 'trigger:t-1', untrusted: false, grants: ['unknown'] });
      expect(ds.sourceOfRow('leads', 'email', 'nobody@x')).toBeNull();
      expect(ds.sourceOfRow('leads', 'no_such_column', 'a@x')).toBeNull();
      expect(ds.sourceOfRow('no_such_collection', 'email', 'a@x')).toBeNull();
    });

    it('takes the least trusting answer when several rows match', () => {
      ds.createCollection({ name: 'plain', scope: SCOPE, columns: [{ name: 'email', type: 'string' }] });
      ds.insertRecords({ collection: 'plain', records: [{ email: 'a@x' }], stamp: { grants: ['g-a'], runId: null, writtenBy: 'owner', untrusted: false } });
      ds.insertRecords({ collection: 'plain', records: [{ email: 'a@x' }], stamp: { grants: null, runId: null, writtenBy: 'mandate:h@x', untrusted: true } });
      expect(ds.sourceOfRow('plain', 'email', 'a@x')).toEqual({ writtenBy: null, untrusted: true, grants: ['g-a', 'unknown'] });
    });

    it('contactOrigin finds the contact by its normalized address', () => {
      crm.upsertContact({ name: 'Anna', email: 'Anna@Firma.ch' }, stamp('owner'));
      expect(crm.contactOrigin('  ANNA@firma.ch ')).toEqual({ writtenBy: 'owner', untrusted: false, grants: ['unknown'] });
      expect(crm.contactOrigin('x@firma.ch')).toBeNull();
      expect(crm.contactOrigin('')).toBeNull();
    });

    it('the owner creates Anna, then a helper\'s turn saves Anna again: the last writer is the helper', () => {
      crm.upsertContact({ name: 'Anna', email: 'anna@firma.ch' }, stamp('owner'));
      crm.upsertContact({ name: 'Anna', email: 'anna@firma.ch' }, stamp('mandate:helper@example.invalid'));
      expect(crm.contactOrigin('anna@firma.ch')?.writtenBy).toBe('mandate:helper@example.invalid');
    });
  });

  describe('a write that does not stamp (an older binary) leaves the writer unknown', () => {
    // An older binary's upsert sets the user columns and `_updated_at`, and leaves the columns it
    // does not know as they were. The writer it leaves standing is not the one that wrote last.
    const oldBinaryUpsert = (email: string, name: string): void => {
      db().prepare('UPDATE ds_contacts SET name = ?, _updated_at = ? WHERE email = ?').run(name, new Date(Date.now() + 1000).toISOString(), email);
    };

    it('the owner\'s contact, rewritten by a write that does not stamp, has no known writer', () => {
      crm.upsertContact({ name: 'Anna', email: 'anna@firma.ch' }, stamp('owner'));
      expect(crm.contactOrigin('anna@firma.ch')?.writtenBy).toBe('owner');
      oldBinaryUpsert('anna@firma.ch', 'Anna (changed)');
      expect(crm.contactOrigin('anna@firma.ch')?.writtenBy).toBeNull();
    });

    it('CONTROL: a stamped write after it names its writer again', () => {
      crm.upsertContact({ name: 'Anna', email: 'anna@firma.ch' }, stamp('owner'));
      oldBinaryUpsert('anna@firma.ch', 'Anna (changed)');
      crm.upsertContact({ name: 'Anna', email: 'anna@firma.ch' }, stamp('owner'));
      expect(crm.contactOrigin('anna@firma.ch')?.writtenBy).toBe('owner');
    });

    it('a row stamped before the stamp time was recorded has no known writer', () => {
      crm.upsertContact({ name: 'Anna', email: 'anna@firma.ch' }, stamp('owner'));
      db().prepare('UPDATE ds_contacts SET _written_at = NULL WHERE email = ?').run('anna@firma.ch');
      expect(crm.contactOrigin('anna@firma.ch')?.writtenBy).toBeNull();
    });

    it('putRowVerbatim stamps its write, too', () => {
      keyed();
      ds.putRowVerbatim('leads', { email: 'a@x' }, stamp('owner'));
      expect(ds.sourceOfRow('leads', 'email', 'a@x')?.writtenBy).toBe('owner');
      db().prepare('UPDATE ds_leads SET _updated_at = ? WHERE email = ?').run('2099-01-01T00:00:00.000Z', 'a@x');
      expect(ds.sourceOfRow('leads', 'email', 'a@x')?.writtenBy).toBeNull();
    });

    // The upsert form of an older binary's write: the conflict branch sets a user column and
    // `_updated_at`, and does not know the stamp columns. The trigger still clears the stamp.
    it('an older binary\'s upsert over a putRowVerbatim row leaves _written_at NULL and no known writer', () => {
      keyed();
      ds.putRowVerbatim('leads', { email: 'a@x', source: 'one' }, { grants: ['gA'], runId: null, writtenBy: 'owner', untrusted: false });
      const writtenAt = (): string | null => (db().prepare('SELECT _written_at AS wa FROM ds_leads WHERE email = ?').get('a@x') as { wa: string | null }).wa;
      expect(writtenAt()).not.toBeNull();
      expect(ds.sourceOfRow('leads', 'email', 'a@x')?.writtenBy).toBe('owner');
      db().prepare(
        'INSERT INTO ds_leads (email, source, _created_at, _updated_at) VALUES (?, ?, ?, ?) '
        + 'ON CONFLICT(email) DO UPDATE SET source = excluded.source, _updated_at = excluded._updated_at',
      ).run('a@x', 'two', '2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z');
      expect((db().prepare('SELECT source FROM ds_leads WHERE email = ?').get('a@x') as { source: string }).source).toBe('two');
      expect(writtenAt()).toBeNull();
      expect(ds.sourceOfRow('leads', 'email', 'a@x')?.writtenBy).toBeNull();
    });

    // Every UPDATE path, whatever it changes: the database clears the stamp of any UPDATE that does
    // not write a new one, so a path that forgets the stamp cannot leave the last writer standing.
    it.each([
      ['a user column, without _updated_at', 'UPDATE ds_contacts SET name = \'Anna X\' WHERE email = ?'],
      ['_updated_at alone', 'UPDATE ds_contacts SET _updated_at = \'2099-01-01T00:00:00.000Z\' WHERE email = ?'],
      ['nothing but the stamp columns other than the stamp', 'UPDATE ds_contacts SET _written_by = \'owner\' WHERE email = ?'],
    ])('an UPDATE that sets %s leaves no known writer', (_label, sql) => {
      crm.upsertContact({ name: 'Anna', email: 'anna@firma.ch' }, stamp('owner'));
      db().prepare(sql).run('anna@firma.ch');
      expect(crm.contactOrigin('anna@firma.ch')?.writtenBy).toBeNull();
    });

    it('CONTROL: two stamped writes in a row keep their writer, even within one millisecond', () => {
      vi.useFakeTimers({ now: new Date('2026-11-18T08:00:00.000Z'), toFake: ['Date'] });
      try {
        crm.upsertContact({ name: 'Anna', email: 'anna@firma.ch' }, stamp('owner'));
        crm.upsertContact({ name: 'Anna B', email: 'anna@firma.ch' }, stamp('owner'));
      } finally {
        vi.useRealTimers();
      }
      expect(crm.contactOrigin('anna@firma.ch')?.writtenBy).toBe('owner');
    });

    it('a subject repoint and its rollback leave no known writer on the rows they move', () => {
      ds.createCollection({ name: 'deals', scope: SCOPE, columns: [{ name: 'email', type: 'string' }, { name: 'who', type: 'subject' }], uniqueKey: ['email'] });
      ds.insertRecords({ collection: 'deals', records: [{ email: 'a@x', who: 'old-id' }, { email: 'b@x', who: 'other' }], stamp: stamp('owner') });
      const moved = ds.repointSubjectId('old-id', 'new-id');
      expect(ds.sourceOfRow('deals', 'email', 'a@x')?.writtenBy).toBeNull();
      expect(ds.sourceOfRow('deals', 'email', 'b@x')?.writtenBy).toBe('owner');
      ds.insertRecords({ collection: 'deals', records: [{ email: 'a@x', who: 'new-id' }], stamp: stamp('owner') });
      ds.rollbackRepoint('old-id', 'new-id', moved);
      expect(ds.sourceOfRow('deals', 'email', 'a@x')?.writtenBy).toBeNull();
    });

    it('a table without the trigger counts as not migrated, and the boot step adds it', () => {
      crm.upsertContact({ name: 'Anna', email: 'anna@firma.ch' }, stamp('owner'));
      db().exec('DROP TRIGGER ds_contacts__writer_unknown;');
      const path = ds['db'].name as string;
      ds.close();
      ds = new DataStore(path);
      crm = new CRM(ds);
      expect(() => crm.contactOrigin('anna@firma.ch')).toThrow(/has not been migrated/);
      expect(ds.ensureSourceColumns().migrated).toContain('contacts');
      db().prepare('UPDATE ds_contacts SET name = ? WHERE email = ?').run('Anna X', 'anna@firma.ch');
      expect(crm.contactOrigin('anna@firma.ch')?.writtenBy).toBeNull();
    });
  });

  describe('contactOrigin in the normal form of a send target', () => {
    it('finds a contact stored with an international domain by its ASCII address, and the other way round', () => {
      crm.upsertContact({ name: 'Anna', email: 'anna@müller.ch' }, stamp('owner'));
      crm.upsertContact({ name: 'Bob', email: 'bob@xn--mller-kva.ch' }, stamp('owner'));
      expect(crm.contactOrigin('anna@xn--mller-kva.ch')?.writtenBy).toBe('owner');
      expect(crm.contactOrigin('bob@müller.ch')?.writtenBy).toBe('owner');
    });

    it('two spellings of one address answer with the least trusting', () => {
      crm.upsertContact({ name: 'Anna', email: 'anna@müller.ch' }, stamp('owner'));
      crm.upsertContact({ name: 'Anna 2', email: 'anna@xn--mller-kva.ch' }, stamp('mandate:h@x', true));
      expect(crm.contactOrigin('anna@xn--mller-kva.ch')).toMatchObject({ writtenBy: null, untrusted: true });
    });
  });

  describe('a contacts table that was not migrated', () => {
    it('sourceOfRow throws, and the check before a send reads it as unreadable, never as known', async () => {
      crm.upsertContact({ name: 'Anna', email: 'anna@firma.ch' }, stamp('owner'));
      db().exec('DROP TRIGGER ds_contacts__writer_unknown; ALTER TABLE ds_contacts DROP COLUMN _written_at;');
      const path = ds['db'].name as string;
      ds.close();
      ds = new DataStore(path);
      crm = new CRM(ds);
      expect(() => crm.contactOrigin('anna@firma.ch')).toThrow(/has not been migrated/);
      const { OwnerKnownTargets } = await import('./owner-known-targets.js');
      const reader = OwnerKnownTargets.of({ contactOrigin: (a) => crm.contactOrigin(a) });
      expect(reader.known({ kind: 'mail', value: 'anna@firma.ch' })).toBe('unreadable');
    });
  });

  describe('the writers stamp who the agent writes as', () => {
    const agentWith = (fields: Partial<Pick<IAgent, 'writeAuthor' | 'sawUntrustedData' | 'sawExternalContentTool' | 'conversationSawUntrusted'>>): IAgent => {
      const toolContext = createToolContext({});
      toolContext.dataStore = ds;
      toolContext.crm = crm;
      return { principal: OWNER_PRINCIPAL, toolContext, conversationGrants: ConversationGrants.detached(), ...fields } as unknown as IAgent;
    };

    it('rowStampOf takes the author and the turn\'s untrusted state, and an agent with no author is unknown', () => {
      expect(rowStampOf(agentWith({ writeAuthor: 'owner' }))).toMatchObject({ writtenBy: 'owner', untrusted: false });
      expect(rowStampOf(agentWith({ writeAuthor: 'owner', sawUntrustedData: true }))).toMatchObject({ untrusted: true });
      expect(rowStampOf(agentWith({ writeAuthor: 'owner', sawExternalContentTool: true }))).toMatchObject({ untrusted: true });
      expect(rowStampOf(agentWith({ writeAuthor: 'owner', conversationSawUntrusted: true }))).toMatchObject({ untrusted: true });
      expect(rowStampOf(agentWith({}))).toMatchObject({ writtenBy: null });
    });

    it('data_store_insert into contacts with source "agent" from a turn that read outside content is untrusted', async () => {
      crm.upsertContact({ name: 'Seed', email: 'seed@x' }, stamp('owner'));
      await dataStoreInsertTool.handler({ collection: 'contacts', records: [{ name: 'Eve', email: 'eve@x', source: 'agent' }] },
        agentWith({ writeAuthor: 'owner', sawExternalContentTool: true }));
      expect(crm.contactOrigin('eve@x')).toMatchObject({ writtenBy: 'owner', untrusted: true });
    });

    it('contacts_save in a trigger\'s run never records the owner', async () => {
      await contactsSaveTool.handler({ name: 'Bob', email: 'bob@x' }, agentWith({ writeAuthor: 'trigger:t-9' }));
      expect(crm.contactOrigin('bob@x')).toMatchObject({ writtenBy: 'trigger:t-9', untrusted: false });
    });
  });
});
