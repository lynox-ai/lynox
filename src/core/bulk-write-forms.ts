/**
 * Write forms whose effect on the fields a write does NOT send has been measured on a real
 * provider: a host (or any host, for a path a piece of software fixes itself), a path and a
 * verb. "Measured" means only that: unsent fields stayed as they were. It does not mean that
 * setting a field has no further effect at the provider (a mail, a payment).
 *
 * A run whose every target is a measured form needs one confirmed probe per host, verb and
 * kind of resource, once. A run with any other target is unmeasured: approving it takes an
 * explicit confirmation, and it writes one target first in every run.
 */

export interface MeasuredWriteForm {
  /** Exact host, or `null` for any host — the path is fixed by software the customer runs on their own host. */
  host: string | null;
  /** Matches the whole target path. */
  path: RegExp;
  methods: readonly string[];
  /** When and how it was measured. */
  measured: string;
}

export const MEASURED_WRITE_FORMS: readonly MeasuredWriteForm[] = [
  {
    // WooCommerce runs on the customer's own host, so a foreign server serving the same path
    // counts as measured too; there is no other way to recognise WooCommerce.
    host: null,
    path: /^\/wp-json\/wc\/v3\/products\/[0-9]+$/,
    methods: ['PUT', 'PATCH', 'POST'],
    measured: '2026-10-01 on a WooCommerce server (PUT, PATCH, POST); 2026-10-13 through lynox',
  },
  {
    host: 'api.bexio.com',
    path: /^\/2\.0\/contact\/[0-9]+$/,
    methods: ['POST'],
    measured: '2026-10-01 in a bexio sandbox, end to end through the bulk ledger',
  },
];

/** Whether one target — host, path, verb — is a measured write form. */
export function isMeasuredWriteForm(host: string, path: string, method: string): boolean {
  return MEASURED_WRITE_FORMS.some((f) =>
    (f.host === null || f.host === host) && f.path.test(path) && f.methods.includes(method));
}

/** `measured` when every path is a measured form; an empty path list is `unmeasured`. */
export function writeFormOf(host: string, paths: readonly string[], method: string | null): 'measured' | 'unmeasured' {
  if (method === null || paths.length === 0) return 'unmeasured';
  return paths.every((p) => isMeasuredWriteForm(host, p, method)) ? 'measured' : 'unmeasured';
}

/** Shown with an unmeasured run wherever it is previewed or approved (customer text, approved 2026-10-13). */
export const BULK_UNMEASURED_NOTE =
  'lynox has not checked this kind of change with this provider. It can trigger something else there, such as ' +
  'emails to your customers, a payment or an invoice. So lynox writes one target first. Check it there before you ' +
  'approve the rest.';

/** What the approver of an unmeasured run confirms (customer text, approved 2026-10-13). */
export const BULK_UNMEASURED_CONFIRMATION = 'I know lynox has not checked this kind of change, and I approve it anyway.';
