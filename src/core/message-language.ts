/**
 * The language a message is written in, decided by code rather than left to a model: German,
 * English, or `null` when the words do not settle it.
 *
 * A small helper model asked to write "in the language of the message" does not reliably do so
 * (a fast model titled an English message in Portuguese, German, Russian or Romanian in more than
 * half of its runs). Naming the language outright is what it follows. Only German and English are
 * decided, the two languages the product speaks; anything else (another language, a one-word
 * reply, a message that mixes both) is `null`, and the caller keeps its general wording.
 *
 * Function words decide, counted on both sides. Words spelled the same in both languages (`in`,
 * `an`, `will`, `am`, `also`, `so`, `was`, `die`, `es`, `da`) count for neither. Quoted passages,
 * inline code, links and domain names (also the one in a mail address) are removed first, so an
 * English message quoting a German sentence still reads as English, and `info@firma.de` does not
 * count. A
 * lowercase word with an umlaut or ß counts for German; a capitalised one does not, so a name like
 * "Zürich" or "Müller AG" in an English sentence does not tip it.
 */

export type MessageLanguage = 'de' | 'en';

const DE = new Set([
  'der', 'den', 'dem', 'des', 'das', 'und', 'oder', 'aber', 'ist', 'sind', 'wird', 'werden', 'hat',
  'haben', 'kann', 'kannst', 'können', 'soll', 'sollte', 'muss', 'nicht', 'kein', 'keine', 'ein',
  'eine', 'einen', 'einem', 'einer', 'mit', 'für', 'von', 'vom', 'zum', 'zur', 'im', 'auf', 'bei',
  'nach', 'aus', 'über', 'unter', 'alle', 'jede', 'jeden', 'wir', 'uns', 'unsere', 'unser', 'ich',
  'mir', 'mich', 'mein', 'meine', 'meinen', 'meiner', 'du', 'dir', 'dich', 'dein', 'deine', 'nur',
  'auch', 'noch', 'schon', 'wenn', 'dass', 'ob', 'wie', 'welche', 'welcher', 'welches', 'warum',
  'bitte', 'zu', 'diese', 'dieser', 'diesen', 'diesem', 'sie', 'ihr', 'ihre', 'mach', 'gib',
  'zeig', 'zeige', 'schreib', 'schreibe', 'erstelle', 'prüfe', 'erkläre', 'ja', 'nein', 'danke',
  'jetzt', 'heute', 'morgen', 'immer', 'nie', 'hier', 'dort',
]);
const EN = new Set([
  'the', 'a', 'and', 'or', 'but', 'is', 'are', 'be', 'been', 'has', 'have', 'had', 'can',
  'could', 'should', 'would', 'must', 'not', 'no', 'with', 'for', 'of', 'to', 'from', 'by', 'on',
  'at', 'all', 'each', 'every', 'its', 'their', 'they', 'it', 'we', 'us', 'our', 'i', 'me', 'my',
  'you', 'your', 'only', 'too', 'still', 'already', 'when', 'that', 'whether', 'if', 'how', 'which',
  'what', 'why', 'please', 'this', 'these', 'those', 'there', 'here', 'do', 'does', 'did', 'make',
  'give', 'show', 'write', 'create', 'check', 'explain', 'yes', 'thanks', 'now', 'today',
  'tomorrow', 'always', 'never', 'just', 'about', 'into', 'then', 'than',
]);

/**
 * Common words of the other languages the product offers (French, Italian, Spanish, Dutch,
 * Portuguese, Swedish). Several of them would otherwise count as English (`a`, `no`, `me`, `is`,
 * `on`) and turn a Spanish or Dutch message English. Two of them in a message and it is not
 * decided. Left out: words that are also German or English, or that a German or English message
 * carries as a part or an abbreviation (`du`, `des`, `je`, `um`, `da`, `van`, `non`, `per`, `do`,
 * `den`, `os`; `e` and `eu` from "E-Mail" and "EU", `mi` for Mittwoch, `se` from "SAP SE", `y`).
 */
const OTHER = new Set([
  'le', 'la', 'les', 'et', 'est', 'une', 'un', 'que', 'qui', 'pour', 'pas', 'vous', 'nous', 'il',
  'avec', 'toi', 'moi', 'sont', 'mais', 'très', 'el', 'los', 'las', 'de', 'del', 'muy', 'por',
  'para', 'con', 'una', 'pero', 'lo', 'gusta', 'che', 'della', 'sono', 'sia', 'troppo', 'questo',
  'het', 'een', 'ik', 'niet', 'voor', 'ons', 'dit', 'zijn', 'wij', 'não', 'é',
  'uma', 'och', 'jag', 'har', 'är', 'inte', 'att', 'det', 'som', 'på', 'bor', 'en',
]);
const OTHER_WORDS = 2;

/** Each side's count must reach this, and beat the other side by more than double. */
const MIN_WORDS = 2;

interface Count { de: number; en: number; other: number }

function count(text: string): Count {
  const c: Count = { de: 0, en: 0, other: 0 };
  for (const raw of text.split(/[^\p{L}']+/u)) {
    if (raw.length === 0) continue;
    const word = raw.toLowerCase();
    if (OTHER.has(word)) c.other += 1;
    else if (DE.has(word)) c.de += 1;
    else if (EN.has(word)) c.en += 1;
    else if (/^[a-zäöüß]+$/.test(raw) && /[äöüß]/.test(raw)) c.de += 1;
  }
  return c;
}

export function messageLanguage(text: string): MessageLanguage | null {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\bhttps?:\/\/\S+/g, ' ')
    .replace(/\b[\w-]+\.(?:de|ch|at|com|net|org|io|fr|it|es|nl|pt|se)\b/gi, ' ')
    .replace(/[„“"«»][^„“"«»\n]*[“"«»]/g, ' ');
  const all = count(plain);
  if (all.other >= OTHER_WORDS) return null;
  const language: MessageLanguage | null = all.de >= MIN_WORDS && all.de > 2 * all.en ? 'de'
    : all.en >= MIN_WORDS && all.en > 2 * all.de ? 'en'
    : null;
  if (language === null) return null;
  // The opening words are the user's own instruction; what follows may be pasted text in another
  // language ("Fass das zusammen: The quarterly report …"). If the opening leans the other way,
  // the message is not decided.
  // A single word ("Thanks!", "Check:") is not an instruction in the other language; an opening of
  // three words or more with one, or two such words, is.
  const opening = plain.trimStart().split(/[:\n.?!]/u, 1)[0] ?? '';
  const head = count(opening);
  const words = opening.split(/[^\p{L}']+/u).filter((w) => w.length > 0).length;
  const [against, forIt] = language === 'de' ? [head.en, head.de] : [head.de, head.en];
  const other = against > forIt && (against >= 2 || words >= 3);
  return other ? null : language;
}
