import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DataStore } from './data-store.js';
import { CRM } from './crm.js';

function createTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'lynox-crm-test-'));
}

describe('CRM', () => {
  let tmpDir: string;
  let ds: DataStore;
  let crm: CRM;

  beforeEach(() => {
    tmpDir = createTmpDir();
    ds = new DataStore(join(tmpDir, 'datastore.db'));
    crm = new CRM(ds);
  });

  afterEach(() => {
    try { ds.close(); } catch { /* ok */ }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('ensureSchema', () => {
    it('creates contacts, deals, and interactions tables', () => {
      crm.ensureSchema();
      const collections = ds.listCollections().map(c => c.name);
      expect(collections).toContain('contacts');
      expect(collections).toContain('deals');
      expect(collections).toContain('interactions');
    });

    it('is idempotent', () => {
      crm.ensureSchema();
      crm.ensureSchema();
      const collections = ds.listCollections().map(c => c.name);
      expect(collections.filter(c => c === 'contacts')).toHaveLength(1);
    });

    it('sets initialized flag', () => {
      expect(crm.initialized).toBe(false);
      crm.ensureSchema();
      expect(crm.initialized).toBe(true);
    });
  });

  describe('contacts', () => {
    it('upserts and finds a contact by name', () => {
      crm.upsertContact({ name: 'Alice', email: 'alice@test.com', type: 'customer' });
      const found = crm.findContact({ name: 'Alice' });
      expect(found).not.toBeNull();
      expect(found!.email).toBe('alice@test.com');
      expect(found!.type).toBe('customer');
    });

    it('finds contact by channel_id', () => {
      crm.upsertContact({ name: 'Bob', channel_id: 'mail:bob@example.com', source: 'mail' });
      const found = crm.findContact({ channel_id: 'mail:bob@example.com' });
      expect(found).not.toBeNull();
      expect(found!.name).toBe('Bob');
    });

    it('finds contact by email', () => {
      crm.upsertContact({ name: 'Carol', email: 'carol@test.com' });
      const found = crm.findContact({ email: 'carol@test.com' });
      expect(found).not.toBeNull();
      expect(found!.name).toBe('Carol');
    });

    it('returns null for unknown contact', () => {
      crm.ensureSchema();
      expect(crm.findContact({ name: 'Nobody' })).toBeNull();
    });

    it('upserts existing contact on email (updates fields, no duplicate)', () => {
      crm.upsertContact({ name: 'Alice', email: 'alice@acme.com', type: 'lead' });
      crm.upsertContact({ name: 'Alice', email: 'alice@acme.com', type: 'customer', company: 'Acme' });
      const found = crm.findContact({ email: 'alice@acme.com' });
      expect(found!.type).toBe('customer');
      expect(found!.company).toBe('Acme');
      expect(crm.listContacts({ email: 'alice@acme.com' })).toHaveLength(1);
    });

    // ── D2: email is the identity (dedup on email, not name) ──

    it('updates the same contact when the email matches but the name changed', () => {
      crm.upsertContact({ name: 'Alice', email: 'a@x.com' });
      crm.upsertContact({ name: 'Alice Smith', email: 'a@x.com' });
      const all = crm.listContacts({ email: 'a@x.com' });
      expect(all).toHaveLength(1);
      expect(all[0]!.name).toBe('Alice Smith');
    });

    it('keeps two people with the same name but different emails as distinct contacts', () => {
      crm.upsertContact({ name: 'John Smith', email: 'john1@x.com' });
      crm.upsertContact({ name: 'John Smith', email: 'john2@x.com' });
      expect(crm.listContacts({ name: 'John Smith' })).toHaveLength(2);
    });

    it('dedups case-insensitively and stores email lower-cased (round-trips with the resolver lookup)', () => {
      crm.upsertContact({ name: 'Casey', email: 'Casey@Example.COM' });
      crm.upsertContact({ name: 'Casey C', email: 'casey@example.com' });
      // The inbox contact-resolver looks up the lower-cased address — it must hit.
      const found = crm.findContact({ email: 'casey@example.com' });
      expect(found).not.toBeNull();
      expect(found!.email).toBe('casey@example.com');
      expect(crm.listContacts({ email: 'casey@example.com' })).toHaveLength(1);
    });

    it('inserts every email-less contact (NULL emails do not collide — phone-only dedup is out of scope)', () => {
      crm.upsertContact({ name: 'Phone Only A', phone: '111' });
      crm.upsertContact({ name: 'Phone Only B', phone: '222' });
      expect(crm.listContacts()).toHaveLength(2);
    });

    it('does not crash or rebuild a pre-existing non-empty name-keyed contacts table (graceful degradation)', () => {
      // Simulate a legacy table: rows the agent inserted on an older build,
      // when the prompt steered to `data_store_insert into contacts` (name key).
      // dropEmptyCrmOverlaps would NOT drop it (non-empty), so ensureSchema must
      // tolerate it — no throw, no silent rebuild (a real migration is the
      // escalation path).
      ds.createCollection({
        name: 'contacts',
        scope: { type: 'global', id: '' },
        columns: [{ name: 'name', type: 'string' }, { name: 'email', type: 'string' }],
        uniqueKey: ['name'],
      });
      ds.insertRecords({ collection: 'contacts', records: [{ name: 'Legacy', email: 'legacy@x.com' }] });

      expect(() => crm.ensureSchema()).not.toThrow();
      // The legacy key survives (degrades to name-dedup) rather than being
      // silently rebuilt under the agent's data.
      expect(ds.getCollectionInfo('contacts')!.uniqueKey).toEqual(['name']);
    });

    it('lists contacts sorted by last update', () => {
      crm.upsertContact({ name: 'Alice', type: 'customer' });
      crm.upsertContact({ name: 'Bob', type: 'lead' });
      const list = crm.listContacts();
      expect(list).toHaveLength(2);
    });

    it('lists contacts with filter', () => {
      crm.upsertContact({ name: 'Alice', type: 'customer' });
      crm.upsertContact({ name: 'Bob', type: 'lead' });
      const leads = crm.listContacts({ type: 'lead' });
      expect(leads).toHaveLength(1);
      expect(leads[0]!.name).toBe('Bob');
    });
  });

  describe('interactions', () => {
    it('logs and retrieves interactions', () => {
      crm.upsertContact({ name: 'Alice' });
      crm.logInteraction({ contact_name: 'Alice', type: 'message', channel: 'chat', summary: 'Asked about pricing' });
      crm.logInteraction({ contact_name: 'Alice', type: 'email', channel: 'email', summary: 'Sent proposal' });

      const interactions = crm.getInteractions('Alice');
      expect(interactions).toHaveLength(2);
    });

    it('sets date automatically', () => {
      crm.upsertContact({ name: 'Bob' });
      crm.logInteraction({ contact_name: 'Bob', type: 'call', channel: 'manual', summary: 'Follow-up call' });
      const interactions = crm.getInteractions('Bob');
      expect(interactions[0]!['date']).toBeTruthy();
    });
  });

  describe('deals', () => {
    it('creates and retrieves open deals', () => {
      crm.upsertDeal({ title: 'Pro Package', contact_name: 'Alice', value: 4800, stage: 'proposal' });
      crm.upsertDeal({ title: 'Basic Package', contact_name: 'Bob', value: 960, stage: 'lead' });

      const open = crm.getOpenDeals();
      expect(open).toHaveLength(2);
    });

    it('upserts deal by title + contact_name', () => {
      crm.upsertDeal({ title: 'Pro', contact_name: 'Alice', value: 4800, stage: 'proposal' });
      crm.upsertDeal({ title: 'Pro', contact_name: 'Alice', value: 4800, stage: 'negotiation' });

      const open = crm.getOpenDeals();
      expect(open).toHaveLength(1);
      expect(open[0]!['stage']).toBe('negotiation');
    });

    it('excludes won/lost from open deals', () => {
      crm.upsertDeal({ title: 'Won Deal', contact_name: 'Alice', value: 1000, stage: 'won' });
      crm.upsertDeal({ title: 'Open Deal', contact_name: 'Bob', value: 2000, stage: 'qualified' });

      const open = crm.getOpenDeals();
      expect(open).toHaveLength(1);
      expect(open[0]!['title']).toBe('Open Deal');
    });

    it('defaults to CHF currency and lead stage', () => {
      crm.upsertDeal({ title: 'Test', contact_name: 'Alice' });
      const deals = crm.getOpenDeals();
      expect(deals[0]!['currency']).toBe('CHF');
      expect(deals[0]!['stage']).toBe('lead');
    });
  });

  describe('pipeline summary', () => {
    it('returns deal count and total value per stage', () => {
      crm.upsertDeal({ title: 'A', contact_name: 'Alice', value: 1000, stage: 'lead' });
      crm.upsertDeal({ title: 'B', contact_name: 'Bob', value: 2000, stage: 'lead' });
      crm.upsertDeal({ title: 'C', contact_name: 'Carol', value: 5000, stage: 'proposal' });

      const summary = crm.getPipelineSummary();
      expect(summary.length).toBeGreaterThanOrEqual(2);

      const leadStage = summary.find(s => s['stage'] === 'lead');
      expect(leadStage).toBeDefined();
      expect(leadStage!['count']).toBe(2);
      expect(leadStage!['total_value']).toBe(3000);
    });
  });

  describe('contact stats', () => {
    it('returns count by type', () => {
      crm.upsertContact({ name: 'A', type: 'customer' });
      crm.upsertContact({ name: 'B', type: 'customer' });
      crm.upsertContact({ name: 'C', type: 'lead' });

      const stats = crm.getContactStats();
      const customers = stats.find(s => s['type'] === 'customer');
      expect(customers!['count']).toBe(2);
    });
  });
});
