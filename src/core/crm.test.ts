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
      crm.upsertContact({ name: 'Bob', channel_id: 'telegram:123', source: 'telegram' });
      const found = crm.findContact({ channel_id: 'telegram:123' });
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

    it('upserts existing contact (updates fields)', () => {
      crm.upsertContact({ name: 'Alice', type: 'lead' });
      crm.upsertContact({ name: 'Alice', type: 'customer', company: 'Acme' });
      const found = crm.findContact({ name: 'Alice' });
      expect(found!.type).toBe('customer');
      expect(found!.company).toBe('Acme');
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
      crm.logInteraction({ contact_name: 'Alice', type: 'message', channel: 'telegram', summary: 'Asked about pricing' });
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
