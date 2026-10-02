/**
 * The forms of a URL a secret scan reads: the URL as written and, when it differs, the URL with
 * its percent-encoding decoded once.
 *
 * - One round, by decision: a receiving server typically decodes once. A value encoded twice
 *   (`%252D`) is read here as its once-decoded form (`%2D`) and not further.
 * - Decoded leniently: each run of well-formed `%XX` is decoded on its own, and anything else —
 *   a stray `%`, a sequence that is not valid UTF-8 — stays as written. A strict decode of the
 *   whole string gives up at the first such spot and would leave every other encoded value in
 *   the URL undecoded, while a lenient receiver still decodes them.
 *
 * One function for every place that scans a URL, so they cannot drift apart.
 */
export function urlScanForms(url: string): string[] {
  const decoded = url.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      // Not valid UTF-8 as a whole: decode byte by byte, so the ASCII a secret pattern looks
      // for still comes out.
      return run.replace(/%([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    }
  });
  return decoded === url ? [url] : [url, decoded];
}
