/**
 * The shape of the CRM's own DataStore collections: what `CRM.ensureSchema` creates.
 *
 * Its own module so the boot-time drop (`DataStore.dropEmptyCrmOverlaps`, called from
 * `Engine._initCoreTools`) can tell the CRM's current collections from stale ones without
 * loading the CRM, which the engine imports lazily later in boot.
 *
 * ⚠ "Current" is decided from what `ds_collections` records: name, scope, columns and
 * unique key. Changing a shape here reaches existing EMPTY collections on the next boot
 * (they no longer match, so they are dropped and recreated). A change that only alters
 * the DDL `DataStore.createCollection` emits for the same shape (a column type mapping,
 * the unique index) does NOT: a kept empty table keeps its old DDL, and that change needs
 * its own migration. `data-store.test.ts` pins that DDL so such a change is noticed.
 */
import type { DataStoreColumnDef, MemoryScopeRef } from '../types/index.js';

export interface CollectionShape {
  readonly name: string;
  readonly scope: Readonly<MemoryScopeRef>;
  readonly columns: readonly Readonly<DataStoreColumnDef>[];
  readonly uniqueKey?: readonly string[] | undefined;
}

export const CRM_SCOPE: Readonly<MemoryScopeRef> = { type: 'global', id: '' };

const CONTACTS_SCHEMA: readonly Readonly<DataStoreColumnDef>[] = [
  { name: 'name', type: 'string' },
  { name: 'email', type: 'string' },
  { name: 'phone', type: 'string' },
  { name: 'company', type: 'string' },
  { name: 'type', type: 'string' },
  { name: 'source', type: 'string' },
  { name: 'channel_id', type: 'string' },
  { name: 'language', type: 'string' },
  { name: 'notes', type: 'string' },
  { name: 'tags', type: 'json' },
];

const DEALS_SCHEMA: readonly Readonly<DataStoreColumnDef>[] = [
  { name: 'title', type: 'string' },
  { name: 'contact_name', type: 'string' },
  { name: 'value', type: 'number' },
  { name: 'currency', type: 'string' },
  { name: 'stage', type: 'string' },
  { name: 'next_action', type: 'string' },
  { name: 'due_date', type: 'date' },
];

const INTERACTIONS_SCHEMA: readonly Readonly<DataStoreColumnDef>[] = [
  { name: 'contact_name', type: 'string' },
  { name: 'type', type: 'string' },
  { name: 'channel', type: 'string' },
  { name: 'summary', type: 'string' },
  { name: 'date', type: 'date' },
];

export const CRM_CONTACTS: CollectionShape = {
  name: 'contacts',
  scope: CRM_SCOPE,
  // Identity = email (unique). The display `name` can change freely
  // (rename → same row, the autoincrement `_id` stays stable, so any
  // history keyed on the contact survives). Two people with the same
  // name but different emails are distinct rows; the same email saved
  // again upserts. Email is normalised to lower-case on write
  // (`upsertContact`) so the dedup — and the inbox contact-resolver's
  // case-insensitive lookup — are consistent end-to-end.
  columns: CONTACTS_SCHEMA,
  uniqueKey: ['email'],
};

export const CRM_DEALS: CollectionShape = {
  name: 'deals',
  scope: CRM_SCOPE,
  columns: DEALS_SCHEMA,
  uniqueKey: ['title', 'contact_name'],
};

export const CRM_INTERACTIONS: CollectionShape = {
  name: 'interactions',
  scope: CRM_SCOPE,
  columns: INTERACTIONS_SCHEMA,
};

export const CRM_COLLECTIONS: readonly CollectionShape[] = [CRM_CONTACTS, CRM_DEALS, CRM_INTERACTIONS];

/**
 * A fresh, mutable copy for `DataStore.createCollection`. `createCollection` hands the
 * caller's `columns` array back in its result, so passing the shape itself would let a
 * caller that edits that result change what counts as the current shape.
 */
export function createParamsOf(shape: CollectionShape): {
  name: string; scope: MemoryScopeRef; columns: DataStoreColumnDef[]; uniqueKey?: string[] | undefined;
} {
  return {
    name: shape.name,
    scope: { ...shape.scope },
    columns: shape.columns.map(c => ({ ...c })),
    ...(shape.uniqueKey ? { uniqueKey: [...shape.uniqueKey] } : {}),
  };
}
