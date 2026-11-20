/**
 * The sentences of the check on where a send target comes from (`Agent._checkSendOrigin`): the
 * question to the owner, the answers to the model, the line on an approval card, a reply's own
 * question, and the run result a trigger's owner reads.
 *
 * Every sentence names where the target comes from as one fragment ({@link originFrom}), the part
 * after "aus" / "from", so the question, the card, the run result and the model texts say it the
 * same way. Where it comes from is not known, the sentence that says so replaces it. No sentence
 * offers another recipient or address; the model texts forbid trying one.
 *
 * Every value in a sentence (a target, a name, an address) is in ASCII quotes and has its own
 * quotes and line breaks replaced ({@link q}): a trigger's or a workflow's name is text anyone who
 * set it up chose, and it must not close its quotes and go on as the sentence.
 */
import type { NoticeLanguage } from './notice-language.js';
import type { PromptText } from '../types/index.js';
import { flattenPrompt, pv, singleLine } from './prompt-value.js';

/** Who set up a trigger, as far as its record says. */
export type TriggerSetUpBy =
  | { readonly kind: 'owner' }
  /** Someone the owner let in, by address or tag. */
  | { readonly kind: 'other'; readonly who: string }
  /** Not recorded. */
  | { readonly kind: 'unknown' };

/** Where a target that the owner did not name comes from, as far as the dispatcher knows. */
export type SendOrigin =
  | { readonly kind: 'helperThread'; readonly helper: string }
  /** `predatesRecord`: the trigger was set up before its creator was recorded, so its own
   *  instruction cannot count as the owner's; the owner confirming its recipients in the
   *  Triggers view does. */
  | { readonly kind: 'triggerRun'; readonly name: string; readonly setUpBy: TriggerSetUpBy; readonly predatesRecord?: boolean | undefined }
  | { readonly kind: 'workflowRun'; readonly name: string }
  | { readonly kind: 'readMail'; readonly sender: string }
  | { readonly kind: 'readPage'; readonly host: string }
  | { readonly kind: 'readContent' }
  | { readonly kind: 'childAgent' }
  /** A guest already invited to the calendar event a change goes out to, read from the event. */
  | { readonly kind: 'eventGuests' }
  | { readonly kind: 'unknown' };

/** A mail target is a recipient, a host target an address. */
/** `page`: a read whose address carries data (`web_research` read); written like `host`, with the verb "read". */
export type TargetNoun = 'mail' | 'host' | 'page';

/** The targets a sentence names: the ones that read, and whether some did not. */
export interface OriginTargets {
  readonly values: readonly string[];
  readonly unreadable: boolean;
}

/** A send refused in a run nobody watches, for that run's result (`originRunNotice`). */
export interface OriginRefusal {
  readonly targets: OriginTargets;
  readonly noun: TargetNoun;
  readonly origin: SendOrigin;
}

/** Every character that reads as a quote mark: the initial and final quote punctuation of every
 *  script, and the look-alikes Unicode files elsewhere (fullwidth, primes, CJK corner brackets,
 *  ornaments). */
const QUOTE_LIKE = /["`\p{Pi}\p{Pf}\u201A\u201E\uFF02\u2033\u2036\u301D\u301E\u301F\u300C\u300D\u300E\u300F\u2039\u203A\u275D\u275E\u275B\u275C\u2E42\uFF62\uFF63\u02BA\u02DD\u3003]/gu;

/** A value for inside ASCII quotes: one line, and no quote of its own. */
export function q(v: string): string {
  return singleLine(v).replace(QUOTE_LIKE, "'");
}

const quoted = (v: string): string => `"${q(v)}"`;

/** The element for a target that did not read as an address. Always last in a list; in German
 *  its relative clause closes with a comma, since the sentence always goes on after the list. */
const UNREADABLE: Record<NoticeLanguage, string> = {
  de: 'eine Adresse, die lynox nicht lesen konnte,',
  en: 'an address lynox could not read',
};

/** The targets as a list: each in quotes, the last joined with "und" / "and". */
export function targetList(targets: OriginTargets, lang: NoticeLanguage): string {
  const items = [...targets.values.map(quoted), ...(targets.unreadable ? [UNREADABLE[lang]] : [])];
  if (items.length <= 1) return items[0] ?? UNREADABLE[lang];
  return `${items.slice(0, -1).join(', ')} ${lang === 'de' ? 'und' : 'and'} ${items[items.length - 1]!}`;
}

/** How many targets a sentence names. */
const countOf = (targets: OriginTargets): number => targets.values.length + (targets.unreadable ? 1 : 0);

/** The fragment after "aus" / "from"; `null` for an origin that is not known. */
export function originFrom(origin: SendOrigin, lang: NoticeLanguage): PromptText | null {
  switch (origin.kind) {
    case 'helperThread':
      return lang === 'de' ? pv`einem Gespräch, das "${q(origin.helper)}" begonnen hat` : pv`a conversation "${q(origin.helper)}" started`;
    case 'triggerRun': {
      const by = origin.setUpBy;
      if (by.kind === 'owner') {
        return lang === 'de' ? pv`dem Trigger "${q(origin.name)}", den du angelegt hast` : pv`the trigger "${q(origin.name)}" you set up`;
      }
      if (by.kind === 'other') {
        return lang === 'de' ? pv`dem Trigger "${q(origin.name)}" von "${q(by.who)}"` : pv`the trigger "${q(origin.name)}" set up by "${q(by.who)}"`;
      }
      return lang === 'de' ? pv`dem Trigger "${q(origin.name)}"` : pv`the trigger "${q(origin.name)}"`;
    }
    case 'workflowRun':
      return lang === 'de' ? pv`dem Workflow "${q(origin.name)}"` : pv`the workflow "${q(origin.name)}"`;
    case 'readMail':
      return lang === 'de' ? pv`einer Mail von "${q(origin.sender)}", die lynox gelesen hat` : pv`a mail from "${q(origin.sender)}" that lynox read`;
    case 'readPage':
      return lang === 'de' ? pv`einer Seite auf "${q(origin.host)}", die lynox gelesen hat` : pv`a page on "${q(origin.host)}" that lynox read`;
    case 'readContent':
      return lang === 'de' ? pv`Inhalten, die lynox gelesen hat` : pv`content lynox read`;
    case 'childAgent':
      return lang === 'de' ? pv`einer Teilaufgabe, die lynox delegiert hat` : pv`a subtask lynox delegated`;
    case 'eventGuests':
      return lang === 'de' ? pv`der bisherigen Gästeliste des Termins` : pv`the event's current guest list`;
    case 'unknown':
      return null;
  }
}

/** The fragment as plain text, for a string that is not a prompt (a model text, a run result). */
function fromText(origin: SendOrigin, lang: NoticeLanguage): string | null {
  const from = originFrom(origin, lang);
  return from === null ? null : flattenPrompt(from);
}

/** The words a question starts with, for each tool that declares send targets. */
const TOOL_WORDS: Readonly<Record<string, readonly [de: string, en: string]>> = {
  mail_send: ['Mail senden', 'Send mail'],
  mail_reply: ['Antwort auf Mail', 'Reply to email'],
  http_request: ['API-Anfrage', 'API request'],
  web_research: ['Seite lesen', 'Read page'],
  google_drive: ['Google Drive: Datei freigeben', 'Google Drive: share file'],
  'google_calendar:create': ['Google Calendar: Termin anlegen', 'Google Calendar: create event'],
  'google_calendar:update': ['Google Calendar: Termin ändern', 'Google Calendar: change event'],
};

/** The tool names {@link toolWord} has words for; a test holds this against every tool that declares send targets. */
export const TOOLS_WITH_WORDS: ReadonlySet<string> = new Set(Object.keys(TOOL_WORDS).map((k) => k.split(':')[0]!));

/** The word a question starts with. A tool without words of its own is named as an external tool, in quotes. */
function toolWord(tool: string, input: unknown, lang: NoticeLanguage): string {
  const action = typeof input === 'object' && input !== null ? (input as { action?: unknown }).action : undefined;
  const key = tool === 'google_calendar' ? `google_calendar:${action === 'update_event' || action === 'update' ? 'update' : 'create'}` : tool;
  const pair = TOOL_WORDS[key];
  if (pair === undefined) return lang === 'de' ? `Externes Werkzeug ${quoted(tool)}` : `External tool ${quoted(tool)}`;
  return lang === 'de' ? pair[0] : pair[1];
}

/**
 * The question to the owner: the targets were not named by them, where they come from, and
 * whether to send anyway, followed by the line that a yes holds for this one send.
 */
export function originAsk(tool: string, input: unknown, noun: TargetNoun, targets: OriginTargets, origin: SendOrigin, lang: NoticeLanguage): PromptText {
  const word = toolWord(tool, input, lang);
  const from = originFrom(origin, lang);
  const list = targetList(targets, lang);
  const many = countOf(targets) > 1;
  if (noun === 'page') return originReadAsk(list, from, lang);
  if (lang === 'de') {
    const head = noun === 'mail'
      ? (many ? pv`${word}: Die Empfänger ${list} hast nicht du genannt. ` : pv`${word}: Den Empfänger ${list} hast nicht du genannt. `)
      : (many ? pv`${word}: Die Adressen ${list} hast nicht du genannt. ` : pv`${word}: Die Adresse ${list} hast nicht du genannt. `);
    const where = from === null
      ? (noun === 'mail'
        ? (many ? pv`Woher die Empfänger stammen, kann lynox nicht feststellen.` : pv`Woher der Empfänger stammt, kann lynox nicht feststellen.`)
        : (many ? pv`Woher die Adressen stammen, kann lynox nicht feststellen.` : pv`Woher die Adresse stammt, kann lynox nicht feststellen.`))
      : (many ? pv`Sie stammen aus ${from}.` : noun === 'mail' ? pv`Er stammt aus ${from}.` : pv`Sie stammt aus ${from}.`);
    return pv`${head}${where} Trotzdem senden?\n\n${originAskOnce(lang, noun)}`;
  }
  const nounEn = noun === 'mail' ? (many ? 'recipients' : 'recipient') : (many ? 'addresses' : 'address');
  const head = pv`${word}: you did not name the ${nounEn} ${list}. `;
  const where = from === null
    ? (many ? pv`lynox cannot tell where they come from.` : pv`lynox cannot tell where it comes from.`)
    : (many ? pv`They come from ${from}.` : pv`It comes from ${from}.`);
  return pv`${head}${where} Send anyway?\n\n${originAskOnce(lang, noun)}`;
}

/**
 * The question before a read (`page`): the host gets the whole address, path and query, and the
 * way out that is not a click. A host the owner writes in the chat counts as named by them for the
 * rest of the conversation (`owner-known-targets.ts`), so lynox does not ask about it again.
 */
function originReadAsk(list: string, from: PromptText | null, lang: NoticeLanguage): PromptText {
  if (lang === 'de') {
    const where = from === null
      ? pv`Die Adresse kommt nicht von dir; woher sie stammt, kann lynox nicht feststellen.`
      : pv`Die Adresse kommt aus ${from}, nicht von dir.`;
    return pv`Seite auf ${list} lesen? ${where} ${list} erhält dabei die ganze Adresse, auch den Pfad und alles nach dem „?“. ${originAskOnce(lang, 'page')}\n\nSchreib ${list} hier in den Chat, dann fragt lynox in diesem Gespräch nicht mehr nach diesem Host.`;
  }
  const where = from === null
    ? pv`The address does not come from you; lynox cannot tell where it comes from.`
    : pv`The address comes from ${from}, not from you.`;
  return pv`Read the page on ${list}? ${where} ${list} then gets the whole address, including the path and everything after the "?". ${originAskOnce(lang, 'page')}\n\nWrite ${list} here in the chat, and lynox won't ask about this host again in this conversation.`;
}

/** The question for a reply that goes only to the sender of the mail it answers. */
export function originReplyAsk(sender: string, lang: NoticeLanguage): PromptText {
  return lang === 'de'
    ? pv`Antwort auf Mail: Die Antwort geht an "${q(sender)}", den Absender der gelesenen Mail. Diese Adresse hast nicht du genannt. Trotzdem senden?\n\n${originAskOnce(lang)}`
    : pv`Reply to email: the reply goes to "${q(sender)}", the sender of the mail lynox read. You did not name this address. Send anyway?\n\n${originAskOnce(lang)}`;
}

/**
 * The question for a reply that goes only to the Reply-To address of the mail it answers, when
 * that address is not its sender (`from`, the mail's From) and the sender gets no copy: the owner
 * is told the reply does not go to the person who wrote.
 */
export function originReplyToAsk(to: string, from: string, lang: NoticeLanguage): PromptText {
  return lang === 'de'
    ? pv`Antwort auf Mail: Die Antwort geht an "${q(to)}", nicht an den Absender "${q(from)}". "${q(to)}" steht in der gelesenen Mail als Antwortadresse. Diese Adresse hast nicht du genannt. Trotzdem senden?\n\n${originAskOnce(lang)}`
    : pv`Reply to email: the reply goes to "${q(to)}", not to the sender "${q(from)}". The mail lynox read gives "${q(to)}" as its reply address. You did not name this address. Send anyway?\n\n${originAskOnce(lang)}`;
}

/** Said right after the question. */
export function originAskOnce(lang: NoticeLanguage, noun?: TargetNoun): string {
  if (noun === 'page') return lang === 'de' ? 'Ein Ja gilt nur für dieses eine Lesen.' : 'A yes applies to this one read only.';
  return lang === 'de' ? 'Ein Ja gilt nur für diesen einen Versand.' : 'A yes applies to this one send only.';
}

/**
 * A model text for a page read: the verb is "read", not "send" (U-349). Applied to the send
 * texts word for word, so the rest of each sentence stays the one the send texts carry. A pair
 * that no longer matches is caught by the test that reads every read text for "send", for the
 * branches that test produces (one and two targets, known and unknown origin, a trigger from
 * before the record, an unreadable target).
 */
const READ_WORDS: readonly (readonly [send: string, read: string])[] = [
  ['Not sent', 'Not read'],
  ['whether to send to', 'whether to read from'],
  ['Do not send this again', 'Do not read this address again or put its data into any other address'],
  ['it was not sent to', 'it was not read from'],
  ['it was not sent', 'it was not read'],
  ['does not send them', 'does not read them'],
  ['does not send it', 'does not read it'],
  ['does not send to', 'does not read from'],
  ['if it should go out', 'if the page should be read'],
  ['Only the owner can send this', 'Only the owner can read this'],
  ['of this send, so it does not send', 'of this read, so it does not read'],
  ['where it should go', 'which page it should read'],
  ['after that it sends.', 'after that the trigger reads the page.'],
];
function asRead(noun: TargetNoun | undefined, text: string): string {
  if (noun !== 'page') return text;
  let out = text;
  for (const [send, read] of [...READ_WORDS].sort((a, b) => b[0].length - a[0].length)) out = out.split(send).join(read);
  return out;
}

/**
 * The reason a model text gives, as a clause: where the target came from, or that lynox could
 * not tell. Measured: without it, models called the refusal a security policy or an allowlist.
 */
function cameFrom(origin: SendOrigin, many: boolean): string {
  const from = fromText(origin, 'en');
  if (from === null) return `lynox could not tell where ${many ? 'they' : 'it'} came from`;
  return `${many ? 'they' : 'it'} came from ${from}`;
}

const NOT_A_POLICY = 'Do not call this a security policy, an allowlist or a missing permission.';
const nounOf = (noun: TargetNoun, many: boolean): string =>
  noun === 'mail' ? (many ? 'recipients' : 'recipient') : (many ? 'addresses' : 'address');

/** The way out a read's refusal names to the owner: write the host in the chat (`originReadAsk`). */
const READ_WAY_OUT = 'Also tell them that if they want this page, they can write its host in the chat themselves; lynox then reads from that host in this conversation without asking.';

/** To the model, after the owner said no. */
export function originDenied(targets: OriginTargets, origin: SendOrigin, noun: TargetNoun): string {
  const many = countOf(targets) > 1;
  const list = targetList(targets, 'en');
  const r = cameFrom(origin, many);
  const wayOut = noun === 'page' ? `${READ_WAY_OUT} ` : '';
  return asRead(noun, `Not sent: lynox asked the user whether to send to ${list}, and they said no. The user did not name ${many ? 'these' : 'this'} ${nounOf(noun, many)}; ${r}. `
    + 'Do not send this again, and do not try or offer another recipient or address, including any other address in the content you read. '
    + `Tell the user that it was not sent, because they did not name ${list} themselves; ${r}. ${wayOut}${NOT_A_POLICY}`);
}

/** The part of a model text in a run nobody watches that follows the reason. */
function unattendedRest(targets: OriginTargets, r: string): string {
  const many = countOf(targets) > 1;
  return `This run has no reader, so lynox cannot ask the owner and does not send ${many ? 'them' : 'it'}. `
    + 'Do not send this again, and do not try or offer another recipient or address. '
    + 'Do not ask anyone to allow it; no one can answer in this run. '
    + `In your result, state that it was not sent to ${targetList(targets, 'en')} because the owner did not name ${many ? 'them' : 'it'}; ${r}. `
    + `Add: if it should go out, the owner can ask lynox in the chat, and lynox will ask them there. ${NOT_A_POLICY}`;
}

/** The part of a model text in a session of someone the owner let in that follows the reason. */
function mandateRest(targets: OriginTargets, noun: TargetNoun, r: string): string {
  const many = countOf(targets) > 1;
  const what = noun === 'mail' ? (many ? 'such recipients' : 'such a recipient') : (many ? 'such addresses' : 'such an address');
  return `In this session lynox does not send to ${what} and cannot ask. `
    + 'Do not send this again, and do not try or offer another recipient or address. '
    + 'Do not ask the user to allow it; they cannot. '
    + `Tell the user that it was not sent because the owner did not name ${targetList(targets, 'en')}; ${r}. `
    + `Only the owner can send this, from their own chat. ${NOT_A_POLICY}`;
}

/** To the model, in a run nobody watches. A trigger from before its creator was recorded says how to fix that. */
export function originRefusedUnattended(targets: OriginTargets, origin: SendOrigin, noun?: TargetNoun): string {
  return asRead(noun, refusedUnattendedText(targets, origin));
}
function refusedUnattendedText(targets: OriginTargets, origin: SendOrigin): string {
  const many = countOf(targets) > 1;
  if (origin.kind === 'triggerRun' && origin.predatesRecord === true) {
    return `Not sent: the trigger "${q(origin.name)}" dates from before an update, so lynox cannot tell that the owner set it up, and ${targetList(targets, 'en')} ${many ? 'do' : 'does'} not count as named by the owner. Do not try another recipient or address. Report that the owner can open the trigger under Triggers and choose "Confirm recipients"; after that it sends.`;
  }
  const r = cameFrom(origin, many);
  return `Not sent: the owner did not name ${targetList(targets, 'en')}; ${r}. ${unattendedRest(targets, r)}`;
}

/** To the model, in a session of someone the owner let in. */
export function originRefusedMandate(targets: OriginTargets, origin: SendOrigin, noun: TargetNoun): string {
  const r = cameFrom(origin, countOf(targets) > 1);
  return asRead(noun, `Not sent: the owner of this instance did not name ${targetList(targets, 'en')}; ${r}. ${mandateRest(targets, noun, r)}`);
}

/**
 * To the model, in any session, when a target of the call could not be read: the whole call is
 * refused, without a question. A yes to a target nobody can see would hold for anything.
 */
export function originUnreadable(noun: TargetNoun): string {
  return asRead(noun, `Not sent: lynox could not read the ${noun === 'mail' ? 'recipient' : 'address'} of this send, so it does not send and cannot ask. Do not try another recipient or address. Tell the user it was not sent and that lynox could not read where it should go.`);
}

/** The beginning of a model text when a source could not be read; the rest follows the situation. */
export function originLookupFailedHead(targets: OriginTargets): string {
  const many = countOf(targets) > 1;
  return `lynox could not check where ${targetList(targets, 'en')} ${many ? 'come' : 'comes'} from, so ${many ? 'they count' : 'it counts'} as not named by the owner.`;
}

/** To the model, in a run nobody watches, when a source could not be read. */
export function originLookupFailedUnattended(targets: OriginTargets, noun?: TargetNoun): string {
  return asRead(noun, `${originLookupFailedHead(targets)} ${unattendedRest(targets, cameFrom({ kind: 'unknown' }, countOf(targets) > 1))}`);
}

/** To the model, in a mandate's session, when a source could not be read. */
export function originLookupFailedMandate(targets: OriginTargets, noun: TargetNoun): string {
  return asRead(noun, `${originLookupFailedHead(targets)} ${mandateRest(targets, noun, cameFrom({ kind: 'unknown' }, countOf(targets) > 1))}`);
}

/** The line on an approval card for a mail a run filed. */
export function originCardMail(origin: SendOrigin, lang: NoticeLanguage): string {
  const from = fromText(origin, lang);
  if (from === null) return lang === 'de' ? 'Woher der Empfänger stammt, kann lynox nicht feststellen.' : 'lynox cannot tell where the recipient comes from.';
  return lang === 'de' ? `Empfänger stammt aus ${from}.` : `Recipient comes from ${from}.`;
}

/** Added to the network question for `bash` once the conversation has read outside content. */
export function originBashAfterForeign(lang: NoticeLanguage): string {
  return lang === 'de'
    ? 'Dieses Gespräch hat schon Inhalte von aussen gelesen (Mail, Seite oder Datei). Der Befehl könnte Daten daraus versenden.'
    : 'This conversation has already read outside content (a mail, page or file). The command could send data from it.';
}

/** The run result its owner reads when a trigger's run did not send. */
export function originRunNotice(name: string, refusal: OriginRefusal, lang: NoticeLanguage): string {
  const text = runNoticeText(name, refusal, lang);
  if (refusal.noun !== 'page') return text;
  // A page read (U-349): the trigger did not read the page, and the way through the chat asks to read it.
  const list = refusal.targets.unreadable || refusal.targets.values.length === 0 ? '' : targetList(refusal.targets, lang);
  const pairs: readonly (readonly [string, string])[] = lang === 'de'
    ? [[`hat nicht an ${list} gesendet`, `hat die Seite auf ${list} nicht gelesen`], ['hat nicht gesendet:', 'hat die Seite nicht gelesen:'],
      ['Soll es trotzdem hinaus, bitte lynox im Chat darum, dann fragt lynox dich.', 'Soll die Seite trotzdem gelesen werden, bitte lynox im Chat darum, dann fragt lynox dich.'],
      ['danach sendet er wieder.', 'danach liest er die Seite wieder.']]
    : [[`did not send to ${list}`, `did not read the page on ${list}`], ['did not send:', 'did not read the page:'],
      ['If it should go out anyway, ask lynox in the chat, and lynox will ask you.', 'If the page should be read anyway, ask lynox in the chat, and lynox will ask you.'],
      ['after that it sends again.', 'after that it reads the page again.']];
  let out = text;
  for (const [send, read] of pairs) if (send.length > 0) out = out.split(send).join(read);
  return out;
}

function runNoticeText(name: string, refusal: OriginRefusal, lang: NoticeLanguage): string {
  const { targets, noun, origin } = refusal;
  const trigger = lang === 'de' ? `Der Trigger "${q(name)}"` : `The trigger "${q(name)}"`;
  const tail = lang === 'de'
    ? 'Ein Lauf ohne dich kann nicht nachfragen. Soll es trotzdem hinaus, bitte lynox im Chat darum, dann fragt lynox dich.'
    : 'A run without you cannot ask. If it should go out anyway, ask lynox in the chat, and lynox will ask you.';
  // A target that could not be read refuses the whole call: the notice names no list.
  if (targets.unreadable || targets.values.length === 0) {
    return lang === 'de'
      ? `${trigger} hat nicht gesendet: lynox konnte ${noun === 'mail' ? 'den Empfänger' : 'die Adresse'} nicht lesen. Prüfe den Trigger mit lynox im Chat.`
      : `${trigger} did not send: lynox could not read the ${noun === 'mail' ? 'recipient' : 'address'}. Check the trigger with lynox in the chat.`;
  }
  const list = targetList(targets, lang);
  if (origin.kind === 'triggerRun' && origin.predatesRecord === true) {
    return lang === 'de'
      ? `${trigger} hat nicht an ${list} gesendet: Er stammt aus der Zeit vor einem Update, darum weiss lynox nicht, dass du ihn angelegt hast. Öffne ihn unter Trigger und wähle „Empfänger bestätigen“, danach sendet er wieder.`
      : `${trigger} did not send to ${list}: it dates from before an update, so lynox cannot tell that you set it up. Open it under Triggers and choose "Confirm recipients"; after that it sends again.`;
  }
  const many = countOf(targets) > 1;
  const from = fromText(origin, lang);
  if (lang === 'de') {
    if (from === null) {
      const which = noun === 'mail'
        ? (many ? 'diese Empfänger stammen, kann lynox nicht feststellen, darum gelten sie' : 'dieser Empfänger stammt, kann lynox nicht feststellen, darum gilt er')
        : (many ? 'diese Adressen stammen, kann lynox nicht feststellen, darum gelten sie' : 'diese Adresse stammt, kann lynox nicht feststellen, darum gilt sie');
      return `${trigger} hat nicht an ${list} gesendet: Woher ${which} als nicht von dir genannt. ${tail}`;
    }
    const which = noun === 'mail'
      ? (many ? 'Diese Empfänger hast nicht du genannt, sie stammen' : 'Diesen Empfänger hast nicht du genannt, er stammt')
      : (many ? 'Diese Adressen hast nicht du genannt, sie stammen' : 'Diese Adresse hast nicht du genannt, sie stammt');
    return `${trigger} hat nicht an ${list} gesendet: ${which} aus ${from}. ${tail}`;
  }
  const nounEn = noun === 'mail' ? (many ? 'recipients' : 'recipient') : (many ? 'addresses' : 'address');
  if (from === null) {
    return `${trigger} did not send to ${list}: lynox cannot tell where ${many ? 'these' : 'this'} ${nounEn} ${many ? 'come' : 'comes'} from, so ${many ? 'they count' : 'it counts'} as not named by you. ${tail}`;
  }
  return `${trigger} did not send to ${list}: you did not name ${many ? 'these' : 'this'} ${nounEn}; ${many ? 'they come' : 'it comes'} from ${from}. ${tail}`;
}
