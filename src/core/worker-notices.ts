/**
 * The worker's own sentences, in each language a notice can take ({@link noticeLanguage}).
 *
 * Every sentence the worker pushes in its own words lives here, keyed by language, so one rule
 * picks the language and no call site carries a fixed string. A sentence that is still English
 * at a call site is listed in `worker-notices.test.ts`; that list only shrinks.
 *
 * What a sentence quotes — a task title, an error, a run's result, an id — is put in as it came.
 * The German wording is ux U-099.
 */
import type { NoticeLanguage } from './notice-language.js';

export interface WorkerNotices {
  /** The summary of more than a few triggers waiting for confirmation. */
  consentManyTitle(count: number): string;
  readonly consentManyBody: string;
  readonly consentOneTitle: string;
  /** `title` is already cleaned by `reminderTitle`. */
  consentOneBody(title: string, setUpAfterOutsideContent: boolean): string;
  /** A run that failed or was stopped, with the error as it came. */
  failed(message: string): string;
  stoppedWith(message: string): string;
  /** The first line of a run the owner ended; the run's own text follows after a blank line. */
  readonly stopped: string;
  /**
   * The labels of a notice's follow-ups. No channel shows a notice's follow-ups today (web push
   * and the escalation mail drop them), so their tasks stay English model text; once a channel
   * shows them, a task the user sees as their own message is localized too and gets an eval
   * (ux U-099).
   */
  readonly chipRunAgain: string;
  readonly chipRetry: string;
  readonly chipExplain: string;
  readonly chipDetails: string;
  /** What a contained run's push says instead of its result or question (ux U-088). */
  readonly containedResult: string;
  readonly containedQuestion: string;
  /** The question a mail lists under the body, which already gives the reason. */
  readonly containedQuestionInquiry: string;
  /** The first sentence of a scheduled workflow that did not complete. */
  workflowIncomplete(title: string, status: string | undefined): string;
  readonly errorLabel: string;
  readonly failedStepsLabel: string;
  readonly writesLabel: string;
  /** The ids the agent needs to diagnose the run when the owner replies. */
  workflowRef(runId: string | undefined, workflowId: string | undefined): string;
  workflowReply(ref: string): string;
  /** The title of a standalone reminder. */
  readonly reminderTitle: string;
  /** A run the engine's restart cut off; recorded and pushed (ux U-099 A). */
  readonly interrupted: string;
  /** An unconfirmed agent trigger that reached dispatch anyway (U-099 B). */
  readonly confirmationSkipped: string;
  /** A scheduled workflow that completed; the write notes follow as they came (U-099 C). */
  workflowCompleted(runId: string | undefined): string;
  /** A schedule whose workflow is gone, with or without its id (U-099 D). */
  workflowGone(workflowId: string | undefined): string;
}

/** The workflow statuses a German sentence names; any other is left out rather than quoted raw. */
const DE_WORKFLOW_STATUS: Readonly<Record<string, string>> = Object.freeze({
  failed: 'fehlgeschlagen',
  rejected: 'abgelehnt',
});

const EN: WorkerNotices = Object.freeze({
  consentManyTitle: (count: number) => `⏸ ${String(count)} scheduled actions are waiting for your confirmation`,
  consentManyBody: 'They came due and have not run. Review each one under Automation › Triggers before you confirm it.',
  consentOneTitle: '⏸ A scheduled action is waiting for your confirmation',
  consentOneBody: (title: string, outside: boolean) =>
    `It came due and has not run.${outside ? ' It was set up after reading content from outside.' : ''} Review “${title}” under Automation › Triggers before you confirm it.`,
  failed: (message: string) => `Task failed: ${message}`,
  stoppedWith: (message: string) => `Stopped on your instruction: ${message}`,
  stopped: 'Stopped on your instruction.',
  chipRunAgain: 'Run again',
  chipRetry: 'Retry',
  chipExplain: 'Explain',
  chipDetails: 'Details',
  containedResult: 'This run may have read data from your connected shop, so this notification leaves out its result. Open the chat to read it.',
  containedQuestion: 'A question is waiting in the chat. This run may have read data from your connected shop, so this notification leaves out the question and its options. Open the chat to answer it.',
  containedQuestionInquiry: 'A question is waiting in the chat.',
  workflowIncomplete: (title: string, status: string | undefined) =>
    `Your scheduled workflow "${title}" didn't complete (status: ${status ?? 'unknown'}).`,
  errorLabel: 'Error:',
  failedStepsLabel: 'Failed steps:',
  writesLabel: 'Writes:',
  workflowRef: (runId: string | undefined, workflowId: string | undefined) => runId
    ? `(run ${runId}${workflowId ? ` · workflow ${workflowId}` : ''})`
    : (workflowId ? `(workflow ${workflowId})` : ''),
  workflowReply: (ref: string) => `Reply here and I'll help you fix it — I have this run loaded${ref ? ` ${ref}` : ''}.`,
  reminderTitle: 'Reminder',
  interrupted: 'lynox restarted while this run was in progress. It is recorded as interrupted and does not continue by itself, so that nothing it already did happens twice. Check what it already did, and start it again if needed.',
  confirmationSkipped: 'This scheduled action needs your confirmation before it runs without you. It was skipped. Confirm it under Automation › Triggers.',
  workflowCompleted: (runId: string | undefined) => `Workflow completed (run ${runId ?? 'unknown'})`,
  workflowGone: (workflowId: string | undefined) =>
    `${workflowId !== undefined ? `Workflow ${workflowId} no longer exists` : 'This plan\'s workflow no longer exists'}, so the run was skipped. Delete the plan under Automation › Triggers if you no longer need it.`,
});

const DE: WorkerNotices = Object.freeze({
  consentManyTitle: (count: number) => `⏸ ${String(count)} geplante Aktionen warten auf deine Bestätigung`,
  consentManyBody: 'Sie waren fällig und sind nicht gelaufen. Prüf jede unter Automation → Trigger, bevor du sie bestätigst.',
  consentOneTitle: '⏸ Eine geplante Aktion wartet auf deine Bestätigung',
  consentOneBody: (title: string, outside: boolean) =>
    `Fällig, aber nicht gelaufen.${outside ? ' Eingerichtet, nachdem ein Lauf Inhalte von aussen gelesen hatte.' : ''} Prüf „${title}“ unter Automation → Trigger, bevor du bestätigst.`,
  failed: (message: string) => `Aufgabe fehlgeschlagen: ${message}`,
  stoppedWith: (message: string) => `Auf deine Anweisung gestoppt: ${message}`,
  stopped: 'Auf deine Anweisung gestoppt.',
  chipRunAgain: 'Erneut ausführen',
  chipRetry: 'Erneut versuchen',
  chipExplain: 'Erklären',
  chipDetails: 'Details',
  containedResult: 'Dieser Lauf hat möglicherweise Daten aus deinem verbundenen Shop gelesen, deshalb lässt diese Benachrichtigung sein Ergebnis weg. Öffne den Chat, um es zu lesen.',
  containedQuestion: 'Im Chat wartet eine Frage. Dieser Lauf hat möglicherweise Daten aus deinem verbundenen Shop gelesen, deshalb lässt diese Benachrichtigung die Frage und ihre Antwortmöglichkeiten weg. Öffne den Chat, um sie zu beantworten.',
  containedQuestionInquiry: 'Im Chat wartet eine Frage.',
  workflowIncomplete: (title: string, status: string | undefined) => {
    const named = status !== undefined ? DE_WORKFLOW_STATUS[status] : undefined;
    return `Dein geplanter Workflow „${title}“ ist nicht fertig geworden${named !== undefined ? ` (Status: ${named})` : ''}.`;
  },
  errorLabel: 'Fehler:',
  failedStepsLabel: 'Fehlgeschlagene Schritte:',
  writesLabel: 'Schreibvorgänge:',
  workflowRef: (runId: string | undefined, workflowId: string | undefined) => runId
    ? `(Lauf ${runId}${workflowId ? ` · Workflow ${workflowId}` : ''})`
    : (workflowId ? `(Workflow ${workflowId})` : ''),
  workflowReply: (ref: string) => `Antworte hier, dann helfe ich dir, ihn zu reparieren. Ich habe diesen Lauf geladen${ref ? ` ${ref}` : ''}.`,
  reminderTitle: 'Erinnerung',
  interrupted: 'lynox wurde während dieses Laufs neu gestartet. Er gilt als unterbrochen und läuft nicht von selbst weiter, damit Erledigtes nicht doppelt geschieht. Prüf, was schon erledigt ist, und starte ihn bei Bedarf neu.',
  confirmationSkipped: 'Diese geplante Aktion braucht deine Bestätigung, bevor sie ohne dich läuft. Sie wurde übersprungen. Bestätige sie unter Automation → Trigger.',
  workflowCompleted: (runId: string | undefined) => `Workflow abgeschlossen (Lauf ${runId ?? 'unbekannt'})`,
  workflowGone: (workflowId: string | undefined) =>
    `${workflowId !== undefined ? `Workflow ${workflowId} existiert` : 'Der Workflow dieses Plans existiert'} nicht mehr, deshalb wurde der Lauf übersprungen. Lösch den Plan unter Automation → Trigger, wenn du ihn nicht mehr brauchst.`,
});

export const WORKER_NOTICES: Readonly<Record<NoticeLanguage, WorkerNotices>> = Object.freeze({ en: EN, de: DE });
