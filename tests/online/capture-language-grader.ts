/**
 * Grader for the capture-language eval: does a remembered fact read as German or as English?
 *
 * Function words decide, counted on both sides. Words that are the same in both languages
 * (`in`, `will`, `am`, `also`, `pro`, `per`) count for neither. Quoted passages are removed first, so an
 * English fact quoting the operator in German still reads as English. Umlauts and ß count for
 * German only inside a lowercase word, so a name like "Müller AG" in an English sentence does not.
 *
 * The controls below run when the eval file loads. KNOWN_* are the plain cases; MIXED are the
 * borderline ones a review found the first version got wrong (quotes, names, shared words).
 */

const DE = new Set(['der', 'die', 'das', 'den', 'dem', 'des', 'und', 'oder', 'ist', 'sind', 'wird', 'werden', 'hat', 'haben', 'soll', 'sollen', 'muss', 'müssen', 'möchte', 'möchten', 'nicht', 'kein', 'keine', 'ein', 'eine', 'einen', 'einem', 'einer', 'mit', 'für', 'von', 'vom', 'zum', 'zur', 'im', 'auf', 'bei', 'nach', 'vor', 'aus', 'über', 'unter', 'alle', 'allen', 'jede', 'jeder', 'jeden', 'jedes', 'sein', 'seine', 'ihre', 'ihr', 'er', 'sie', 'es', 'wir', 'unsere', 'unser', 'nur', 'auch', 'wenn', 'bevor', 'immer', 'mindestens', 'zwischen', 'je', 'als', 'wie', 'zu', 'beim', 'innert', 'innerhalb', 'tage', 'tagen']);
const EN = new Set(['the', 'a', 'an', 'and', 'or', 'is', 'are', 'was', 'be', 'has', 'have', 'must', 'should', 'wants', 'want', 'requires', 'require', 'needs', 'not', 'no', 'with', 'for', 'of', 'to', 'from', 'by', 'on', 'at', 'all', 'each', 'every', 'its', 'their', 'his', 'her', 'they', 'it', 'we', 'our', 'only', 'when', 'before', 'after', 'always', 'between', 'as', 'that', 'which', 'any', 'never', 'within', 'days']);

export type Lang = 'de' | 'en' | 'unknown';

export function factLanguage(text: string): Lang {
  const unquoted = text.replace(/[„“"«»][^„“"«»]*[“"«»]/g, ' ').replace(/'[^']{12,}'/g, ' ');
  let de = 0;
  let en = 0;
  for (const raw of unquoted.split(/[\s,.;:!?()\-–—/]+/)) {
    if (raw.length === 0) continue;
    const w = raw.toLowerCase();
    if (DE.has(w)) de += 1;
    else if (EN.has(w)) en += 1;
    else if (/^[a-zäöüß]+$/.test(raw) && /[äöüß]/.test(raw)) de += 1;
  }
  if (de > en) return 'de';
  if (en > de) return 'en';
  return 'unknown';
}

/** English facts a German staging instance kept (16.11.), and German forms of such facts. */
export const KNOWN_EN: readonly string[] = [
  'The user has a Shopify shop that they want to improve with better SEO titles and descriptions for products of type \'Glass carafes\'.',
  'The user wants to see a preview of the SEO changes before approving them for publication.',
  'A mass update is planned for the Shopify shop to generate SEO descriptions in German for all active products.',
  'The operator requires a preview of changes before approving any modifications to the shop.',
  'SEO titles for snowboard products must not exceed 60 characters, with product name first followed by \'online kaufen\'.',
  'The Client-ID and Secret are stored under Settings → APIs.',
  'The user operates a Shopify shop and wants product descriptions improved.',
];
export const KNOWN_DE: readonly string[] = [
  'Der Inhaber möchte Änderungen am Shop vor der Freigabe in einer Vorschau sehen.',
  'Der Nutzer betreibt einen Shopify-Shop und will bessere Produktbeschreibungen.',
  'Für den Shop ist ein Shopify-Verbindungsprofil für den Testshop angelegt.',
  'Client-ID und Secret liegen unter Einstellungen → APIs.',
  'Die Firma Keller AG bezahlt Rechnungen immer innert 30 Tagen.',
  'Wir verkaufen nur an Geschäftskunden, nicht an Privatpersonen.',
];
/** Borderline cases with the language they must read as. */
export const MIXED: ReadonlyArray<readonly [string, Lang]> = [
  ['The operator wants: „Ich will jede Änderung am Shop zuerst in einer Vorschau sehen, bevor ich sie freigebe.“', 'en'],
  ['The operator will review every change before it goes live.', 'en'],
  ['Orders go out on Mondays to Müller AG.', 'en'],
  ['Kunde zahlt in 30 Tagen.', 'de'],
  ['Bestellungen gehen jeden Montag raus.', 'de'],
  ['Der Kunde sagte: "We only buy from you."', 'de'],
  // From a dump: German, read as English while `per` counted for English.
  ['Harper & Sons zahlt nur per Banküberweisung.', 'de'],
];

export function controlFailures(): string[] {
  const out: string[] = [];
  for (const s of KNOWN_EN) if (factLanguage(s) !== 'en') out.push(`EN read as ${factLanguage(s)}: ${s}`);
  for (const s of KNOWN_DE) if (factLanguage(s) !== 'de') out.push(`DE read as ${factLanguage(s)}: ${s}`);
  for (const [s, want] of MIXED) if (factLanguage(s) !== want) out.push(`mixed read as ${factLanguage(s)}, want ${want}: ${s}`);
  return out;
}
