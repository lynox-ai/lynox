/**
 * The sentences of the check on where a send target comes from (`Agent._checkSendOrigin`): the
 * question to the owner, the answers to the model, the line on an approval card and on a reply's
 * preview, and the run result a trigger's owner reads.
 *
 * Every sentence names where the target comes from as one fragment ({@link originFrom}), the part
 * after "aus" / "from", so the question, the card, the run result and the model texts say it the
 * same way. Where it comes from is not known, the sentence that says so replaces it. No sentence
 * offers another recipient or address; the model texts forbid trying one.
 */
import type { NoticeLanguage } from './notice-language.js';
import type { PromptText } from '../types/index.js';
import { flattenPrompt, pv, singleLine } from './prompt-value.js';

/** Where a target that the owner did not name comes from, as far as the dispatcher knows. */
export type SendOrigin =
  | { readonly kind: 'helperThread'; readonly helper: string }
  | { readonly kind: 'triggerRun'; readonly name: string; readonly author: string }
  | { readonly kind: 'workflowRun'; readonly name: string }
  | { readonly kind: 'readMail'; readonly sender: string }
  | { readonly kind: 'readPage'; readonly host: string }
  | { readonly kind: 'readContent' }
  | { readonly kind: 'childAgent' }
  | { readonly kind: 'unknown' };

/** A mail target is a recipient, a host target an address. */
export type TargetNoun = 'mail' | 'host';

/** A send refused in a run nobody watches, for that run's result (`originRunNotice`). */
export interface OriginRefusal {
  readonly target: string;
  readonly noun: TargetNoun;
  readonly origin: SendOrigin;
}

const q = (v: string): string => singleLine(v);

/** The fragment after "aus" / "from"; `null` for an origin that is not known. */
export function originFrom(origin: SendOrigin, lang: NoticeLanguage): PromptText | null {
  switch (origin.kind) {
    case 'helperThread':
      return lang === 'de' ? pv`einem Gespräch, das ${q(origin.helper)} begonnen hat` : pv`a conversation ${q(origin.helper)} started`;
    case 'triggerRun':
      return lang === 'de'
        ? pv`dem Trigger "${q(origin.name)}" von ${q(origin.author)}`
        : pv`the trigger "${q(origin.name)}" set up by ${q(origin.author)}`;
    case 'workflowRun':
      return lang === 'de' ? pv`dem Workflow "${q(origin.name)}"` : pv`the workflow "${q(origin.name)}"`;
    case 'readMail':
      return lang === 'de' ? pv`einer Mail von "${q(origin.sender)}", die lynox gelesen hat` : pv`a mail from "${q(origin.sender)}" that lynox read`;
    case 'readPage':
      return lang === 'de' ? pv`einer Seite auf "${q(origin.host)}", die lynox gelesen hat` : pv`a page on "${q(origin.host)}" that lynox read`;
    case 'readContent':
      return lang === 'de' ? pv`Inhalt, den lynox gelesen hat` : pv`content lynox read`;
    case 'childAgent':
      return lang === 'de' ? pv`einer Teilaufgabe, die lynox delegiert hat` : pv`a subtask lynox delegated`;
    case 'unknown':
      return null;
  }
}

/** The fragment as plain text, for a string that is not a prompt (a model text, a run result). */
function fromText(origin: SendOrigin, lang: NoticeLanguage): string | null {
  const from = originFrom(origin, lang);
  return from === null ? null : flattenPrompt(from);
}

/** The word a question starts with, for the tool that sends. */
// wording pending review: the reviewed text gives this word for a mail and an API request only.
function toolWord(tool: string, lang: NoticeLanguage): string {
  const words: Record<string, readonly [string, string]> = {
    mail_send: ['Mail senden', 'Send mail'],
    mail_reply: ['Antwort senden', 'Send reply'],
    http_request: ['API-Anfrage', 'API request'],
    google_drive: ['Datei freigeben', 'Share file'],
    google_calendar: ['Termin-Einladung', 'Calendar invite'],
  };
  const pair = words[tool] ?? [tool, tool];
  return lang === 'de' ? pair[0] : pair[1];
}

/**
 * The question to the owner: the target was not named by them, where it comes from, and whether
 * to send anyway, followed by the line that a yes holds for this one send.
 */
export function originAsk(tool: string, noun: TargetNoun, target: string, origin: SendOrigin, lang: NoticeLanguage): PromptText {
  const word = toolWord(tool, lang);
  const from = originFrom(origin, lang);
  if (lang === 'de') {
    const head = noun === 'mail' ? pv`${word}: Den Empfänger "${target}" hast nicht du genannt. ` : pv`${word}: Die Adresse "${target}" hast nicht du genannt. `;
    const where = from === null
      ? (noun === 'mail' ? pv`Woher der Empfänger stammt, kann lynox nicht feststellen.` : pv`Woher die Adresse stammt, kann lynox nicht feststellen.`)
      : (noun === 'mail' ? pv`Er stammt aus ${from}.` : pv`Sie stammt aus ${from}.`);
    return pv`${head}${where} Trotzdem senden?\n\n${originAskOnce(lang)}`;
  }
  const head = pv`${word}: you did not name the ${noun === 'mail' ? 'recipient' : 'address'} "${target}". `;
  const where = from === null ? pv`lynox cannot tell where it comes from.` : pv`It comes from ${from}.`;
  return pv`${head}${where} Send anyway?\n\n${originAskOnce(lang)}`;
}

/** Said right after the question. */
export function originAskOnce(lang: NoticeLanguage): string {
  return lang === 'de' ? 'Ein Ja gilt nur für diesen einen Versand.' : 'A yes applies to this one send only.';
}

/** To the model, after the owner said no. */
export function originDenied(target: string): string {
  return `Not sent: the user did not allow sending to "${q(target)}". Do not send this, and do not try again with another recipient or address. Tell the user it was not sent.`;
}

/** "it comes from …" for a model text, or the sentence that says it is not known. */
function comesFrom(origin: SendOrigin): string {
  const from = fromText(origin, 'en');
  return from === null ? 'lynox cannot tell where it comes from' : `it comes from ${from}`;
}

const UNATTENDED_REST = 'A run without a reader cannot ask the owner, so lynox does not send to it. Do not try another recipient or address. Report that this send needs the owner: they can start it again from the chat, where lynox can ask them.';
const mandateRest = (noun: TargetNoun): string =>
  `In this session lynox does not send to such a ${noun === 'mail' ? 'recipient' : 'address'} and cannot ask. Do not try another recipient or address. Tell the user that only the owner can send this, from their own chat.`;

/** To the model, in a run nobody watches. */
export function originRefusedUnattended(target: string, origin: SendOrigin): string {
  return `Not sent: the owner did not name "${q(target)}"; ${comesFrom(origin)}. ${UNATTENDED_REST}`;
}

/** To the model, in a session of someone the owner let in. */
export function originRefusedMandate(target: string, origin: SendOrigin, noun: TargetNoun): string {
  return `Not sent: the owner of this instance did not name "${q(target)}"; ${comesFrom(origin)}. ${mandateRest(noun)}`;
}

/** The beginning of a model text when a source could not be read; the rest follows the situation. */
export function originLookupFailedHead(target: string): string {
  return `lynox could not check where "${q(target)}" comes from, so it counts as not named by the owner.`;
}

/** To the model, in a run nobody watches, when a source could not be read. */
export function originLookupFailedUnattended(target: string): string {
  return `${originLookupFailedHead(target)} ${UNATTENDED_REST}`;
}

/** To the model, in a mandate's session, when a source could not be read. */
export function originLookupFailedMandate(target: string, noun: TargetNoun): string {
  return `${originLookupFailedHead(target)} ${mandateRest(noun)}`;
}

/** The line on an approval card for a mail a run filed. */
export function originCardMail(origin: SendOrigin, lang: NoticeLanguage): string {
  const from = fromText(origin, lang);
  if (from === null) return lang === 'de' ? 'Woher der Empfänger stammt, kann lynox nicht feststellen.' : 'lynox cannot tell where the recipient comes from.';
  return lang === 'de' ? `Empfänger stammt aus ${from}.` : `Recipient comes from ${from}.`;
}

/** The line in a reply's confirmation when it goes to the sender of the mail it answers. */
export function originReplyPreview(sender: string, lang: NoticeLanguage): PromptText {
  return lang === 'de'
    ? pv`Geht an den Absender der gelesenen Mail (${q(sender)}).`
    : pv`Goes to the sender of the mail lynox read (${q(sender)}).`;
}

/** Added to the network question for `bash` once the conversation has read outside content. */
export function originBashAfterForeign(lang: NoticeLanguage): string {
  return lang === 'de'
    ? 'Dieses Gespräch hat schon Inhalte von aussen gelesen (Mail, Seite oder Datei). Der Befehl könnte Daten daraus versenden.'
    : 'This conversation has already read outside content (a mail, page or file). The command could send data from it.';
}

/** The run result its owner reads when a trigger's run did not send. */
export function originRunNotice(trigger: string, target: string, noun: TargetNoun, origin: SendOrigin, lang: NoticeLanguage): string {
  const from = fromText(origin, lang);
  if (lang === 'de') {
    const which = noun === 'mail' ? 'Diesen Empfänger hast nicht du genannt, er' : 'Diese Adresse hast nicht du genannt, sie';
    // wording pending review: the reviewed wording has no form of this sentence for an unknown origin.
    const where = from === null ? `${which} stammt von einer Stelle, die lynox nicht feststellen kann` : `${which} stammt aus ${from}`;
    return `${trigger} hat nicht an "${q(target)}" gesendet: ${where}. Ein Lauf ohne dich kann nicht nachfragen. Soll es trotzdem hinaus, bitte lynox im Chat darum, dann fragt lynox dich.`;
  }
  // wording pending review: for an unknown origin, as the other model texts say it.
  const where = from === null ? 'lynox cannot tell where it comes from' : `it comes from ${from}`;
  return `${trigger} did not send to "${q(target)}": you did not name this ${noun === 'mail' ? 'recipient' : 'address'}; ${where}. A run without you cannot ask. If it should go out anyway, ask lynox in the chat, and lynox will ask you.`;
}
