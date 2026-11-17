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
 * inline code and links are removed first, so an English message quoting a German sentence still
 * reads as English. A lowercase word with an umlaut or ß counts for German; a capitalised one does not, so a
 * name like "Zürich" or "Müller AG" in an English sentence does not tip it.
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

/** Each side's count must reach this, and beat the other side by more than double. */
const MIN_WORDS = 2;

export function messageLanguage(text: string): MessageLanguage | null {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\bhttps?:\/\/\S+/g, ' ')
    .replace(/[„“"«»][^„“"«»\n]*[“"«»]/g, ' ');
  let de = 0;
  let en = 0;
  for (const raw of plain.split(/[^\p{L}']+/u)) {
    if (raw.length === 0) continue;
    const word = raw.toLowerCase();
    if (DE.has(word)) de += 1;
    else if (EN.has(word)) en += 1;
    else if (/^[a-zäöüß]+$/.test(raw) && /[äöüß]/.test(raw)) de += 1;
  }
  if (de >= MIN_WORDS && de > 2 * en) return 'de';
  if (en >= MIN_WORDS && en > 2 * de) return 'en';
  return null;
}
