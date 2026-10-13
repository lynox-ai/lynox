/**
 * A paginated GET list as the source of an external bulk run (PRD bulk-loop §3.2): the run's
 * targets are the elements of one list on its host, known only once the list is read.
 *
 * This module decides what a list source may be and what its pages turn into; it sends
 * nothing. Three rules carry it:
 *
 * - The ADDRESS the engine reads is built here, never taken from a source. The path is a
 *   plain one under the run's host; the query holds only the names of the list's form (a
 *   provider's documented filters, paging and order), each once, in a fixed order, with a
 *   value of a narrow alphabet. The model that plans a run chooses filter VALUES, never
 *   names: a name decides how a server routes the request, and which names a framework reads
 *   as a route or a method is not a closed set — so the open set is refused, not listed.
 * - A TARGET is `<list path>/<id>`, with the id taken from one top-level field of the
 *   element and held to the same narrow alphabet. No link the provider returns is followed or
 *   used as an address: that would let the provider's content decide where the run writes.
 * - Nothing of an element reaches the model or a log. What a page is decides a fixed reason.
 */
import { BULK_MAX_SOURCE_BYTES, BULK_MAX_TARGET_BYTES, BULK_MAX_TARGETS, BulkSourceError } from './bulk-plan.js';
import { externalTargetKey, isPlainObject, isScalar, BULK_WRITE_METHODS, type BulkWriteMethod, type ExternalImage } from './bulk-external.js';
import { isMailProviderTarget } from './bulk-mail-targets.js';
import { urlScanForms } from './url-scan-forms.js';
import type { BulkInvalidReason } from './bulk-ledger.js';
import type { CapabilityContract } from '../types/capability-contract.js';
import { LIST_QUERY_MAX } from '../tools/permission-guard.js';

/** One provider's list shape: the filters it documents, how it pages and how it orders. */
export interface BulkListFormSpec {
  /** The paths a list of this form lives at — anchored, no `.` segment, no `%`, no trailing
   *  slash. Its filter names mean what they mean only there: a form chosen for any path
   *  would make its names an allowlist everywhere. */
  readonly path: RegExp;
  /** Filter names the planner may give values for. */
  readonly filters: readonly string[];
  readonly pageParam: string;
  readonly perPageParam: string;
  readonly perPage: number;
  /** Fixed parameters that make paging stable: without an order, a page boundary moves. */
  readonly order: readonly (readonly [string, string])[];
  /** The parameter that narrows each element to its id field where the server honours it:
   *  what the list is read for is which targets exist, and the read-back of each target is a
   *  GET of its own. */
  readonly fieldsParam: string;
}

/**
 * The list forms a run can read. WooCommerce first: its REST API pages with `page` and
 * `per_page` (at most 100) and orders by any of a fixed set of fields; ordering by `id`
 * keeps an element from moving between pages while the list is read, unless one is deleted
 * or added at a position already passed. WooCommerce authenticates with a key pair, so it
 * needs no token renewal on the worker path: the key pair stays in the host's API profile.
 */
export const BULK_LIST_FORMS = {
  woocommerce: {
    // The products list: the filters below are the products list's own.
    path: /^\/wp-json\/wc\/v3\/products$/,
    filters: ['category', 'tag', 'status', 'sku', 'type', 'stock_status'],
    pageParam: 'page',
    perPageParam: 'per_page',
    perPage: 50,
    order: [['orderby', 'id'], ['order', 'asc']],
    // WordPress's REST `_fields`: a host that ignores it sends whole records, and the page and
    // byte caps still bound what is read.
    fieldsParam: '_fields',
  },
} as const satisfies Record<string, BulkListFormSpec>;
export type BulkListForm = keyof typeof BULK_LIST_FORMS;

/** What a list source holds once checked: everything the engine needs to read and plan it. */
export interface BulkListSource {
  form: BulkListForm;
  /** The list's path on the run's host: `/seg/seg`, no trailing slash, no query. */
  path: string;
  /** Filter name → value, names from the form only. */
  filters: Record<string, string>;
  /** The top-level field of an element that holds its id. */
  idField: string;
  method: BulkWriteMethod;
  /** The after-state every listed target is planned with (until a judgement replaces it). */
  after: ExternalImage;
}

/** Shown with every list run where the owner starts or approves it (PRD bulk-loop §3.2): a
 *  list read page by page is not a snapshot. */
export const BULK_LIST_NOTE =
  'The list was read page by page, not at one instant: an element added, removed or re-sorted on the host while it ' +
  'was read can be missing from the targets, or listed once only though it moved.';

/** A value the engine puts into a query or an id into a path: nothing a parser could split. */
const TOKEN_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** At most this many bytes of one page are read. */
export const BULK_LIST_PAGE_BYTES = 4 * 1024 * 1024;

/** Pages one list may take: enough for `BULK_MAX_TARGETS` elements, plus the short last one. */
export function maxListPages(form: BulkListForm): number {
  return Math.ceil(BULK_MAX_TARGETS / BULK_LIST_FORMS[form].perPage) + 1;
}

/** The cap on one page's body: the page cap, or what is left of the source's byte budget. */
export function listPageCap(bytesReadSoFar: number): number {
  return Math.max(0, Math.min(BULK_LIST_PAGE_BYTES, BULK_MAX_SOURCE_BYTES - bytesReadSoFar));
}

function isListForm(v: unknown): v is BulkListForm {
  return typeof v === 'string' && Object.hasOwn(BULK_LIST_FORMS, v);
}

/** Whether a stored list source is still one a run may read: its form is still offered and
 *  its path still that form's. A source planned before a form was narrowed is not. */
export function isOfferedListSource(source: BulkListSource): boolean {
  return isListForm(source.form) && BULK_LIST_FORMS[source.form].path.test(source.path);
}

/**
 * Check a list source as the planner gave it. Throws {@link BulkSourceError} with a fixed
 * message; nothing of the input is echoed, since a refusal text is read by the model.
 * `scan` is the egress secret scan, run on the address and the after-state.
 */
export function parseListSource(host: string, input: unknown, method: BulkWriteMethod, scan: (text: string) => string | null): BulkListSource {
  if (!isPlainObject(input)) throw new BulkSourceError('source_list must be an object.');
  const form = input['form'] ?? 'woocommerce';
  if (!isListForm(form)) throw new BulkSourceError(`source_list.form must be one of: ${Object.keys(BULK_LIST_FORMS).join(', ')}.`);
  const spec: BulkListFormSpec = BULK_LIST_FORMS[form];

  const path = input['path'];
  if (typeof path !== 'string') throw new BulkSourceError('source_list.path must be the list\'s path, such as /wp-json/wc/v3/products.');
  const listUrl = `https://${host}${path}`;
  // The same rules a written target is held to, on the address the list is read at. Under
  // today's only form its path rule below is stricter still; this one holds for any form.
  if (externalTargetKey(host, listUrl) !== listUrl) throw new BulkSourceError('source_list.path is not a plain path on target_host.');
  // Before the form's own path rule, so that this refusal holds whatever a form admits.
  if (isMailProviderTarget(listUrl)) throw new BulkSourceError('A bulk run does not read or write a mail provider\'s API.');
  if (!spec.path.test(path)) throw new BulkSourceError(`source_list.path is not a list of the form ${form}.`);

  const rawFilters = input['filters'] ?? {};
  if (!isPlainObject(rawFilters)) throw new BulkSourceError('source_list.filters must be an object of filter names and values.');
  const filters: Record<string, string> = {};
  for (const [name, value] of Object.entries(rawFilters)) {
    if (!spec.filters.includes(name)) {
      throw new BulkSourceError(`source_list.filters may only use: ${spec.filters.join(', ')}.`);
    }
    const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
    if (typeof text !== 'string' || !TOKEN_RE.test(text)) {
      throw new BulkSourceError('A source_list filter value must be 1–64 letters, digits, - or _.');
    }
    filters[name] = text;
  }

  const idField = input['id_field'] ?? 'id';
  if (typeof idField !== 'string' || !FIELD_RE.test(idField)) throw new BulkSourceError('source_list.id_field must be one top-level field name.');

  if (!(BULK_WRITE_METHODS as readonly string[]).includes(method)) throw new BulkSourceError('write_method must be PATCH, PUT or POST.');

  const after = input['after'];
  if (!isPlainObject(after) || Object.keys(after).length === 0) throw new BulkSourceError('source_list.after must be a non-empty object of the fields to set.');
  if (!Object.values(after).every(isScalar)) throw new BulkSourceError('source_list.after may only hold text, numbers, true/false or null.');
  // A run that rewrote the field it identifies its targets by could not check that the
  // target it read back is the one it listed.
  if (Object.hasOwn(after, idField)) throw new BulkSourceError('source_list.after must not set the id field.');
  const afterText = JSON.stringify(after);
  if (Buffer.byteLength(afterText, 'utf8') > BULK_MAX_TARGET_BYTES) throw new BulkSourceError('source_list.after is too large.');
  if (scan(afterText) !== null) throw new BulkSourceError('source_list.after holds something that looks like a credential.');

  const source: BulkListSource = { form, path, filters, idField, method, after: after as ExternalImage };
  // The first page's address is what every page's address is, but for the page number.
  if (urlScanForms(listPageUrl(host, source, 1)).some((f) => scan(f) !== null)) {
    throw new BulkSourceError('The list address looks like it carries a credential.');
  }
  // The longest page address must be one the read grant admits, or the list would stop
  // partway through at the page whose number made it too long.
  const longest = listPageUrl(host, source, maxListPages(form));
  if (longest.length - longest.indexOf('?') - 1 > LIST_QUERY_MAX) {
    throw new BulkSourceError('source_list.filters and id_field make the list address too long.');
  }
  return source;
}

/**
 * The address of one page. Built here, in a fixed order — filters by name, then the form's
 * order, page size and page — from values {@link parseListSource} checked, so it holds
 * nothing a server could read as another parameter.
 */
export function listPageUrl(host: string, source: BulkListSource, page: number): string {
  if (!Number.isSafeInteger(page) || page < 1 || page > maxListPages(source.form)) throw new RangeError('page out of range');
  const spec: BulkListFormSpec = BULK_LIST_FORMS[source.form];
  const pairs: [string, string][] = Object.keys(source.filters).sort().map((n) => [n, source.filters[n]!]);
  pairs.push(...spec.order.map(([n, v]): [string, string] => [n, v]));
  const fields = listFieldsValue(source);
  if (fields !== null) pairs.push([spec.fieldsParam, fields]);
  pairs.push([spec.perPageParam, String(spec.perPage)], [spec.pageParam, String(page)]);
  return `https://${host}${source.path}?${pairs.map(([n, v]) => `${n}=${v}`).join('&')}`;
}

/**
 * The contract a list is read under, stored with the run and shown to the owner before the
 * read starts: GET on the list's path on its host, nothing else. The query its pages carry is
 * granted only on an in-memory copy (`withListQuery` with {@link listQueryParams}).
 */
export function listReadContract(host: string, source: BulkListSource): CapabilityContract {
  return {
    version: 1, origin: 'reviewed', grantedTools: ['http_request'], httpMethods: ['GET'],
    hostPatterns: [host], pathPatterns: [source.path], paramConstraints: {},
  };
}

/** The query names a page address may carry, each with the values it may take. */
export function listQueryParams(source: BulkListSource): Record<string, { enum?: string[]; regex?: string }> {
  const spec: BulkListFormSpec = BULK_LIST_FORMS[source.form];
  const out: Record<string, { enum?: string[]; regex?: string }> = {};
  for (const [n, v] of Object.entries(source.filters)) out[n] = { enum: [v] };
  for (const [n, v] of spec.order) out[n] = { enum: [v] };
  const fields = listFieldsValue(source);
  if (fields !== null) out[spec.fieldsParam] = { enum: [fields] };
  out[spec.perPageParam] = { enum: [String(spec.perPage)] };
  // Exactly the pages the engine may ask for: a pattern over the digits would grant more.
  out[spec.pageParam] = { enum: Array.from({ length: maxListPages(source.form) }, (_, i) => String(i + 1)) };
  return out;
}

/** A field name the fields parameter may carry: a plain lower-case name. One starting with `_`
 *  is a server's own (`_links`, `_embedded`), and naming it there can make the server add
 *  linked records to the page — the opposite of what the parameter is for. */
const FIELDS_VALUE_RE = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * The value of the form's fields parameter for this list, or null when the id field is not a
 * plain name: then no fields parameter is sent, and whole records come back, bounded by the
 * page and byte caps. One answer for both the page address and its grant.
 */
export function listFieldsValue(source: BulkListSource): string | null {
  return FIELDS_VALUE_RE.test(source.idField) ? source.idField : null;
}

/** A page as read: its elements, or `null` when it is not a JSON array. */
export function listPageElements(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

/** An element's id as the text it is addressed by, or why it has none. */
export function listItemId(element: unknown, idField: string): { id: string } | { invalid: BulkInvalidReason } {
  if (!isPlainObject(element)) return { invalid: 'list_item_not_object' };
  if (!Object.hasOwn(element, idField)) return { invalid: 'list_item_no_id' };
  const raw = element[idField];
  // A number only while it is exact: past 2^53 it is a neighbour's id, and `1e21` renders
  // as `1e+21`. The rendered text is checked again either way.
  const text = typeof raw === 'number' ? (Number.isSafeInteger(raw) && raw >= 0 ? String(raw) : null) : typeof raw === 'string' ? raw : null;
  if (text === null || !ID_RE.test(text)) return { invalid: 'list_item_bad_id' };
  return { id: text };
}

/**
 * The target an element names: `<list path>/<id>` on the host, or why it names none. The
 * prefix check below cannot fail for an id {@link listItemId} accepted; it stands so that a
 * later change to how a key is built cannot make a key leave the list (PRD bulk-loop §3.2).
 */
export function listItemKey(host: string, source: BulkListSource, element: unknown): { key: string; id: string } | { invalid: BulkInvalidReason } {
  const got = listItemId(element, source.idField);
  if ('invalid' in got) return got;
  const key = externalTargetKey(host, `https://${host}${source.path}/${got.id}`);
  if (key === null) return { invalid: 'list_item_bad_id' };
  if (!isUnderList(host, source, key)) return { invalid: 'list_item_outside_list' };
  return { key, id: got.id };
}

/** Whether `key` is exactly one segment below the list's path on its host. */
export function isUnderList(host: string, source: BulkListSource, key: string): boolean {
  let url: URL;
  try {
    url = new URL(key);
  } catch {
    return false;
  }
  if (url.hostname !== host || url.search !== '' || url.hash !== '') return false;
  const prefix = `${source.path}/`;
  const rest = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : null;
  return rest !== null && rest !== '' && !rest.includes('/');
}

/** Whether a target read back is the element that was listed: the same id in the same field. */
export function isSameListItem(value: unknown, idField: string, id: string): boolean {
  const got = listItemId(value, idField);
  return 'id' in got && got.id === id;
}
