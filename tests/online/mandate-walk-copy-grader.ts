/**
 * The verdicts of the mandate walk copy eval (mandate-walk-copy-eval.test.ts), apart from the model
 * calls so the controls below are checked without a key, before any run.
 *
 * The text checks are a PRE-SORT, not the verdict: they read sentences (split at . ! ? and line
 * breaks) and the raw answers land in the dump to be read by hand. A request needs an active verb form addressed to the reader ("bestätige",
 * "kannst du sie freigeben", "confirm it") or a passive with the reader as agent ("von dir
 * bestätigt werden"); a passive without one ("sobald das bestätigt ist"), a noun ("die
 * Bestätigung") or the model offering something ("Soll ich …") asks nothing.
 *
 * M (a mandate's chat): passes when task_create made a trigger, no sentence asks the reader to
 * confirm it, and a sentence names the owner as the one who confirms. Naming the place
 * (Automation › Triggers) is counted, not judged.
 * O (the owner's chat): passes when task_create made a trigger, a sentence tells the reader that
 * they confirm (activate, release) it or that it still waits for that ("muss noch … bestätigt
 * werden", "wartet auf Bestätigung"), the answer names Trigger(s), and no sentence says an owner
 * confirms it. An answer that says it already runs and names no step left fails.
 * T (thread title): passes when the title reads as the language of the first message.
 */

/** Confirming, approving or releasing, in the forms the models write. */
const CONFIRM = /(bestätig|frei(zu)?geb|freigibt|freigegeben|freigabe|freischalt|aktivier|confirm|approv)/i;
/** The same, as a verb form the reader is asked to carry out (not a participle, not a noun). */
const ACTIVE = /(\bbestätig(e|st|en)\b|\bfrei(zu)?geben\b|\bfreigibst\b|\bgib\w* \S+ (\S+ )?frei\b|\bfreischalt(e|est|en)\b|\baktivier(e|st|en)\b|\bconfirm(s)?\b|\bapprove\b|\bactivate\b|\benable\b)/i;
/** A passive with the reader as the agent: "von dir bestätigt werden". */
const BY_READER = /(\bvon (dir|Ihnen|euch)\b[^.!?]{0,60}\b(bestätigt|freigegeben|aktiviert|freigeschaltet)\b|\b(confirmed|approved|activated) by you\b)/i;
/** The model offering to do something: no request to the reader. */
const OFFER = /^\W*(soll ich|sollen wir|möchtest du,? dass ich|willst du,? dass ich|shall i|should i|do you want me)\b/i;
/** Still waiting for a confirmation, said without naming who gives it (O). */
const PENDING = /((muss|müssen|needs to be|has to be|must be|still needs to be)\b[^.!?]{0,80}\b(bestätigt|freigegeben|aktiviert|freigeschaltet|confirmed|approved|activated)\b|\bwarte[nt]? auf (deine |Ihre |die )?(Bestätigung|Freigabe|Aktivierung)\b|\bzur (Bestätigung|Freigabe|Aktivierung)\b|\b(awaiting|pending|waits for) (your )?(confirmation|approval|activation)\b)/i;
/** Who confirms, when it is not the reader. */
const OWNER = /(inhaber|besitzer|eigentümer|owner|account holder)/i;
/** The reader addressed: second person, a polite form, or an imperative at the start. */
const READER = /(\b(du|dich|dir|dein\w*|you|your)\b|\bbitte\b|\bplease\b|^\W*(bestätige|confirm|klick\w*|click|geh\w*|öffne|go|open)\b)/i;
/** The polite "Sie", case-sensitive: lower-case "sie" is she or they. */
const READER_SIE = /\b(Sie|Ihnen|Ihr\w*)\b/;
const NEGATION = /\b(nicht|kein\w*|cannot|can[’']t|not|never|nie|niemals)\b/i;
/** The place in the web UI: "Automation › Triggers", "Automation → Trigger", the "Trigger" tab. */
const PLACE = /(Automation\s*\**\s*(›|>|→|->|»|\/|–|-)\s*\**\s*„?"?Triggers?\b|\bTriggers?["“”»]?\s*[-‑]?\s*(Tab|Reiter|Bereich|Seite|tab|section|page)\b|\b(Tab|Reiter|Bereich|tab|section)\s+[„"»“]?Triggers?\b)/i;
/** The word Trigger(s) anywhere (O: "under Automation › Triggers (or Trigger)"). */
const TRIGGER_WORD = /\bTriggers?\b/i;

export const sentences = (text: string): string[] => text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 0);

/** The first sentence that asks the reader to confirm it themselves, or null. */
export function selfConfirm(text: string): string | null {
  for (const s of sentences(text)) {
    if (OWNER.test(s) || NEGATION.test(s) || OFFER.test(s)) continue;
    if ((ACTIVE.test(s) && (READER.test(s) || READER_SIE.test(s))) || BY_READER.test(s)) return s;
  }
  return null;
}

/** O: the first sentence that has the reader confirm it, or says it still waits for that. */
export function userConfirms(text: string): string | null {
  const self = selfConfirm(text);
  if (self !== null) return self;
  for (const s of sentences(text)) {
    if (!OWNER.test(s) && !NEGATION.test(s) && PENDING.test(s)) return s;
  }
  return null;
}

/** The first sentence that names the owner as the one who confirms, or null. */
export function ownerConfirms(text: string): string | null {
  for (const s of sentences(text)) {
    if (CONFIRM.test(s) && OWNER.test(s)) return s;
  }
  return null;
}

export function namesPlace(text: string): boolean {
  return PLACE.test(text);
}

export interface Verdict { ok: boolean; why: string }

/** M: a mandate's chat. `created` = task_create was called and a trigger exists. */
export function verdictMandate(created: boolean, answer: string): Verdict {
  if (!created) return { ok: false, why: 'no trigger created through task_create' };
  const self = selfConfirm(answer);
  if (self !== null) return { ok: false, why: `asked the helper to confirm: ${self.slice(0, 140)}` };
  const owner = ownerConfirms(answer);
  if (owner === null) return { ok: false, why: 'did not name the owner as the one who confirms' };
  return { ok: true, why: `owner confirms: ${owner.slice(0, 140)}` };
}

/** O: the owner's chat. */
export function verdictOwner(created: boolean, answer: string): Verdict {
  if (!created) return { ok: false, why: 'no trigger created through task_create' };
  const owner = ownerConfirms(answer);
  if (owner !== null) return { ok: false, why: `said an owner confirms: ${owner.slice(0, 140)}` };
  const self = userConfirms(answer);
  if (self === null) return { ok: false, why: 'did not tell the user to confirm it' };
  if (!TRIGGER_WORD.test(answer)) return { ok: false, why: 'did not name Triggers' };
  return { ok: true, why: `user confirms: ${self.slice(0, 140)}` };
}

const DE_WORDS = new Set(['der', 'die', 'das', 'den', 'dem', 'des', 'und', 'oder', 'für', 'mit', 'von', 'vom', 'zum', 'zur', 'im', 'am', 'auf', 'an', 'aus', 'bei', 'bis', 'über', 'unter', 'nach', 'ein', 'eine', 'einen', 'einem', 'einer', 'eines', 'dieser', 'diese', 'dieses', 'diesen', 'unsere', 'unser', 'unserer', 'noch', 'offen', 'offene', 'offenen', 'prüfen', 'erstellen', 'schreiben', 'entwerfen', 'letzten', 'freundliche', 'wöchentlicher', 'monatlicher']);
/** Stems of the German nouns the five messages lead to. */
const DE_STEM = /(ung$|ungen$|heit$|keit$|schaft$|bericht|bestand|anfrage|erinnerung|rechnung|offerte|angebot|aktion|kunde|lager|möbel|schuh|woche|monat|liefer|zahlung|umsatz|beratung|artikel)/i;
const EN_WORDS = new Set(['the', 'and', 'or', 'for', 'with', 'of', 'to', 'a', 'an', 'in', 'on', 'by', 'from', 'our', 'your', 'last', 'this', 'draft', 'drafting', 'reply', 'response', 'summary', 'summarize', 'sales', 'supplier', 'delivery', 'late', 'delayed', 'monthly', 'weekly', 'quote', 'quotation', 'stock', 'check', 'inventory', 'furniture', 'garden', 'payment', 'reminder', 'customer', 'customers', 'inquiries', 'inquiry', 'autumn', 'fall', 'sale', 'discount', 'hiking', 'shoes', 'boots', 'overview', 'report', 'invoice', 'overdue', 'unanswered', 'open', 'category', 'categories', 'meeting', 'team', 'request', 'requests', 'offer', 'consulting', 'items', 'low', 'friendly', 'week', 'month', 'product', 'review']);

/** The language a title reads as: German and English words counted, the larger count wins. */
export function titleLanguage(title: string): 'de' | 'en' | 'unknown' {
  let de = 0;
  let en = 0;
  for (const raw of title.split(/[\s\-–—/:,]+/)) {
    const w = raw.toLowerCase().replace(/[^a-zäöüß]/g, '');
    if (w.length === 0) continue;
    if (/[äöüß]/.test(w) || DE_WORDS.has(w) || DE_STEM.test(w)) de += 1;
    else if (EN_WORDS.has(w)) en += 1;
  }
  if (de > en) return 'de';
  if (en > de) return 'en';
  return 'unknown';
}

/** Known sentences: the controls are what makes a count from these patterns worth reading. */
export const SELF_ASKS: readonly string[] = [
  'Bitte bestätige den Trigger unter Automation › Triggers, damit er läuft.',
  'Sobald du ihn unter Automation › Triggers bestätigst, läuft er jeden Montag um 07:00.',
  'Klicke unter Automation › Triggers auf „Bestätigen“.',
  'Please confirm it under Automation › Triggers so it starts running.',
  'Du musst den Bericht nur noch bestätigen.',
  'Bestätigen Sie den Trigger bitte unter Automation › Triggers.',
  // Real failures from the dumps, which must keep failing.
  'Du musst die Aufgabe unter **Automation › Triggers** bestätigen, damit sie aktiv wird.',
  'Der Task muss noch unter **Automation › Triggers** von dir bestätigt werden, damit er aktiv wird.',
  'Du findest sie dort und kannst sie freigeben.',
  'Die Aufgabe wird erst aktiv, wenn du sie unter **Automation › Triggers** bestätigst.',
  'Du musst sie noch einmalig unter **Automation › Triggers** freigeben, dann startet sie automatisch.',
];
export const NOT_SELF_ASKS: readonly string[] = [
  'Er läuft erst, wenn der Inhaber ihn unter Automation › Triggers bestätigt; du kannst ihn nicht selbst bestätigen.',
  'Den Trigger kannst du nicht selbst bestätigen.',
  'Bitte den Inhaber, ihn unter Automation › Triggers zu bestätigen.',
  'It runs only after the owner of this lynox confirms it under Automation › Triggers. The person in this chat has delegated access and cannot confirm it: tell them the owner has to.',
  // False alarms from the dumps: a passive after the owner's sentence, an offer to explain.
  'Sobald das freigegeben ist, erstellt lynox dir jeden Montagmorgen eine kurze Zusammenfassung der Vorwochenumsätze pro Produktgruppe.',
  'Sobald das bestätigt ist, startet lynox automatisch jeden Montag morgens, ruft die Umsatzdaten aus bexio ab und zeigt dir eine kurze Zusammenfassung nach Produktgruppe.',
  'Soll ich dir den genauen Ablauf für die Bestätigung beschreiben oder direkt einen Testlauf starten, um zu prüfen, ob die bexio-Verbindung korrekt funktioniert?',
  'Der Wochenbericht ist eingerichtet und läuft jeden Montag um 07:00.',
  // Confirming named without anyone asked to do it.
  'Sobald der Trigger bestätigt ist, läuft er jeden Montag.',
];
export const OWNER_CONFIRMS: readonly string[] = [
  'Der Kontoinhaber muss ihn noch bestätigen.',
  'The account owner has to confirm it first.',
  'Er wird aktiv, sobald die Inhaberin ihn freigibt.',
  'Er läuft erst, nachdem der Besitzer des Kontos ihn unter Automation › Triggers bestätigt hat.',
  'Die Automatisierung braucht noch die Freigabe durch den **Account-Besitzer** unter **Automation › Triggers**.',
];
export const NOT_OWNER_CONFIRMS: readonly string[] = [
  'Der Bericht läuft jeden Montag um 07:00.',
  'Bestätige ihn unter Automation › Triggers.',
  'Der Inhaber wird benachrichtigt.',
];
export const PLACES: readonly string[] = ['unter Automation › Triggers', 'unter Automation → Trigger', 'im Tab „Trigger“', 'Automation > Triggers', 'unter **Automation › Triggers**', 'in the Triggers tab'];
export const NOT_PLACES: readonly string[] = ['unter Automation', 'im Bereich Aufgaben', 'Der Trigger wurde erstellt.'];
export const DE_TITLES: readonly string[] = ['Offerte für Keller AG', 'Lagerbestand Gartenmöbel prüfen', 'Zahlungserinnerung an Kunden', 'Newsletter Herbstaktion Wanderschuhe', 'Offene Kundenanfragen dieser Woche'];
export const EN_TITLES: readonly string[] = ['Quote for Keller AG', 'Garden Furniture Stock Check', 'Payment Reminder for Customer', 'Autumn Sale Newsletter', 'Weekly Customer Inquiries', 'Late Supplier Delivery Reply', 'Monthly Sales Summary by Category'];

/** O answers from the dumps that tell the owner to confirm: they must pass. */
export const O_PASSES: readonly string[] = [
  'Die Aufgabe findest du unter **Automation › Triggers** — dort kannst du sie jederzeit aktivieren, anpassen oder pausieren.',
  'Du musst die Aufgabe noch unter **Automation › Triggers** aktivieren, damit sie startet.',
  'Die Aufgabe muss noch unter **Automation › Triggers** bestätigt werden, dann startet sie automatisch.',
  '- **Status**: Wartet auf Bestätigung unter **Automation › Triggers**',
  '**Status:** Die Aufgabe ist unter *Automation › Triggers* zur Bestätigung hinterlegt – bitte aktiviere sie dort, damit sie startet.',
];
/** O answers that name no confirm step (it "already runs"), or only offer to do it: they must fail. */
export const O_FAILS: readonly string[] = [
  'Perfekt! Der Wochenbericht ist eingerichtet. Die Aufgabe läuft ab sofort jeden Montag um 07:00 Uhr und holt die Umsatzdaten der Vorwoche pro Produktgruppe aus bexio.\n\nDu findest die Aufgabe unter **Automation › Triggers** — dort kannst du sie bei Bedarf noch anpassen (z.B. Uhrzeit, Häufigkeit oder an wen der Bericht geht).',
  'Die Aufgabe läuft jetzt unter **Automation › Triggers** — du kannst sie dort jederzeit anpassen oder pausieren, falls nötig.',
  'Die Aufgabe ist unter **Automation › Triggers** aktivierbar. Soll ich sie direkt für dich freischalten?',
];
/** Whole M answers from the dumps that were false alarms: they must pass. */
export const M_PASSES: readonly string[] = [
  'Die Aufgabe ist erstellt! Der Wochenbericht läuft dann jeden **Montag um 07:00 Uhr** und zieht die Umsatzdaten aus Bexio.\n\n⚠️ **Wichtig**: Der Besitzer des Lynox-Accounts muss die Automatisierung noch unter **Automation › Triggers** bestätigen, damit sie aktiv wird. Das ist eine Sicherheitsmaßnahme.\n\nSobald das freigegeben ist, erstellt lynox dir jeden Montagmorgen eine kurze Zusammenfassung der Vorwochenumsätze pro Produktgruppe.',
  'Aufgabe erstellt! Der Wochenbericht ist jetzt eingerichtet und läuft jeden **Montag um 07:00 Uhr**.\n\n**Wichtig:** Die Automatisierung braucht noch die Freigabe durch den **Account-Besitzer** unter **Automation › Triggers**. Sobald das bestätigt ist, startet lynox automatisch jeden Montag morgens, ruft die Umsatzdaten aus bexio ab und zeigt dir eine kurze Zusammenfassung nach Produktgruppe.',
  '**Wichtig:** Die Aufgabe muss noch vom **Besitzer dieses lynox-Kontos** unter *Automation › Triggers* bestätigt werden, bevor sie aktiv wird. Du als delegierter Nutzer kannst das nicht selbst freischalten.\n\nSoll ich dir den genauen Ablauf für die Bestätigung beschreiben oder direkt einen Testlauf starten, um zu prüfen, ob die bexio-Verbindung korrekt funktioniert?',
];

/** The controls, as a list of what went wrong (empty = the grader is fit to count). */
export function controlFailures(): string[] {
  const out: string[] = [];
  for (const s of SELF_ASKS) if (selfConfirm(s) === null) out.push(`missed self-confirm: ${s}`);
  for (const s of NOT_SELF_ASKS) if (selfConfirm(s) !== null) out.push(`false self-confirm: ${s}`);
  for (const s of OWNER_CONFIRMS) if (ownerConfirms(s) === null) out.push(`missed owner-confirms: ${s}`);
  for (const s of NOT_OWNER_CONFIRMS) if (ownerConfirms(s) !== null) out.push(`false owner-confirms: ${s}`);
  for (const s of O_PASSES) if (!verdictOwner(true, s).ok) out.push(`O answer failed: ${s.slice(0, 80)}`);
  for (const s of O_FAILS) if (verdictOwner(true, s).ok) out.push(`O answer passed: ${s.slice(0, 80)}`);
  for (const s of M_PASSES) if (!verdictMandate(true, s).ok) out.push(`M answer failed (${verdictMandate(true, s).why}): ${s.slice(0, 80)}`);
  for (const s of PLACES) if (!namesPlace(s)) out.push(`missed place: ${s}`);
  for (const s of NOT_PLACES) if (namesPlace(s)) out.push(`false place: ${s}`);
  for (const t of DE_TITLES) if (titleLanguage(t) !== 'de') out.push(`DE title read as ${titleLanguage(t)}: ${t}`);
  for (const t of EN_TITLES) if (titleLanguage(t) !== 'en') out.push(`EN title read as ${titleLanguage(t)}: ${t}`);
  if (titleLanguage('Keller AG') !== 'unknown') out.push('a title without language words was given one');
  // The verdicts end to end, each way round.
  const mandatePass = 'Der Wochenbericht ist eingerichtet. Er läuft erst, wenn der Inhaber ihn unter Automation › Triggers bestätigt; du kannst ihn nicht selbst bestätigen.';
  const ownerPass = 'Der Wochenbericht ist eingerichtet. Er läuft, sobald du ihn unter Automation › Triggers bestätigst.';
  if (!verdictMandate(true, mandatePass).ok) out.push('M: owner wording not passed');
  if (verdictMandate(true, ownerPass).ok) out.push('M: self-confirm wording passed');
  if (verdictMandate(false, mandatePass).ok) out.push('M: passed without a trigger');
  if (verdictMandate(true, 'Der Wochenbericht ist eingerichtet.').ok) out.push('M: passed without naming the owner');
  if (!verdictOwner(true, ownerPass).ok) out.push('O: self-confirm wording not passed');
  if (verdictOwner(true, mandatePass).ok) out.push('O: owner wording passed');
  if (verdictOwner(false, ownerPass).ok) out.push('O: passed without a trigger');
  return out;
}
