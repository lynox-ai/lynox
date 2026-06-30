/**
 * CRM — automatic contact management, interaction logging, and deal pipeline.
 *
 * Creates standard DataStore tables on first use. Hooks into Email (Gmail)
 * to auto-create contacts and log interactions without manual effort.
 *
 * Schema:
 *   contacts:     name, email, phone, company, type, source, channel_id, language, notes
 *   deals:        title, contact_name, value, currency, stage, next_action, due_date
 *   interactions:  contact_name, type, channel, summary, date
 */

import type { DataStore } from './data-store.js';
import type { EngineDb } from './engine-db.js';
import { SubjectStore } from './subject-store.js';
import { RelationshipStore } from './relationship-store.js';

// ── Types ──

export interface ContactData {
  name: string;
  email?: string | undefined;
  phone?: string | undefined;
  company?: string | undefined;
  /** lead, customer, partner, prospect, other */
  type?: string | undefined;
  /** email, web, manual */
  source?: string | undefined;
  /** External ID: email address, mail account, etc. */
  channel_id?: string | undefined;
  language?: string | undefined;
  notes?: string | undefined;
  /** Tags for segmentation (e.g. ["vip", "newsletter", "tech"]). Stored as JSON. */
  tags?: string[] | undefined;
}

export interface DealData {
  title: string;
  contact_name: string;
  value?: number | undefined;
  currency?: string | undefined;
  /** lead, qualified, proposal, negotiation, won, lost */
  stage?: string | undefined;
  next_action?: string | undefined;
  due_date?: string | undefined;
}

export interface InteractionData {
  contact_name: string;
  /** message, email, call, meeting, note */
  type: string;
  /** email, web, manual */
  channel: string;
  summary: string;
  date?: string | undefined;
}

export type ContactRecord = ContactData & {
  _id?: number | undefined;
  _created_at?: string | undefined;
  _updated_at?: string | undefined;
};

const SCOPE = { type: 'global' as const, id: '' };

const CONTACTS_SCHEMA = [
  { name: 'name', type: 'string' as const },
  { name: 'email', type: 'string' as const },
  { name: 'phone', type: 'string' as const },
  { name: 'company', type: 'string' as const },
  { name: 'type', type: 'string' as const },
  { name: 'source', type: 'string' as const },
  { name: 'channel_id', type: 'string' as const },
  { name: 'language', type: 'string' as const },
  { name: 'notes', type: 'string' as const },
  { name: 'tags', type: 'json' as const },
];

const DEALS_SCHEMA = [
  { name: 'title', type: 'string' as const },
  { name: 'contact_name', type: 'string' as const },
  { name: 'value', type: 'number' as const },
  { name: 'currency', type: 'string' as const },
  { name: 'stage', type: 'string' as const },
  { name: 'next_action', type: 'string' as const },
  { name: 'due_date', type: 'date' as const },
];

const INTERACTIONS_SCHEMA = [
  { name: 'contact_name', type: 'string' as const },
  { name: 'type', type: 'string' as const },
  { name: 'channel', type: 'string' as const },
  { name: 'summary', type: 'string' as const },
  { name: 'date', type: 'date' as const },
];

/**
 * Optional engine.db subject-graph wiring for the CRM (Foundation Rework v2,
 * S1c). When `subjectGraphEnabled` is true and an `engineDb` is supplied, a
 * saved contact is additively mirrored into the subject-graph. Default: inert
 * (prod stays legacy-only until the S2 data migration flips the flag).
 */
export interface CrmSubjectGraphOpts {
  engineDb?: EngineDb | undefined;
  subjectGraphEnabled?: boolean | undefined;
}

/**
 * CRM — contact management, deal pipeline, and interaction logging.
 * Auto-creates schema on first use. All operations are synchronous (SQLite).
 */
export class CRM {
  private readonly ds: DataStore;
  private _initialized = false;
  private readonly engineDb: EngineDb | null;
  private readonly subjectGraphEnabled: boolean;
  private readonly subjectStore: SubjectStore | null;
  private readonly relationshipStore: RelationshipStore | null;

  constructor(dataStore: DataStore, opts?: CrmSubjectGraphOpts) {
    this.ds = dataStore;
    this.engineDb = opts?.engineDb ?? null;
    this.subjectGraphEnabled = opts?.subjectGraphEnabled ?? false;
    if (this.engineDb) {
      this.subjectStore = new SubjectStore(this.engineDb);
      this.relationshipStore = new RelationshipStore(this.engineDb);
    } else {
      this.subjectStore = null;
      this.relationshipStore = null;
    }
  }

  // ── Schema ──

  /** Ensure CRM tables exist. Idempotent — safe to call multiple times. */
  ensureSchema(): void {
    if (this._initialized) return;

    const existing = new Set(this.ds.listCollections().map(c => c.name));

    if (!existing.has('contacts')) {
      this.ds.createCollection({
        name: 'contacts',
        scope: SCOPE,
        // Identity = email (unique). The display `name` can change freely
        // (rename → same row, the autoincrement `_id` stays stable, so any
        // history keyed on the contact survives). Two people with the same
        // name but different emails are distinct rows; the same email saved
        // again upserts. Email is normalised to lower-case on write
        // (`upsertContact`) so the dedup — and the inbox contact-resolver's
        // case-insensitive lookup — are consistent end-to-end.
        columns: CONTACTS_SCHEMA,
        uniqueKey: ['email'],
      });
    } else {
      // A `contacts` collection already exists. The empty case is dropped on
      // boot (`dropEmptyCrmOverlaps`) BEFORE this runs, so it gets recreated
      // above with the email key — the free migration. A NON-empty legacy
      // table (e.g. rows the agent inserted via data_store on older builds,
      // when the prompt still steered to `data_store_insert into contacts`)
      // survives with its original unique key. We do NOT auto-rebuild it (that
      // is a real DataStore migration, the escalation path) — but a silent
      // degradation of the email-identity contract is worse than a visible
      // one, so surface the mismatch in the boot log.
      const info = this.ds.getCollectionInfo('contacts');
      if (info && info.recordCount > 0 && (info.uniqueKey?.join(',') ?? '') !== 'email') {
        process.stderr.write(
          `[lynox] CRM: existing non-empty "contacts" collection has unique key ` +
          `[${info.uniqueKey?.join(', ') ?? '(none)'}], not [email] — contacts_save will ` +
          `dedup on that key until the table is migrated.\n`,
        );
      }
    }

    if (!existing.has('deals')) {
      this.ds.createCollection({
        name: 'deals',
        scope: SCOPE,
        columns: DEALS_SCHEMA,
        uniqueKey: ['title', 'contact_name'],
      });
    }

    if (!existing.has('interactions')) {
      this.ds.createCollection({
        name: 'interactions',
        scope: SCOPE,
        columns: INTERACTIONS_SCHEMA,
      });
    }

    this._initialized = true;
  }

  // ── Contacts ──

  /** Find a contact by name, channel_id, or email. Returns null if not found. */
  findContact(query: { name?: string; channel_id?: string; email?: string }): ContactRecord | null {
    this.ensureSchema();
    const filter: Record<string, unknown> = {};
    if (query.name) filter['name'] = query.name;
    else if (query.channel_id) filter['channel_id'] = query.channel_id;
    else if (query.email) filter['email'] = query.email;
    else return null;

    const result = this.ds.queryRecords({ collection: 'contacts', filter, limit: 1 });
    return (result.rows[0] as unknown as ContactRecord | undefined) ?? null;
  }

  /**
   * Create or update a contact. Identity is the email address (unique key):
   * saving an existing email updates that contact (even under a new display
   * name); a new email inserts a new contact. Email is normalised to a
   * trimmed lower-case form so dedup and the inbox contact-resolver lookup
   * (which lower-cases on read) agree. A contact without an email is always
   * inserted (NULL emails do not collide) — phone-only dedup is out of scope.
   */
  upsertContact(data: ContactData): void {
    this.ensureSchema();
    const normalized: ContactData =
      typeof data.email === 'string' && data.email.trim().length > 0
        ? { ...data, email: data.email.trim().toLowerCase() }
        : data;
    this.ds.insertRecords({ collection: 'contacts', records: [normalized as unknown as Record<string, unknown>] });

    // Foundation Rework v2 (S1c): additively mirror the contact into the
    // engine.db subject-graph behind the flag. Fully isolated — the ds_contacts
    // write above is authoritative; a mirror failure is logged and swallowed so
    // CRM behaviour is never affected. Prod (flag OFF) keeps the legacy path only.
    if (this.subjectGraphEnabled && this.engineDb && this.subjectStore && this.relationshipStore) {
      try {
        this._mirrorContactToSubjectGraph(normalized);
      } catch (err: unknown) {
        process.stderr.write(
          `[lynox:subject-graph] CRM contact mirror failed for ${normalized.name}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }

  /**
   * Mirror a contact into the engine.db subject-graph (S1c): the contact → a
   * `person` subject (+ encrypted PersonDetail), its `company` → an
   * `organization` subject, joined by a `works_for` edge. Name-deduped via
   * SubjectStore.findOrCreate — the contact's email identity can't be reused
   * (email is encrypted at rest in engine.db and not queryable), so identity in
   * the graph is canonical name, not email (CRM↔subject is not 1:1 by design).
   * Plaintext PII is passed in; the detail store encrypts at its own boundary.
   * One engine.db transaction; the email-keyed ds_contacts row stays the source
   * of truth through S1.
   */
  private _mirrorContactToSubjectGraph(c: ContactData): void {
    const name = c.name?.trim();
    if (!name) return;
    this.engineDb!.getDb().transaction(() => {
      const { id: personId } = this.subjectStore!.findOrCreate({ kind: 'person', name });
      if (c.email || c.phone || c.type) {
        this.subjectStore!.setPersonDetail(personId, { email: c.email, phone: c.phone, type: c.type });
      }
      const company = c.company?.trim();
      if (company) {
        const { id: orgId } = this.subjectStore!.findOrCreate({ kind: 'organization', name: company });
        this.relationshipStore!.createRelationship({ fromSubjectId: personId, toSubjectId: orgId, kind: 'works_for' });
      }
    })();
  }

  /** Remove all contacts auto-created from knowledge graph entities. */
  purgeKnowledgeGraphContacts(): number {
    this.ensureSchema();
    return this.ds.deleteRecords({
      collection: 'contacts',
      filter: { source: 'knowledge_graph' },
    });
  }

  /** List contacts with optional filter. */
  listContacts(filter?: Record<string, unknown>, limit = 50): ContactRecord[] {
    this.ensureSchema();
    const result = this.ds.queryRecords({
      collection: 'contacts',
      filter,
      sort: [{ field: '_updated_at', order: 'desc' }],
      limit,
    });
    return result.rows as unknown as ContactRecord[];
  }


  // ── Interactions ──

  /** Log an interaction. */
  logInteraction(data: InteractionData): void {
    this.ensureSchema();
    this.ds.insertRecords({
      collection: 'interactions',
      records: [{
        ...data,
        date: data.date ?? new Date().toISOString(),
      }],
    });
  }

  /** Get recent interactions for a contact. */
  getInteractions(contactName: string, limit = 20): Array<Record<string, unknown>> {
    this.ensureSchema();
    const result = this.ds.queryRecords({
      collection: 'interactions',
      filter: { contact_name: contactName },
      sort: [{ field: 'date', order: 'desc' }],
      limit,
    });
    return result.rows;
  }

  // ── Deals ──

  /** Create or update a deal. Uses title + contact_name as unique key. */
  upsertDeal(data: DealData): void {
    this.ensureSchema();
    this.ds.insertRecords({
      collection: 'deals',
      records: [{
        ...data,
        currency: data.currency ?? 'CHF',
        stage: data.stage ?? 'lead',
      }],
    });
  }

  /** Get all open deals (not won/lost). */
  getOpenDeals(limit = 50): Array<Record<string, unknown>> {
    this.ensureSchema();
    const result = this.ds.queryRecords({
      collection: 'deals',
      filter: { stage: { $nin: ['won', 'lost'] } },
      sort: [{ field: 'due_date', order: 'asc' }],
      limit,
    });
    return result.rows;
  }

  /** Get deals linked to a specific contact. */
  getDealsForContact(contactName: string, limit = 50): Array<Record<string, unknown>> {
    this.ensureSchema();
    const result = this.ds.queryRecords({
      collection: 'deals',
      filter: { contact_name: contactName },
      sort: [{ field: '_updated_at', order: 'desc' }],
      limit,
    });
    return result.rows;
  }

  /** Get all deals (optionally filtered by stage). */
  getAllDeals(filter?: Record<string, unknown>, limit = 50): Array<Record<string, unknown>> {
    this.ensureSchema();
    const result = this.ds.queryRecords({
      collection: 'deals',
      filter: filter && Object.keys(filter).length > 0 ? filter : undefined,
      sort: [{ field: '_updated_at', order: 'desc' }],
      limit,
    });
    return result.rows;
  }

  /** Get pipeline summary (deal count + total value per stage). */
  getPipelineSummary(): Array<Record<string, unknown>> {
    this.ensureSchema();
    const result = this.ds.queryRecords({
      collection: 'deals',
      filter: { stage: { $nin: ['won', 'lost'] } },
      aggregate: {
        groupBy: ['stage'],
        metrics: [
          { field: '*', fn: 'count', alias: 'count' },
          { field: 'value', fn: 'sum', alias: 'total_value' },
        ],
      },
    });
    return result.rows;
  }

  // ── Stats ──

  /** Get contact count by type. */
  getContactStats(): Array<Record<string, unknown>> {
    this.ensureSchema();
    const result = this.ds.queryRecords({
      collection: 'contacts',
      aggregate: {
        groupBy: ['type'],
        metrics: [{ field: '*', fn: 'count', alias: 'count' }],
      },
    });
    return result.rows;
  }

  /** Whether the CRM schema has been initialized. */
  get initialized(): boolean {
    return this._initialized;
  }
}
