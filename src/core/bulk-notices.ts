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
import { BULK_HALT_REASONS } from './bulk-ledger.js';

export interface BulkApplyCounts {
  applied: number; foundAsPlanned: number; failed: number; conflicts: number;
  undone: number; total: number; sentUnknown: number;
}

export type BulkPhase = 'apply' | 'preview' | 'judge';

export interface BulkNotices {
  readonly applyDone: string;
  readonly previewDone: string;
  readonly readDone: string;
  readonly listEmpty: string;
  readonly listWaiting: string;
  /** A filtered Shopify list that matched no product, by which filters it has: the finding and
   *  the next step, never the value (ux U-123). The task tool gives the same text to a model. */
  listNoMatch(filters: 'product_type' | 'vendor' | 'both', many?: boolean): string;
  /** A filtered list whose search listed products, every one of them spelled otherwise than the
   *  filter (`not_in_filter`, PRD shopify-preset §22.4): products exist, none as written. */
  listNoneLeft(filters: 'product_type' | 'vendor' | 'both', many?: boolean): string;
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

const EN: BulkNotices = Object.freeze({
  applyDone: 'Bulk run done.',
  previewDone: 'Bulk preview done. The run is ready for review.',
  readDone: 'Bulk read done. The targets are to be judged next.',
  listEmpty: 'Bulk list read done. The list holds no target that could be planned.',
  listWaiting: 'Bulk list read done. Review the targets, then start reading them.',
  // `many`: at least one filter lists values (ux U-175); one value each reads as it always did.
  listNoMatch: (filters: 'product_type' | 'vendor' | 'both', many = false) => many
    ? (filters === 'both'
      ? 'List read: no product has both a product type and a vendor in the filter. Check the values in the store, then ask lynox in a chat to plan the list again.'
      : `List read: no product has any of the ${filters === 'product_type' ? 'product types' : 'vendors'} in the filter. Check the values in the store, then ask lynox in a chat to plan the list again.`)
    : filters === 'both'
    ? 'List read: no product has both the product type and the vendor in the filter. Check both values in the store, then ask lynox in a chat to plan the list again.'
    : `List read: no product has the ${filters === 'product_type' ? 'product type' : 'vendor'} in the filter. Check the value in the store, then ask lynox in a chat to plan the list again.`,
  listNoneLeft: (filters: 'product_type' | 'vendor' | 'both', many = false) => many
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
  halted: (phase: BulkPhase, reason: string) =>
    `${phase === 'apply' ? 'Bulk run' : phase === 'preview' ? 'Bulk preview' : 'Bulk judge'} halted: ${reason}.`,
  previewStopped: 'Bulk preview stopped: the run was dropped, halted or moved on.',
  listStopped: 'Bulk list read stopped: the run was dropped, halted or moved on.',
  judgeStopped: 'Bulk judge stopped: the run was halted, superseded or moved on.',
  noRun: 'No bulk run with this id.',
  effectMismatch: 'The trigger effect does not match the bulk run.',
  notApproved: (phase: string) => `Bulk run is ${phase}, not approved — nothing written.`,
  haltedResume: 'Bulk run is halted — resume it to continue.',
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
    [BULK_HALT_REASONS.listTooLarge]: 'Die Liste ist länger oder grösser, als ein Massenlauf fassen kann.',
    [BULK_HALT_REASONS.listNoProgress]: 'Eine volle Seite der Liste brachte kein neues Ziel.',
    [BULK_HALT_REASONS.listFormWithdrawn]: 'Die Adresse der Liste darf ein Massenlauf nicht mehr lesen.',
    [BULK_HALT_REASONS.listFilterWithdrawn]: 'Mit diesem Filter darf ein Massenlauf die Liste nicht mehr lesen. Geändert hat lynox nichts.',
    [BULK_HALT_REASONS.listOrder]: 'Eine Seite der Liste ging nicht in der Reihenfolge der IDs weiter.',
    [BULK_HALT_REASONS.listReadFailed]: 'Der Shop hat eine Seite der Liste mit einem Fehler beantwortet.',
    [BULK_HALT_REASONS.shopInactive]: 'Der Shop ist geschlossen oder gesperrt.',
    [BULK_HALT_REASONS.formCost]: 'Der Shop hat eine Abfrage als zu aufwendig abgelehnt.',
    [BULK_HALT_REASONS.shopifyReadOff]: 'Lesen von Shopify-Shops per Massenlauf ist auf dieser Instanz ausgeschaltet.',
    [BULK_HALT_REASONS.shopifyWriteOff]: 'Schreiben in Shopify-Shops per Massenlauf ist auf dieser Instanz ausgeschaltet. Ist es wieder an, lässt sich der Lauf fortsetzen.',
    [BULK_HALT_REASONS.superseded]: 'An seiner Stelle wurde ein anderer Lauf mit Beurteilung gestartet. Dieser hat nichts geschrieben.',
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
  listNoMatch: (filters: 'product_type' | 'vendor' | 'both', many = false) => many
    ? (filters === 'both'
      ? 'Liste gelesen: Kein Produkt hat zugleich einen Produkttyp und einen Anbieter aus dem Filter. Prüf die Werte im Shop und bitte lynox im Chat, die Liste neu zu planen.'
      : `Liste gelesen: Kein Produkt hat einen der ${filters === 'product_type' ? 'Produkttypen' : 'Anbieter'} aus dem Filter. Prüf die Werte im Shop und bitte lynox im Chat, die Liste neu zu planen.`)
    : filters === 'both'
    ? 'Liste gelesen: Kein Produkt hat zugleich Produkttyp und Anbieter aus dem Filter. Prüf beide Werte im Shop und bitte lynox im Chat, die Liste neu zu planen.'
    : `Liste gelesen: Kein Produkt hat den ${filters === 'product_type' ? 'Produkttyp' : 'Anbieter'} aus dem Filter. Prüf den Wert im Shop und bitte lynox im Chat, die Liste neu zu planen.`,
  listNoneLeft: (filters: 'product_type' | 'vendor' | 'both', many = false) => many
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
  halted: (phase: BulkPhase, reason: string) =>
    `${phase === 'apply' ? 'Massenlauf' : phase === 'preview' ? 'Vorschau' : 'Beurteilung'} angehalten: ${
      (phase === 'judge' && reason === BULK_HALT_REASONS.unavailable ? DE_JUDGE_UNAVAILABLE : deHaltReason(reason)) ?? `${reason}.`}`,
  previewStopped: 'Vorschau beendet: Der Lauf wurde verworfen, angehalten oder ist weitergegangen.',
  listStopped: 'Lesen der Liste beendet: Der Lauf wurde verworfen, angehalten oder ist weitergegangen.',
  judgeStopped: 'Beurteilung beendet: Der Lauf wurde angehalten, ersetzt oder ist weitergegangen.',
  noRun: 'Diesen Massenlauf gibt es nicht.',
  effectMismatch: 'Der Auslöser passt nicht zu diesem Massenlauf.',
  // The ledger's phase is an English word, and the run page shows the phase (ux Rest-P B3).
  notApproved: () => 'Massenlauf nicht freigegeben; nichts geschrieben.',
  haltedResume: 'Massenlauf angehalten; geschrieben wird erst nach dem Fortsetzen.',
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
