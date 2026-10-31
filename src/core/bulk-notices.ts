/**
 * The sentences a bulk run's outcome tells its owner, in each notice language
 * ({@link noticeLanguage}). The outcome's `summary` is recorded on the trigger and pushed
 * (`WorkerLoop.recordAndNotify`), so it speaks the owner's language.
 *
 * What stays English: the halt reason a run STORES (`BULK_HALT_REASONS`). SQL compares it and
 * the model reads it (`bulk-ledger.ts`), so only the sentence that names it is translated, here,
 * and a reason this table has no German for is quoted as stored.
 *
 * The German wording is ux U-099; the paths a bulk run takes in ordinary use are translated,
 * the rare ones (atomic runs, refusals, a host that cannot be reached) are still English and
 * listed in `worker-notices.test.ts`.
 */
import type { NoticeLanguage } from './notice-language.js';
import { BULK_HALT_REASONS, bulkFoundAsPlannedNote } from './bulk-ledger.js';

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
}

const EN: BulkNotices = Object.freeze({
  applyDone: 'Bulk run done.',
  previewDone: 'Bulk preview done. The run is ready for review.',
  readDone: 'Bulk read done. The targets are to be judged next.',
  listEmpty: 'Bulk list read done. The list holds no target that could be planned.',
  listWaiting: 'Bulk list read done. Waiting for the owner to review the targets and start reading them.',
  judgeDone: 'Bulk judge done. The run is ready for review.',
  applyCounts: (c: BulkApplyCounts) =>
    `Applied ${String(c.applied)}${bulkFoundAsPlannedNote(c.foundAsPlanned)}, failed ${String(c.failed)}, conflicts ${String(c.conflicts)}, ` +
    `undone ${String(c.undone)} of ${String(c.total)} targets.` +
    (c.sentUnknown > 0 ? ` Unclear ${String(c.sentUnknown)}: sent without a clear answer, not sent again.` : ''),
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
});

/**
 * The German sentence for each stored reason a bulk run halts on in ordinary use. Built on first
 * use, not at load: `bulk-ledger.ts` sits in an import cycle with the modules that load this one,
 * so `BULK_HALT_REASONS` may not be initialized yet when this module is.
 */
let deHaltReasons: Readonly<Record<string, string>> | undefined;
function deHaltReason(reason: string): string | undefined {
  deHaltReasons ??= Object.freeze({
    [BULK_HALT_REASONS.timeBudget]: 'Der Lauf hat seine Zeit aufgebraucht.',
    [BULK_HALT_REASONS.failureRate]: 'Mehr als 5 % der Ziele sind fehlgeschlagen.',
    [BULK_HALT_REASONS.consecutiveFailures]: 'Drei Ziele hintereinander sind fehlgeschlagen.',
    [BULK_HALT_REASONS.stoppedByOwner]: 'Der Lauf wurde von Hand gestoppt.',
    [BULK_HALT_REASONS.maxTargets]: 'Die freigegebene Höchstzahl an Zielen ist erreicht.',
    [BULK_HALT_REASONS.awaitingStart]: 'Er wartet darauf, dass du das Lesen der Ziele startest.',
    [BULK_HALT_REASONS.expired]: 'Die Freigabe ist abgelaufen.',
  });
  return deHaltReasons[reason];
}

const DE: BulkNotices = Object.freeze({
  applyDone: 'Massenlauf fertig.',
  previewDone: 'Vorschau fertig. Der Massenlauf wartet auf deine Prüfung.',
  readDone: 'Lesen fertig. Als Nächstes werden die Ziele beurteilt.',
  listEmpty: 'Liste gelesen. Sie enthält kein Ziel, das sich planen lässt.',
  listWaiting: 'Liste gelesen. Prüf die Ziele und starte dann das Lesen.',
  judgeDone: 'Beurteilung fertig. Der Massenlauf wartet auf deine Prüfung.',
  applyCounts: (c: BulkApplyCounts) =>
    `Geschrieben ${String(c.applied)}${c.foundAsPlanned > 0 ? ` (${String(c.foundAsPlanned)} hatten schon den geplanten Wert, an sie wurde nichts gesendet)` : ''}, ` +
    `fehlgeschlagen ${String(c.failed)}, Konflikte ${String(c.conflicts)}, zurückgenommen ${String(c.undone)} von ${String(c.total)} Zielen.` +
    (c.sentUnknown > 0 ? ` Unklar ${String(c.sentUnknown)}: gesendet, aber ohne klare Antwort, deshalb nicht noch einmal gesendet.` : ''),
  previewCounts: (read: number, invalid: number, unread: number, total: number) =>
    `Gelesen ${String(read)}, ungültig ${String(invalid)}, nicht gelesen ${String(unread)} von ${String(total)} Zielen.`,
  judgeCounts: (judged: number, invalid: number, unjudged: number, total: number) =>
    `Beurteilt ${String(judged)}, ungültig ${String(invalid)}, ohne Urteil ${String(unjudged)} von ${String(total)} Zielen.`,
  costs: (calls: number, eachUsd: number) =>
    `${String(calls)} API-Abrufe in diesem Durchgang, geschätzt $${(calls * eachUsd).toFixed(4)} (je $${String(eachUsd)} laut Profil).`,
  halted: (phase: BulkPhase, reason: string) =>
    `${phase === 'apply' ? 'Massenlauf' : phase === 'preview' ? 'Vorschau' : 'Beurteilung'} angehalten: ${deHaltReason(reason) ?? `${reason}.`}`,
  previewStopped: 'Vorschau beendet: Der Lauf wurde verworfen, angehalten oder ist weitergegangen.',
  listStopped: 'Lesen der Liste beendet: Der Lauf wurde verworfen, angehalten oder ist weitergegangen.',
  judgeStopped: 'Beurteilung beendet: Der Lauf wurde angehalten, ersetzt oder ist weitergegangen.',
});

export const BULK_NOTICES: Readonly<Record<NoticeLanguage, BulkNotices>> = Object.freeze({ en: EN, de: DE });
