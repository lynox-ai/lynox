import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DataStore } from './data-store.js';
import { CRM } from './crm.js';
import { EngineDb } from './engine-db.js';
import { SubjectStore } from './subject-store.js';

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

  describe('deleteContact', () => {
    it('THE POINT: a wrong contact can be removed at all', () => {
      // Before this the CRM had NO removal path. `contacts_save` upserts on email, so a wrong
      // row could only be overwritten — and only if it has one.
      crm.upsertContact({ name: 'Wrong Person', email: 'wrong@example.com', source: 'agent' });
      const [row] = crm.listContacts();
      expect(row?._id).toBeDefined();
      expect(crm.deleteContact(row!._id!)).toBe(true);
      expect(crm.listContacts()).toHaveLength(0);
    });

    it('removes ONLY the named row', () => {
      // A filter that matched more than the id would take the neighbours with it.
      crm.upsertContact({ name: 'Keep Me', email: 'keep@example.com', source: 'agent' });
      crm.upsertContact({ name: 'Drop Me', email: 'drop@example.com', source: 'agent' });
      const drop = crm.listContacts().find(c => c.name === 'Drop Me')!;
      crm.deleteContact(drop._id!);
      const left = crm.listContacts();
      expect(left).toHaveLength(1);
      expect(left[0]?.name).toBe('Keep Me');
    });

    it('reports false for an id that is not there, instead of pretending', () => {
      expect(crm.deleteContact(999_999)).toBe(false);
    });

    it('removes an EMAIL-LESS contact — the case re-saving could never repair', () => {
      // A NULL email never collides, so every re-save inserted another row. Lead research
      // produces exactly these.
      crm.upsertContact({ name: 'Researched Lead', company: 'Some Clinic', source: 'agent_external' });
      const row = crm.listContacts()[0]!;
      expect(crm.deleteContact(row._id!)).toBe(true);
      expect(crm.listContacts()).toHaveLength(0);
    });

    it('takes the interactions and deals with it', () => {
      // Otherwise "remove this person" deletes the row holding their phone number and keeps
      // the notes ABOUT them — `interactions.summary` is free text on what was discussed, and
      // both collections stay readable by name through their own routes.
      crm.upsertContact({ name: 'Alte Kundin', email: 'alt@example.com', source: 'agent' });
      crm.logInteraction({ contact_name: 'Alte Kundin', type: 'call', summary: 'Wollte einen Termin im Herbst' });
      crm.upsertDeal({ title: 'Beratung', contact_name: 'Alte Kundin', value: 900, stage: 'proposal' });
      expect(crm.getInteractions('Alte Kundin')).toHaveLength(1);
      expect(crm.getDealsForContact('Alte Kundin')).toHaveLength(1);

      const row = crm.listContacts().find(c => c.name === 'Alte Kundin')!;
      expect(crm.deleteContact(row._id!)).toBe(true);
      expect(crm.getInteractions('Alte Kundin')).toHaveLength(0);
      expect(crm.getDealsForContact('Alte Kundin')).toHaveLength(0);
    });

    it('leaves another contact\'s interactions and deals alone', () => {
      // The cascade is keyed by NAME, so a filter that is too loose takes the neighbours' history.
      crm.upsertContact({ name: 'Geht Weg', email: 'weg@example.com', source: 'agent' });
      crm.upsertContact({ name: 'Bleibt Da', email: 'bleibt@example.com', source: 'agent' });
      crm.logInteraction({ contact_name: 'Geht Weg', type: 'call', summary: 'a' });
      crm.logInteraction({ contact_name: 'Bleibt Da', type: 'call', summary: 'b' });
      crm.upsertDeal({ title: 'D1', contact_name: 'Bleibt Da', value: 100, stage: 'lead' });

      const row = crm.listContacts().find(c => c.name === 'Geht Weg')!;
      crm.deleteContact(row._id!);
      expect(crm.getInteractions('Bleibt Da')).toHaveLength(1);
      expect(crm.getDealsForContact('Bleibt Da')).toHaveLength(1);
    });

    it('keeps a NAMESAKE\'s interactions and deals — the case the neighbour test cannot see', () => {
      // The test above passes with different names, which is the easy half. `interactions` and
      // `deals` are keyed by `contact_name`, so two people called the same thing share one key
      // and the cascade cannot tell them apart — it deleted the survivor's entire history.
      // Not orphaned rows: gone, with nothing to restore them from. Common name, one duplicate
      // cleaned up, a real customer's record silently emptied.
      crm.upsertContact({ name: 'Michael Müller', email: 'michael@firma-a.ch', source: 'agent' });
      crm.upsertContact({ name: 'Michael Müller', email: 'michael@firma-b.ch', source: 'agent' });
      crm.logInteraction({ contact_name: 'Michael Müller', type: 'call', summary: 'Angebot besprochen' });
      crm.upsertDeal({ title: 'Wartung', contact_name: 'Michael Müller', value: 4200, stage: 'proposal' });

      const both = crm.listContacts().filter(c => c.name === 'Michael Müller');
      expect(both).toHaveLength(2);
      expect(crm.deleteContact(both[0]!._id!)).toBe(true);

      // The other Michael Müller is still a contact, so the history still has an owner.
      expect(crm.listContacts().filter(c => c.name === 'Michael Müller')).toHaveLength(1);
      expect(crm.getInteractions('Michael Müller')).toHaveLength(1);
      expect(crm.getDealsForContact('Michael Müller')).toHaveLength(1);
    });

    it('cascades once the LAST namesake goes', () => {
      // The other direction, and it has to be stated: a guard that keeps history whenever a
      // name was ever shared would leak rows forever. Deleting the second of two identical
      // names leaves no owner, so the cascade must fire — the test above is satisfied by a
      // cascade that never runs at all.
      crm.upsertContact({ name: 'Michael Müller', email: 'michael@firma-a.ch', source: 'agent' });
      crm.upsertContact({ name: 'Michael Müller', email: 'michael@firma-b.ch', source: 'agent' });
      crm.logInteraction({ contact_name: 'Michael Müller', type: 'call', summary: 'Angebot besprochen' });
      crm.upsertDeal({ title: 'Wartung', contact_name: 'Michael Müller', value: 4200, stage: 'proposal' });

      for (const c of crm.listContacts().filter(c => c.name === 'Michael Müller')) {
        crm.deleteContact(c._id!);
      }
      expect(crm.getInteractions('Michael Müller')).toHaveLength(0);
      expect(crm.getDealsForContact('Michael Müller')).toHaveLength(0);
    });

    it('touches nothing when the id was not there', () => {
      crm.upsertContact({ name: 'Unbeteiligt', email: 'u@example.com', source: 'agent' });
      crm.logInteraction({ contact_name: 'Unbeteiligt', type: 'call', summary: 'x' });
      expect(crm.deleteContact(999_999)).toBe(false);
      expect(crm.listContacts()).toHaveLength(1);
      expect(crm.getInteractions('Unbeteiligt')).toHaveLength(1);
    });
  });

  describe('subject-graph mirror', () => {
    it('logs an ambiguous-name failure WITHOUT the contact name (data minimisation)', () => {
      // The mirror's catch writes `err.message` to stderr under an explicit promise that
      // the contact name is omitted as plaintext PII. An error carrying the colliding
      // names breaks that promise silently — it did, and only a mutation caught it, so
      // the PATH is asserted here rather than the helper in isolation.
      const engineDb = new EngineDb(join(tmpDir, 'engine.db'), '');
      const graphCrm = new CRM(ds, { engineDb, subjectGraphEnabled: true });
      graphCrm.ensureSchema();
      const subjects = new SubjectStore(engineDb);
      subjects.findOrCreate({ kind: 'person', name: 'Anna Meier', aliases: ['Meier'] });
      subjects.findOrCreate({ kind: 'person', name: 'Bernd Meier', aliases: ['Meier'] });

      const written: string[] = [];
      const orig = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string | Uint8Array): boolean => {
        written.push(String(chunk)); return true;
      }) as typeof process.stderr.write;
      try {
        graphCrm.upsertContact({ name: 'Meier', email: 'meier@example.test' });
      } finally {
        process.stderr.write = orig;
        engineDb.close();
      }

      const log = written.join('');
      expect(log).toContain('mirror failed');        // it DID hit the ambiguous path
      expect(log).not.toContain('Meier');            // ...without naming anyone
      expect(log).not.toContain('Anna');
      // and the contact itself was still saved — only the graph edge was skipped
      expect(graphCrm.listContacts().some(c => c.name === 'Meier')).toBe(true);
    });

    it('holds the same promise for the COMPANY branch, not just the person one', () => {
      // The mirror resolves two names: the contact and its company. Both go through the
      // same log, so both need the name-free error — and asserting only the person branch
      // left the company one revertible with the whole suite green.
      const engineDb = new EngineDb(join(tmpDir, 'engine-org.db'), '');
      const graphCrm = new CRM(ds, { engineDb, subjectGraphEnabled: true });
      graphCrm.ensureSchema();
      const subjects = new SubjectStore(engineDb);
      subjects.findOrCreate({ kind: 'organization', name: 'Nordwerk Bau AG', aliases: ['Nordwerk'] });
      subjects.findOrCreate({ kind: 'organization', name: 'Nordwerk Handel AG', aliases: ['Nordwerk'] });

      const written: string[] = [];
      const orig = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string | Uint8Array): boolean => {
        written.push(String(chunk)); return true;
      }) as typeof process.stderr.write;
      try {
        // an UNambiguous person, so only the company lookup can be the one that fails
        graphCrm.upsertContact({ name: 'Rita Fuchs', company: 'Nordwerk', email: 'rita@example.test' });
      } finally {
        process.stderr.write = orig;
        engineDb.close();
      }

      const log = written.join('');
      expect(log).toContain('mirror failed');
      expect(log).not.toContain('Nordwerk');
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
