import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
