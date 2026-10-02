/**
 * The forms of a URL a secret scan reads: the URL as written and, when it differs, the URL with
 * its percent-encoding decoded once.
 *
 * - One round, by decision: a receiving server typically decodes once. A value encoded twice
 *   (`%252D`) is read here as its once-decoded form (`%2D`) and not further.
 * - A URL `decodeURIComponent` refuses (a stray `%`) is scanned as written only — there is no
 *   decoded form to scan. Whether a receiver decodes it more leniently is not known.
 *
 * One function for every egress path that scans a URL, so the paths cannot drift apart.
 */
export function urlScanForms(url: string): string[] {
  let decoded: string;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    return [url];
  }
  return decoded === url ? [url] : [url, decoded];
}
