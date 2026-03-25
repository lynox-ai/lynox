/**
 * CRM — automatic contact management, interaction logging, and deal pipeline.
 *
 * Creates standard DataStore tables on first use. Hooks into Telegram/Email
 * to auto-create contacts and log interactions without manual effort.
 *
 * Schema:
 *   contacts:     name, email, phone, company, type, source, channel_id, language, notes
 *   deals:        title, contact_name, value, currency, stage, next_action, due_date
 *   interactions:  contact_name, type, channel, summary, date
 */

import type { DataStore } from './data-store.js';

// ── Types ──

export interface ContactData {
  name: string;
  email?: string | undefined;
  phone?: string | undefined;
  company?: string | undefined;
  /** lead, customer, partner, prospect, other */
  type?: string | undefined;
  /** telegram, email, web, manual */
  source?: string | undefined;
  /** External ID: Telegram chat ID, email address, etc. */
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
  /** telegram, email, web, manual */
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
 * CRM — contact management, deal pipeline, and interaction logging.
 * Auto-creates schema on first use. All operations are synchronous (SQLite).
 */
export class CRM {
  private readonly ds: DataStore;
  private _initialized = false;

  constructor(dataStore: DataStore) {
    this.ds = dataStore;
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
        columns: CONTACTS_SCHEMA,
        uniqueKey: ['name'],
      });
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

  /** Create or update a contact. Uses name as unique key (upsert). */
  upsertContact(data: ContactData): void {
    this.ensureSchema();
    this.ds.insertRecords({ collection: 'contacts', records: [data as unknown as Record<string, unknown>] });
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
