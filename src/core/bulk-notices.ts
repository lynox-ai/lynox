/**
 * The sentences a bulk run's outcome tells its owner, in each notice language
 * ({@link noticeLanguage}). The outcome's `summary` is recorded on the trigger and pushed
 * (`WorkerLoop.recordAndNotify`), so it speaks the owner's language.
 *
 * What stays English: the halt reason a run STORES (`BULK_HALT_REASONS`). SQL compares it and
 * the model reads it (`bulk-ledger.ts`), so only the sentence that names it is translated, here,
 * and a reason this table has no German for is quoted as stored.
 *
 * The German wording is ux U-099, U-105 and Rest-P: every halt reason has a German sentence, and
 * so has every sentence a bulk outcome is pushed with, refusals and atomic runs included.
 */
import type { NoticeLanguage } from './notice-language.js';
import type { BulkTriggerEffect } from '../types/pipeline.js';
import { BULK_HALT_REASONS, externalHostOf } from './bulk-ledger.js';

export interface BulkApplyCounts {
  applied: number; foundAsPlanned: number; failed: number; conflicts: number;
  undone: number; total: number; sentUnknown: number;
}

export type BulkPhase = 'apply' | 'preview' | 'judge';

/** Which filters a Shopify list names, for its sentences: its group (`both` = type and vendor), a
 *  status alone, or a group read among one status (`group_status`). */
export type ShopifyFilterKind = 'product_type' | 'vendor' | 'both' | 'status' | 'group_status';

export interface BulkNotices {
  readonly applyDone: string;
  readonly previewDone: string;
  readonly readDone: string;
  readonly listEmpty: string;
  readonly listWaiting: string;
  /** A filtered Shopify list that matched no product, by which filters it has: the finding and
   *  the next step, never the value (ux U-123). The task tool gives the same text to a model. */
  listNoMatch(filters: ShopifyFilterKind, many?: boolean): string;
  /** A filtered list whose search listed products, every one of them spelled otherwise than the
   *  filter (`not_in_filter`, PRD shopify-preset §22.4): products exist, none as written. */
  listNoneLeft(filters: ShopifyFilterKind, many?: boolean): string;
  readonly judgeDone: string;
  applyCounts(c: BulkApplyCounts): string;
  previewCounts(read: number, invalid: number, unread: number, total: number): string;
  judgeCounts(judged: number, invalid: number, unjudged: number, total: number): string;
  /** The API calls of this pass at the profile's rate: an estimate, and it says so (ux U-096). */
  costs(calls: number, eachUsd: number): string;
  /** `reason` is the stored English text, one of `BULK_HALT_REASONS` or a cause the run named. */
  halted(phase: BulkPhase, reason: string): string;
  readonly previewStopped: string;
  readonly listStopped: string;
  readonly judgeStopped: string;
  /** No run with this id, to write or read (B1). */
  readonly noRun: string;
  /** A trigger's effect that does not fit its run (B2). */
  readonly effectMismatch: string;
  /** A run not approved, by its ledger phase; the German leaves the phase to the run page (B3). */
  notApproved(phase: string): string;
  /** A halted run that is written on only once resumed (B4). */
  readonly haltedResume: string;
  /**
   * A Shopify run halted because its connection does not yet cover `fields` (`shopifyConsentBlock`),
   * the way on included (U-281). `nothingYet`: no target of the run was written or sent to, so
   * the sentence may say that nothing was written.
   */
  consentOutdated(fields: readonly string[], nothingYet: boolean): string;
  /**
   * A Shopify product run halted because its connection did not ask for, or was not granted,
   * `write_products` (`shopifyProductWriteAccess`), the way on included; the apply step's result.
   * The run history, which a mandate reads too, keeps only its fact (`bulkHaltForReaders`); the
   * way stands on the run page. `nothingYet` as above.
   */
  productWriteNotAsked(access: 'not_asked' | 'not_granted', nothingYet: boolean): string;
  /**
   * The same halt as it is pushed: lead and cause without the way, which the run page shows, so
   * that with the counts it fits the web-push cut (`REMINDER_BODY_MAX`). It goes to the owner's
   * devices; every live grant, whoever planned the run, reads the owner in place of the pointer
   * (`recordAndNotify`). A run whose ledger row cannot be read is not split: its history keeps the
   * whole sentence and its push goes to every device.
   */
  productWriteNotAskedPush(access: 'not_asked' | 'not_granted', nothingYet: boolean): string;
  /** A run another loop took over (B9). */
  readonly otherLoop: string;
  /** A run waiting for targets another loop holds (B10, recorded only). */
  readonly otherLoopHolds: string;
  /** No judged run with this id (B11). */
  readonly noJudgedRun: string;
  /** A run with nothing to judge yet (B12). */
  readonly nothingToJudge: string;
  /** A run not ready to be judged, by phase and whether it is halted (B13). */
  notReadyToJudge(phase: string, halted: boolean): string;
  /** A run with no external targets to read (B14). */
  readonly noExternalTargets: string;
  /** A run not ready to be read, by phase and whether it is halted (B15). */
  notReadyToRead(phase: string, halted: boolean): string;
  /** How an atomic run ended, by cause and whether its rollback completed (A1–A6). */
  atomicEnded(cause: 'failed' | 'stopped' | 'time', complete: boolean): string;
  /** An instance without bulk runs (E10). */
  readonly bulkOff: string;
  /** A preview or judging pass that threw, with no halt reason to name (E12, E14). */
  readonly previewEnded: string;
  readonly judgeEnded: string;
  /** A write that threw inside lynox (W15). */
  readonly writeError: string;
}

interface CountWords {
  unclear(k: string): string;
  applied(a: string, foundAsPlanned: string | null): string;
  failed(f: string): string;
  conflicts(k: string): string;
  undone(u: string): string;
  total(t: string): string;
}

/**
 * A written run's counts, ordered so web push's cut (240 characters) takes the counts and never
 * the warning: the unclear sends first, and only when there are any; then what was written, and
 * the other counts only when they are not 0 (ux U-099).
 */
function applyCounts(c: BulkApplyCounts, w: CountWords): string {
  const parts = [
    w.applied(String(c.applied), c.foundAsPlanned > 0 ? String(c.foundAsPlanned) : null),
    ...(c.failed > 0 ? [w.failed(String(c.failed))] : []),
    ...(c.conflicts > 0 ? [w.conflicts(String(c.conflicts))] : []),
    ...(c.undone > 0 ? [w.undone(String(c.undone))] : []),
    w.total(String(c.total)),
  ];
  return `${c.sentUnknown > 0 ? `${w.unclear(String(c.sentUnknown))} ` : ''}${parts.join(', ')}`;
}

/** The Shopify fields a sentence names after "change" / "zu ändern", with their article (U-281). */
const SHOPIFY_FIELD_NAMES: Readonly<Record<'de' | 'en', Readonly<Record<string, string>>>> = Object.freeze({
  de: Object.freeze({ title: 'den Titel', descriptionHtml: 'die Beschreibung', seo_title: 'den SEO-Titel', seo_description: 'die SEO-Beschreibung', alt: 'die Alt-Texte der Bilder' }),
  en: Object.freeze({ title: 'the title', descriptionHtml: 'the description', seo_title: 'the SEO title', seo_description: 'the SEO description', alt: 'the image alt texts' }),
});

/** `fields` by name, joined with "und"/"and"; "diese Felder"/"these fields" when one has no name here. */
export function shopifyFieldsNamed(fields: readonly string[], lang: 'de' | 'en'): string {
  const names = fields.map((f) => Object.hasOwn(SHOPIFY_FIELD_NAMES[lang], f) ? SHOPIFY_FIELD_NAMES[lang][f] : undefined);
  if (names.length === 0 || names.some((n) => n === undefined)) return lang === 'de' ? 'diese Felder' : 'these fields';
  const and = lang === 'de' ? ' und ' : ' and ';
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')}${and}${names[names.length - 1]!}`;
}

const EN: BulkNotices = Object.freeze({
  applyDone: 'Bulk run done.',
  previewDone: 'Bulk preview done. The run is ready for review.',
  readDone: 'Bulk read done. The targets are to be judged next.',
  listEmpty: 'Bulk list read done. The list holds no target that could be planned.',
  listWaiting: 'Bulk list read done. Review the targets, then start reading them.',
  // `many`: at least one filter lists values (ux U-175); one value each reads as it always did.
  listNoMatch: (filters: ShopifyFilterKind, many = false) => filters === 'status'
    ? `List read: no product has ${many ? 'any of the statuses' : 'the status'} in the filter. Check the products' status in the store, then ask lynox in a chat to plan the list again.`
    : filters === 'group_status'
    ? 'List read: no product matches both the group and the status in the filter. Check them in the store, then ask lynox in a chat to plan the list again.'
    : many
    ? (filters === 'both'
      ? 'List read: no product has both a product type and a vendor in the filter. Check the values in the store, then ask lynox in a chat to plan the list again.'
      : `List read: no product has any of the ${filters === 'product_type' ? 'product types' : 'vendors'} in the filter. Check the values in the store, then ask lynox in a chat to plan the list again.`)
    : filters === 'both'
    ? 'List read: no product has both the product type and the vendor in the filter. Check both values in the store, then ask lynox in a chat to plan the list again.'
    : `List read: no product has the ${filters === 'product_type' ? 'product type' : 'vendor'} in the filter. Check the value in the store, then ask lynox in a chat to plan the list again.`,
  listNoneLeft: (filters: ShopifyFilterKind, many = false) => filters === 'status'
    ? `Preview: products found, but none with ${many ? 'any of the statuses' : 'the status'} in the filter. Ask lynox in a chat to plan the list again.`
    : filters === 'group_status'
    ? 'Preview: products found, but none with both group and status as in the filter. Ask lynox in a chat to plan again with the spellings the store shows.'
    : many
    ? (filters === 'both'
      ? 'Preview: products found, but none with both product type and vendor spelled as a value in the filter. Ask lynox in a chat to plan again with the spellings the store shows.'
      : `Preview: products found, but none with a ${filters === 'product_type' ? 'product type' : 'vendor'} spelled as one in the filter. Ask lynox in a chat to plan again with the spellings the store shows.`)
    : filters === 'both'
    ? 'Preview: products found, but none with both product type and vendor spelled as in the filter. Ask lynox in a chat to plan again with the spellings the store shows.'
    : `Preview: products found, but none with the ${filters === 'product_type' ? 'product type' : 'vendor'} spelled as in the filter. Ask lynox in a chat to plan again with the spelling the store shows.`,
  judgeDone: 'Bulk judge done. The run is ready for review.',
  applyCounts: (c: BulkApplyCounts) => applyCounts(c, {
    unclear: (k) => `${k} unclear: sent without a clear answer, not sent again.`,
    applied: (a, n) => `${a} applied${n !== null ? ` (of which ${n} already as planned)` : ''}`,
    failed: (f) => `${f} failed`, conflicts: (k) => `${k} conflicts`, undone: (u) => `${u} undone`,
    total: (t) => `of ${t} targets.`,
  }),
  previewCounts: (read: number, invalid: number, unread: number, total: number) =>
    `Read ${String(read)}, invalid ${String(invalid)}, unread ${String(unread)} of ${String(total)} targets.`,
  judgeCounts: (judged: number, invalid: number, unjudged: number, total: number) =>
    `Judged ${String(judged)}, invalid ${String(invalid)}, without a verdict ${String(unjudged)} of ${String(total)} targets.`,
  costs: (calls: number, eachUsd: number) =>
    `${String(calls)} API calls this pass, estimated $${(calls * eachUsd).toFixed(4)} ($${String(eachUsd)} each from the profile rate).`,
  // The sentence alone: the push title names the stage and that it halted (U-324).
  halted: (phase: BulkPhase, reason: string) =>
    (phase === 'judge' && reason === BULK_HALT_REASONS.unavailable ? EN_JUDGE_UNAVAILABLE : enHaltReason(reason)) ?? `${reason}.`,
  previewStopped: 'Bulk preview stopped: the run was dropped, halted or moved on.',
  listStopped: 'Bulk list read stopped: the run was dropped, halted or moved on.',
  judgeStopped: 'Bulk judge stopped: the run was halted, superseded or moved on.',
  noRun: 'No bulk run with this id.',
  effectMismatch: 'The trigger effect does not match the bulk run.',
  notApproved: (phase: string) => `Bulk run is ${phase}, not approved — nothing written.`,
  haltedResume: 'Bulk run is halted — resume it to continue.',
  consentOutdated: (fields: readonly string[], nothingYet: boolean) =>
    `${nothingYet ? 'lynox wrote nothing.' : 'lynox writes nothing more in this run; what it already wrote stays.'} This Shopify connection does not yet let lynox change ${shopifyFieldsNamed(fields, 'en')}. Reconnect Shopify (Settings → APIs), then ask lynox in the chat to plan the run again.`,
  productWriteNotAsked: (access: 'not_asked' | 'not_granted', nothingYet: boolean) =>
    `${nothingYet ? 'lynox wrote nothing.' : 'lynox writes nothing more in this run; what it already wrote stays.'} ${access === 'not_asked'
      ? 'When this Shopify connection was set up, lynox did not ask for permission to change products. Ask lynox in the chat to connect Shopify again with permission to change products, then to plan the run again.'
      : 'Shopify did not give this connection permission to change products. Allow it in the app settings in Shopify, then ask lynox in the chat to connect Shopify again and plan the run again.'}`,
  productWriteNotAskedPush: (access: 'not_asked' | 'not_granted', nothingYet: boolean) =>
    `${nothingYet ? 'lynox wrote nothing.' : 'lynox writes nothing more; what it wrote stays.'} ${access === 'not_asked'
      ? 'When connecting, lynox did not ask Shopify for permission to change products.'
      : 'Shopify does not let this connection change products.'} What to do is under Bulk runs.`,
  otherLoop: 'Bulk run stopped by another loop.',
  otherLoopHolds: 'Bulk run waiting for targets another loop holds.',
  noJudgedRun: 'No judged bulk run with this id.',
  nothingToJudge: 'The bulk run has nothing to judge yet.',
  notReadyToJudge: (phase: string, halted: boolean) => `Bulk run is ${phase}${halted ? ' and halted' : ''} — nothing judged.`,
  noExternalTargets: 'The bulk run has no external targets to read.',
  notReadyToRead: (phase: string, halted: boolean) => `Bulk run is ${phase}${halted ? ' and halted' : ''} — nothing read.`,
  atomicEnded: (cause: 'failed' | 'stopped' | 'time', complete: boolean) => cause === 'stopped'
    ? (complete ? 'Atomic bulk run stopped and rolled back.' : 'Atomic bulk run stopped; the rollback did not complete.')
    : cause === 'time'
      ? (complete ? 'Atomic bulk run out of time and rolled back.' : 'Atomic bulk run out of time; the rollback did not complete.')
      : (complete ? 'Atomic bulk run aborted and rolled back.' : 'Atomic bulk run aborted; the rollback did not complete.'),
  bulkOff: 'Bulk runs are not available on this instance — skipped.',
  previewEnded: 'Bulk preview stopped.',
  judgeEnded: 'Bulk judge stopped.',
  writeError: 'The bulk write stopped on an error inside lynox.',
});

/**
 * The English sentence for each stored reason a bulk run halts on: the counterpart of the German
 * one below, in the words of the run page where the page has the same sentence (U-324). Keyed
 * by the reason's name, so a new reason without an English sentence does not compile; looked up
 * by the stored text, built on first use for the same import cycle as the German table.
 */
const EN_HALT_REASONS: Readonly<Record<keyof typeof BULK_HALT_REASONS, string>> = Object.freeze({
  timeBudget: 'Time budget used up.',
  failureRate: 'More than 5% of the targets failed.',
  consecutiveFailures: 'Three targets in a row failed.',
  stoppedByOwner: 'Stopped manually.',
  maxTargets: 'Reached the approved maximum.',
  awaitingStart: 'Waiting for you to start reading.',
  expired: 'Approval expired.',
  unavailable: 'Target system not reachable, or an error in lynox. The run can be continued; if it halts again right away, the target system is not reachable yet.',
  credential: 'lynox finds no stored access to the target system. Reconnect it under Settings → APIs, or ask lynox in the chat to do so.',
  unauthorized: 'The target system refused the stored access. Once it is reconnected under Settings → APIs, the run can be continued.',
  blocked: 'This instance is not allowed to reach this target system.',
  contract: 'A target is outside what the run may write.',
  costCap: 'The run reached its AI spend limit.',
  spendLimit: 'The daily or monthly AI budget has been reached.',
  creditRefused: 'AI call refused: no credit, or the connection to lynox was interrupted.',
  probeRequired: 'lynox writes further targets only once the probe is confirmed.',
  mandateEnded: 'The access the run was planned through ended before it was approved. Nothing was written.',
  markupAddedByShop: 'A written product contains markup lynox did not send; it was added in the store. The product and what you can do next are under Bulk runs.',
  checksum: 'The run has changed since it was approved.',
  atomicRolledBack: 'A target could not be written; every target written before it is undone. Nothing has changed.',
  atomicRollbackIncomplete: 'A target could not be written, and undoing did not fully succeed. Check the marked targets under Bulk runs yourself.',
  atomicStoppedRolledBack: 'Stopped manually; every target written before is undone. Nothing has changed.',
  atomicStoppedRollbackIncomplete: 'Stopped manually, and undoing did not fully succeed. Check the marked targets under Bulk runs yourself.',
  atomicTimeRolledBack: 'Time budget used up; every target written before is undone. Nothing has changed.',
  atomicTimeRollbackIncomplete: 'Time budget used up, and undoing did not fully succeed. Check the marked targets under Bulk runs yourself.',
  unrecorded: 'A read could not be recorded in the instance\'s log and was therefore not sent.',
  runUnrecorded: 'The run could not be recorded in the instance\'s log; nothing read, nothing written.',
  listed: 'List read. Waiting for the targets to be reviewed and reading to be started.',
  listNotAList: 'A page of the list is not a list.',
  listUnreadable: 'A page of the list could not be read.',
  listTooLarge: 'The list is longer or larger than a bulk run can hold; nothing changed. Plan again with part of the list, if the source allows it.',
  listNoProgress: 'A full page of the list held no new target.',
  listFormWithdrawn: 'A bulk run is no longer allowed to read this list\'s address.',
  listFilterWithdrawn: 'A bulk run is no longer allowed to read the list with this filter. lynox changed nothing.',
  listOrder: 'A page of the list did not continue in ID order.',
  listReadFailed: 'The store answered a page of the list with an error.',
  shopInactive: 'The store is closed or frozen.',
  storeAccessEnded: 'lynox could not renew its access to the store. Ask lynox in the chat to connect the store again, then the run can be continued.',
  storeClientMisnamed: 'The store profile keeps the app credentials under other names. Have lynox fix the profile in the chat, then the run can be continued.',
  formCost: 'The store refused a read as too costly.',
  shopifyReadOff: 'Reading Shopify stores in a bulk run is switched off on this instance.',
  shopifyWriteOff: 'Writing to Shopify stores in a bulk run is switched off on this instance. Once it is on again, the run can be continued.',
  consentOutdated: 'This Shopify connection does not yet let lynox change these fields. Reconnect Shopify (Settings → APIs), then ask lynox in the chat to plan the run again.',
  productWriteNotAsked: 'This Shopify connection may not change products. Ask lynox in the chat how to get that permission, then have the run planned again.',
  superseded: 'Another run with judging was started in its place. This one wrote nothing.',
  discarded: 'You discarded this run. lynox wrote nothing.',
  judgeModel: 'The AI provider of this run has no model for judging, or the operator does not allow it.',
});
let enHaltByText: ReadonlyMap<string, string> | undefined;
function enHaltReason(reason: string): string | undefined {
  enHaltByText ??= new Map(Object.entries(BULK_HALT_REASONS).map(([k, v]) => [v, EN_HALT_REASONS[k as keyof typeof BULK_HALT_REASONS]]));
  return enHaltByText.get(reason);
}

/** A judging run halts as `unavailable` when its model call fails too, so its sentence names the model. */
const EN_JUDGE_UNAVAILABLE = 'AI model or target system not reachable, or an error in lynox. The run can be continued; if it halts again right away, try again later.';

/**
 * The German sentence for each stored reason a bulk run halts on. Built on first
 * use, not at load: `bulk-ledger.ts` sits in an import cycle with the modules that load this one,
 * so `BULK_HALT_REASONS` may not be initialized yet when this module is.
 */
let deHaltReasons: Readonly<Record<string, string>> | undefined;
function deHaltReason(reason: string): string | undefined {
  deHaltReasons ??= Object.freeze({
    [BULK_HALT_REASONS.timeBudget]: 'Zeitbudget aufgebraucht.',
    [BULK_HALT_REASONS.failureRate]: 'Über 5 % der Ziele fehlgeschlagen.',
    [BULK_HALT_REASONS.consecutiveFailures]: 'Drei Ziele in Folge fehlgeschlagen.',
    [BULK_HALT_REASONS.stoppedByOwner]: 'Von Hand gestoppt.',
    [BULK_HALT_REASONS.maxTargets]: 'Freigegebene Höchstzahl erreicht.',
    [BULK_HALT_REASONS.awaitingStart]: 'Wartet, bis du das Lesen startest.',
    [BULK_HALT_REASONS.expired]: 'Freigabe abgelaufen.',
    // ux U-105: the words of the run page (`bulk.halt.*`), so push and page say the same; neutral
    // as to person, since a mandate gets the same summary and only the owner resumes a run.
    [BULK_HALT_REASONS.unavailable]: 'Zielsystem nicht erreichbar oder Fehler in lynox. Der Lauf lässt sich fortsetzen; hält er gleich wieder an, ist das Zielsystem noch nicht erreichbar.',
    [BULK_HALT_REASONS.credential]: 'lynox findet keinen gespeicherten Zugang zum Zielsystem. Verbinde ihn unter Einstellungen → APIs neu oder bitte lynox im Chat darum.',
    [BULK_HALT_REASONS.unauthorized]: 'Das Zielsystem hat den gespeicherten Zugang abgelehnt. Ist er unter Einstellungen → APIs neu verbunden, lässt sich der Lauf fortsetzen.',
    [BULK_HALT_REASONS.blocked]: 'Die Instanz darf dieses Zielsystem nicht erreichen.',
    [BULK_HALT_REASONS.contract]: 'Ein Ziel liegt ausserhalb dessen, was der Lauf schreiben darf.',
    [BULK_HALT_REASONS.costCap]: 'Der Lauf hat seine KI-Kostengrenze erreicht.',
    [BULK_HALT_REASONS.spendLimit]: 'Das tägliche oder monatliche KI-Budget ist erreicht.',
    [BULK_HALT_REASONS.creditRefused]: 'KI-Aufruf abgelehnt: kein Guthaben, oder die Verbindung zu lynox war unterbrochen.',
    [BULK_HALT_REASONS.probeRequired]: 'Weitere Ziele schreibt lynox erst nach bestätigter Probe.',
    [BULK_HALT_REASONS.mandateEnded]: 'Der Zugang, über den der Lauf geplant wurde, endete vor der Freigabe. Geschrieben wurde nichts.',
    [BULK_HALT_REASONS.markupAddedByShop]: 'Ein geschriebenes Produkt enthält Markup, das lynox nicht gesendet hat; es kam im Shop dazu. Produkt und Wege stehen unter Massenläufe.',
    // ux Rest-P (HR): the rest, so every reason has its sentence.
    [BULK_HALT_REASONS.checksum]: 'Der Lauf hat sich seit der Freigabe geändert.',
    [BULK_HALT_REASONS.atomicRolledBack]: 'Ein Ziel liess sich nicht schreiben; alle zuvor geschriebenen sind zurückgenommen. Geändert ist nichts.',
    [BULK_HALT_REASONS.atomicRollbackIncomplete]: 'Ein Ziel liess sich nicht schreiben, und das Zurücknehmen gelang nicht ganz. Die markierten Ziele unter Massenläufe von Hand prüfen.',
    [BULK_HALT_REASONS.atomicStoppedRolledBack]: 'Von Hand gestoppt; alle zuvor geschriebenen Ziele sind zurückgenommen. Geändert ist nichts.',
    [BULK_HALT_REASONS.atomicStoppedRollbackIncomplete]: 'Von Hand gestoppt, und das Zurücknehmen gelang nicht ganz. Die markierten Ziele unter Massenläufe von Hand prüfen.',
    [BULK_HALT_REASONS.atomicTimeRolledBack]: 'Zeitbudget aufgebraucht; alle zuvor geschriebenen Ziele sind zurückgenommen. Geändert ist nichts.',
    [BULK_HALT_REASONS.atomicTimeRollbackIncomplete]: 'Zeitbudget aufgebraucht, und das Zurücknehmen gelang nicht ganz. Die markierten Ziele unter Massenläufe von Hand prüfen.',
    [BULK_HALT_REASONS.unrecorded]: 'Ein Lesezugriff liess sich nicht im Protokoll der Instanz festhalten und wurde deshalb nicht gesendet.',
    [BULK_HALT_REASONS.runUnrecorded]: 'Der Lauf liess sich nicht im Protokoll der Instanz festhalten; nichts gelesen, nichts geschrieben.',
    [BULK_HALT_REASONS.listed]: 'Liste gelesen. Wartet, bis die Ziele geprüft sind und das Lesen gestartet wird.',
    [BULK_HALT_REASONS.listNotAList]: 'Eine Seite der Liste ist keine Liste.',
    [BULK_HALT_REASONS.listUnreadable]: 'Eine Seite der Liste liess sich nicht lesen.',
    // The way on for every list form: the reason alone does not tell a Shopify list from another (U-186).
    [BULK_HALT_REASONS.listTooLarge]: 'Die Liste ist länger oder grösser, als ein Massenlauf fassen kann; nichts geändert. Neu planen mit einem Teil der Liste, falls die Quelle das zulässt.',
    [BULK_HALT_REASONS.listNoProgress]: 'Eine volle Seite der Liste brachte kein neues Ziel.',
    [BULK_HALT_REASONS.listFormWithdrawn]: 'Die Adresse der Liste darf ein Massenlauf nicht mehr lesen.',
    [BULK_HALT_REASONS.listFilterWithdrawn]: 'Mit diesem Filter darf ein Massenlauf die Liste nicht mehr lesen. Geändert hat lynox nichts.',
    [BULK_HALT_REASONS.listOrder]: 'Eine Seite der Liste ging nicht in der Reihenfolge der IDs weiter.',
    [BULK_HALT_REASONS.listReadFailed]: 'Der Shop hat eine Seite der Liste mit einem Fehler beantwortet.',
    [BULK_HALT_REASONS.shopInactive]: 'Der Shop ist geschlossen oder gesperrt.',
    [BULK_HALT_REASONS.storeAccessEnded]: 'lynox konnte den Zugang zum Shop nicht erneuern. Bitte lynox im Chat, den Shop neu zu verbinden, dann lässt sich der Lauf fortsetzen.',
    [BULK_HALT_REASONS.storeClientMisnamed]: 'Im Shop-Profil liegen die App-Zugangsdaten unter anderen Namen. Lass das Profil im Chat von lynox anpassen, dann lässt sich der Lauf fortsetzen.',
    [BULK_HALT_REASONS.formCost]: 'Der Shop hat eine Abfrage als zu aufwendig abgelehnt.',
    [BULK_HALT_REASONS.shopifyReadOff]: 'Lesen von Shopify-Shops per Massenlauf ist auf dieser Instanz ausgeschaltet.',
    [BULK_HALT_REASONS.shopifyWriteOff]: 'Schreiben in Shopify-Shops per Massenlauf ist auf dieser Instanz ausgeschaltet. Ist es wieder an, lässt sich der Lauf fortsetzen.',
    // U-281, without the fields (the outcome's summary names them, `consentOutdated`).
    [BULK_HALT_REASONS.consentOutdated]: 'Diese Shopify-Verbindung erlaubt lynox noch nicht, diese Felder zu ändern. Verbinde Shopify neu (Einstellungen → APIs) und lass den Lauf im Chat neu planen.',
    [BULK_HALT_REASONS.productWriteNotAsked]: 'Diese Shopify-Verbindung darf keine Produkte ändern. Frag lynox im Chat, wie du die Erlaubnis bekommst, und lass den Lauf dann neu planen.',
    [BULK_HALT_REASONS.superseded]: 'An seiner Stelle wurde ein anderer Lauf mit Beurteilung gestartet. Dieser hat nichts geschrieben.',
    // Said to the owner, on whose device a push lands (U-324).
    [BULK_HALT_REASONS.discarded]: 'Du hast diesen Lauf verworfen. lynox hat nichts geschrieben.',
    [BULK_HALT_REASONS.judgeModel]: 'Der KI-Anbieter dieses Laufs hat kein Modell zum Beurteilen, oder der Betreiber erlaubt es nicht.',
  });
  return deHaltReasons[reason];
}

/** A judging run halts as `unavailable` when its model call fails too, so its sentence names the model (ux U-105 M1). */
const DE_JUDGE_UNAVAILABLE = 'KI-Modell oder Zielsystem nicht erreichbar, oder Fehler in lynox. Der Lauf lässt sich fortsetzen; hält er gleich wieder an, später erneut versuchen.';

const DE: BulkNotices = Object.freeze({
  applyDone: 'Massenlauf fertig.',
  previewDone: 'Vorschau fertig. Der Massenlauf wartet auf deine Prüfung.',
  readDone: 'Lesen fertig. Als Nächstes werden die Ziele beurteilt.',
  listEmpty: 'Liste gelesen. Sie enthält kein Ziel, das sich planen lässt.',
  listWaiting: 'Liste gelesen. Prüf die Ziele und starte dann das Lesen.',
  listNoMatch: (filters: ShopifyFilterKind, many = false) => filters === 'status'
    ? `Liste gelesen: Kein Produkt hat ${many ? 'einen der Status' : 'den Status'} aus dem Filter. Prüf den Status der Produkte im Shop und bitte lynox im Chat, die Liste neu zu planen.`
    : filters === 'group_status'
    ? 'Liste gelesen: Kein Produkt passt zugleich zur Gruppe und zum Status aus dem Filter. Prüf beides im Shop und bitte lynox im Chat, die Liste neu zu planen.'
    : many
    ? (filters === 'both'
      ? 'Liste gelesen: Kein Produkt hat zugleich einen Produkttyp und einen Anbieter aus dem Filter. Prüf die Werte im Shop und bitte lynox im Chat, die Liste neu zu planen.'
      : `Liste gelesen: Kein Produkt hat einen der ${filters === 'product_type' ? 'Produkttypen' : 'Anbieter'} aus dem Filter. Prüf die Werte im Shop und bitte lynox im Chat, die Liste neu zu planen.`)
    : filters === 'both'
    ? 'Liste gelesen: Kein Produkt hat zugleich Produkttyp und Anbieter aus dem Filter. Prüf beide Werte im Shop und bitte lynox im Chat, die Liste neu zu planen.'
    : `Liste gelesen: Kein Produkt hat den ${filters === 'product_type' ? 'Produkttyp' : 'Anbieter'} aus dem Filter. Prüf den Wert im Shop und bitte lynox im Chat, die Liste neu zu planen.`,
  listNoneLeft: (filters: ShopifyFilterKind, many = false) => filters === 'status'
    ? `Vorschau: Produkte gefunden, aber keines hat ${many ? 'einen der Status' : 'den Status'} aus dem Filter. Bitte lynox im Chat, die Liste neu zu planen.`
    : filters === 'group_status'
    ? 'Vorschau: Produkte gefunden, aber bei keinem stimmen Gruppe und Status beide mit dem Filter überein. Bitte lynox im Chat, mit den Schreibweisen aus dem Shop neu zu planen.'
    : many
    ? (filters === 'both'
      ? 'Vorschau: Produkte gefunden, aber bei keinem sind Produkttyp und Anbieter beide wie im Filter geschrieben. Bitte lynox im Chat, mit den Schreibweisen aus dem Shop neu zu planen.'
      : `Vorschau: Produkte gefunden, aber bei keinem ist der ${filters === 'product_type' ? 'Produkttyp' : 'Anbieter'} so geschrieben wie einer im Filter. Bitte lynox im Chat, mit den Schreibweisen aus dem Shop neu zu planen.`)
    : filters === 'both'
    ? 'Vorschau: Produkte gefunden, aber bei keinem sind Produkttyp und Anbieter beide wie im Filter geschrieben. Bitte lynox im Chat, mit der Schreibweise aus dem Shop neu zu planen.'
    : `Vorschau: Produkte gefunden, aber bei keinem ist der ${filters === 'product_type' ? 'Produkttyp' : 'Anbieter'} wie im Filter geschrieben. Bitte lynox im Chat, mit der Schreibweise aus dem Shop neu zu planen.`,
  judgeDone: 'Beurteilung fertig. Der Massenlauf wartet auf deine Prüfung.',
  applyCounts: (c: BulkApplyCounts) => applyCounts(c, {
    unclear: (k) => `${k} unklar: gesendet ohne klare Antwort, nicht wiederholt.`,
    applied: (a, n) => `${a} geschrieben${n !== null ? ` (davon ${n} schon wie geplant)` : ''}`,
    failed: (f) => `${f} fehlgeschlagen`, conflicts: (k) => `${k} Konflikte`, undone: (u) => `${u} zurückgenommen`,
    total: (t) => `von ${t} Zielen.`,
  }),
  previewCounts: (read: number, invalid: number, unread: number, total: number) =>
    `Gelesen ${String(read)}, ungültig ${String(invalid)}, nicht gelesen ${String(unread)} von ${String(total)} Zielen.`,
  judgeCounts: (judged: number, invalid: number, unjudged: number, total: number) =>
    `Beurteilt ${String(judged)}, ungültig ${String(invalid)}, ohne Urteil ${String(unjudged)} von ${String(total)} Zielen.`,
  costs: (calls: number, eachUsd: number) =>
    `${String(calls)} API-Abrufe in diesem Durchgang, geschätzt $${(calls * eachUsd).toFixed(4)} (je $${String(eachUsd)} laut Profil).`,
  // The sentence alone: the push title names the stage and that it halted (U-324).
  halted: (phase: BulkPhase, reason: string) =>
    (phase === 'judge' && reason === BULK_HALT_REASONS.unavailable ? DE_JUDGE_UNAVAILABLE : deHaltReason(reason)) ?? `${reason}.`,
  previewStopped: 'Vorschau beendet: Der Lauf wurde verworfen, angehalten oder ist weitergegangen.',
  listStopped: 'Lesen der Liste beendet: Der Lauf wurde verworfen, angehalten oder ist weitergegangen.',
  judgeStopped: 'Beurteilung beendet: Der Lauf wurde angehalten, ersetzt oder ist weitergegangen.',
  noRun: 'Diesen Massenlauf gibt es nicht.',
  effectMismatch: 'Der Auslöser passt nicht zu diesem Massenlauf.',
  // The ledger's phase is an English word, and the run page shows the phase (ux Rest-P B3).
  notApproved: () => 'Massenlauf nicht freigegeben; nichts geschrieben.',
  haltedResume: 'Massenlauf angehalten; geschrieben wird erst nach dem Fortsetzen.',
  consentOutdated: (fields: readonly string[], nothingYet: boolean) =>
    `${nothingYet ? 'lynox hat nichts geschrieben.' : 'lynox schreibt in diesem Lauf nichts mehr; was schon geschrieben ist, bleibt.'} Diese Shopify-Verbindung erlaubt lynox noch nicht, ${shopifyFieldsNamed(fields, 'de')} zu ändern. Verbinde Shopify neu (Einstellungen → APIs); dann bitte lynox im Chat, den Lauf neu zu planen.`,
  productWriteNotAsked: (access: 'not_asked' | 'not_granted', nothingYet: boolean) =>
    `${nothingYet ? 'lynox hat nichts geschrieben.' : 'lynox schreibt in diesem Lauf nichts mehr; was schon geschrieben ist, bleibt.'} ${access === 'not_asked'
      ? 'Beim Einrichten dieser Shopify-Verbindung hat lynox nicht um die Erlaubnis gebeten, Produkte zu ändern. Bitte lynox im Chat, Shopify mit dieser Erlaubnis neu zu verbinden und den Lauf dann neu zu planen.'
      : 'Shopify hat dieser Verbindung nicht erlaubt, Produkte zu ändern. Erlaube es in den App-Einstellungen in Shopify und bitte lynox dann im Chat, Shopify neu zu verbinden und den Lauf neu zu planen.'}`,
  productWriteNotAskedPush: (access: 'not_asked' | 'not_granted', nothingYet: boolean) =>
    `${nothingYet ? 'lynox hat nichts geschrieben.' : 'lynox schreibt nichts mehr; Geschriebenes bleibt.'} ${access === 'not_asked'
      ? 'Beim Verbinden hat lynox Shopify nicht um das Recht gebeten, Produkte zu ändern.'
      : 'Shopify erlaubt dieser Verbindung nicht, Produkte zu ändern.'} Was zu tun ist, steht unter Massenläufe.`,
  otherLoop: 'Massenlauf beendet: Ein anderer Durchgang bearbeitet ihn.',
  otherLoopHolds: 'Massenlauf wartet auf Ziele, die ein anderer Durchgang hält.',
  noJudgedRun: 'Diesen Massenlauf mit Beurteilung gibt es nicht.',
  nothingToJudge: 'Der Massenlauf hat noch nichts zu beurteilen.',
  notReadyToJudge: (_phase: string, halted: boolean) => `Massenlauf nicht bereit zum Beurteilen${halted ? ' und angehalten' : ''}; nichts beurteilt.`,
  noExternalTargets: 'Der Massenlauf hat keine externen Ziele zum Lesen.',
  notReadyToRead: (_phase: string, halted: boolean) => `Massenlauf nicht bereit zum Lesen${halted ? ' und angehalten' : ''}; nichts gelesen.`,
  atomicEnded: (cause: 'failed' | 'stopped' | 'time', complete: boolean) => cause === 'stopped'
    ? (complete ? 'Massenlauf (ganz oder gar nicht) gestoppt und zurückgenommen.' : 'Massenlauf (ganz oder gar nicht) gestoppt; das Zurücknehmen gelang nicht ganz. Markierte Ziele unter Massenläufe prüfen.')
    : cause === 'time'
      ? (complete ? 'Massenlauf (ganz oder gar nicht): Zeit abgelaufen, alles zurückgenommen.' : 'Massenlauf (ganz oder gar nicht): Zeit abgelaufen; das Zurücknehmen gelang nicht ganz. Markierte Ziele unter Massenläufe prüfen.')
      : (complete ? 'Massenlauf (ganz oder gar nicht) abgebrochen und zurückgenommen.' : 'Massenlauf (ganz oder gar nicht) abgebrochen; das Zurücknehmen gelang nicht ganz. Markierte Ziele unter Massenläufe prüfen.'),
  bulkOff: 'Massenläufe sind auf dieser Instanz nicht verfügbar; übersprungen.',
  previewEnded: 'Vorschau beendet.',
  judgeEnded: 'Beurteilung beendet.',
  writeError: 'Das Schreiben des Massenlaufs hat wegen eines Fehlers in lynox angehalten.',
});

export const BULK_NOTICES: Readonly<Record<NoticeLanguage, BulkNotices>> = Object.freeze({ en: EN, de: DE });

/** How a run ended, as its push title says it (`RUN_END_LOOK` in the worker). */
/** `noted`: finished, with member-connection lines; the note leads, so a cut title keeps it (U-420). */
export type BulkPushEnd = 'success' | 'noted' | 'failed' | 'halted' | 'interrupted' | 'stopped' | 'discarded';

const PUSH_STAGE: Readonly<Record<NoticeLanguage, Readonly<Record<BulkTriggerEffect, string>>>> = Object.freeze({
  de: Object.freeze({ bulk_preview: 'Vorschau', bulk_judge: 'Beurteilung', bulk_apply: 'Massenlauf', bulk_undo: 'Rücknahme' }),
  en: Object.freeze({ bulk_preview: 'Preview', bulk_judge: 'Judging', bulk_apply: 'Bulk run', bulk_undo: 'Undo' }),
});
const PUSH_END: Readonly<Record<NoticeLanguage, Readonly<Record<BulkPushEnd, string>>>> = Object.freeze({
  de: Object.freeze({ success: 'fertig', noted: 'fertig, mit Hinweis', failed: 'fehlgeschlagen', halted: 'angehalten', interrupted: 'unterbrochen', stopped: 'gestoppt', discarded: 'verworfen' }),
  en: Object.freeze({ success: 'done', noted: 'done, with a note', failed: 'failed', halted: 'halted', interrupted: 'interrupted', stopped: 'stopped', discarded: 'discarded' }),
});

/** Whether a run's stored halt reason is the owner's discard: its push ends "discarded" under
 *  the stop mark, not "stopped" (U-324). */
export function isDiscardReason(reason: string | null): boolean {
  return reason === BULK_HALT_REASONS.discarded;
}

/**
 * A bulk run's push title after its end mark: the stage and how it ended, and the host it works
 * on where it has one (a store, a shop system's API), so the lock screen says which run halted
 * where; never the run's id (U-324). A run on the data store or workspace files has no host, nor
 * one whose run is gone (`targetSystem` null).
 */
export function bulkPushTitle(effect: BulkTriggerEffect, end: BulkPushEnd, targetSystem: string | null, lang: NoticeLanguage): string {
  const host = targetSystem === null ? null : externalHostOf(targetSystem);
  return `${PUSH_STAGE[lang][effect]} ${PUSH_END[lang][end]}${host === null || host === '' ? '' : ` · ${host}`}`;
}

/**
 * A halt's sentence as each reader gets it, for the halts whose way on only the owner can take
 * (reconnect, fix the profile, switch writing on, continue): the owner's push keeps the sentence
 * with its way; the run's history (`record`), which a mandate reads too, keeps only the fact; the
 * push to every live grant (`mandate`), whoever planned the run, gets the fact and that only the
 * owner can resolve it (U-383). Null for every other halt, whose sentence holds for any reader.
 */
export interface BulkHaltReaders {
  readonly record: string;
  readonly mandate: string;
}

const ONLY_OWNER_RESOLVES: Readonly<Record<NoticeLanguage, string>> = Object.freeze({
  de: 'Lösen kann das nur der Inhaber.',
  en: 'Only the owner can resolve this.',
});

/** The fact that stands for both of a product halt's ways (the connection never asked, or Shopify refused). */
const PRODUCT_WRITE_FACT: Readonly<Record<NoticeLanguage, string>> = Object.freeze({
  de: 'Diese Shopify-Verbindung darf keine Produkte ändern.',
  en: 'This Shopify connection may not change products.',
});

/** A reason sentence's first sentence: its fact, without the way on that follows. */
function firstSentence(text: string): string {
  const at = text.indexOf('. ');
  return at < 0 ? text : text.slice(0, at + 1);
}

/**
 * For one stored reason, the parts of a halt sentence that carry the owner's way, each with what a
 * reader who cannot take it reads instead. Taken from the sentences themselves, so a reworded way
 * moves with them; tried in order, the first part found in the text wins.
 */
function ownerWayParts(reason: string, lang: NoticeLanguage): readonly (readonly [string, string])[] {
  const say = BULK_NOTICES[lang];
  const R = BULK_HALT_REASONS;
  const whole = (text: string): readonly [string, string] => [text, firstSentence(text)];
  switch (reason) {
    case R.credential: case R.unauthorized: case R.shopifyWriteOff: case R.storeAccessEnded: case R.storeClientMisnamed:
      return [whole(say.halted('apply', reason))];
    case R.unavailable:
      return [whole(say.halted('judge', reason)), whole(say.halted('apply', reason))];
    case R.consentOutdated: {
      const full = say.consentOutdated([], true);
      // The way is the sentence after the fields' sentence; it holds no ". " of its own.
      return [whole(say.halted('apply', reason)), [full.slice(full.lastIndexOf('. ') + 1), '']];
    }
    case R.productWriteNotAsked: {
      const lead = (text: string): string => text.slice(firstSentence(text).length + 1);
      // The push's short form names the fact and points to the run page for the way: the
      // pointer is the way's stand-in, and holds no ". " of its own.
      const push = say.productWriteNotAskedPush('not_asked', true);
      return [whole(say.halted('apply', reason)),
        [lead(say.productWriteNotAsked('not_asked', true)), PRODUCT_WRITE_FACT[lang]],
        [lead(say.productWriteNotAsked('not_granted', true)), PRODUCT_WRITE_FACT[lang]],
        [push.slice(push.lastIndexOf('. ') + 1), '']];
    }
    default:
      return [];
  }
}

/** {@link BulkHaltReaders} for a run halted on `reason` whose summary is `text` in `lang`. */
export function bulkHaltForReaders(reason: string | null, text: string, lang: NoticeLanguage): BulkHaltReaders | null {
  if (reason === null) return null;
  for (const [from, to] of ownerWayParts(reason, lang)) {
    const at = text.indexOf(from);
    if (at < 0) continue;
    const before = text.slice(0, at);
    const after = text.slice(at + from.length);
    const closing = ONLY_OWNER_RESOLVES[lang];
    return { record: `${before}${to}${after}`, mandate: `${before}${to === '' ? ` ${closing}` : `${to} ${closing}`}${after}` };
  }
  return null;
}
