/**
 * The worker's own sentences, in each language a notice can take ({@link noticeLanguage}).
 *
 * Every sentence the worker pushes in its own words lives here, keyed by language, so one rule
 * picks the language and no call site carries a fixed string. A sentence that is still English
 * at a call site is listed in `worker-notices.test.ts`; that list only shrinks.
 *
 * What a sentence quotes — a task title, an error, a run's result, an id — is put in as it came.
 * The German wording is ux U-099, U-105 and Rest-P.
 *
 * What stays English: a sentence the worker STORES as an event's reason or a plan's result and
 * compares later (the constants below, `PLAN_ENDED_RESULT` and `ACCESS_ENDED_RESULT`). It is
 * translated only when it is said ({@link WorkerNotices.eventReason}), so a row stored in English
 * before, or by an instance in the other language, is said in the owner's language too.
 */
import type { NoticeLanguage } from './notice-language.js';
import { ACCESS_ENDED_RESULT, PLAN_ENDED_RESULT } from './plan-pause.js';
import { isProvisionedInstance } from './wire-capture.js';

/** An event whose run did not complete, in English; the worker also compares a sentence to it. */
export const EVENT_RUN_FAILED_EN = 'An event\'s run did not complete. lynox does not run this event again; later events run as usual. If it should have changed something, check whether that change is missing and make it by hand or ask lynox in a chat.';
/** The stored English sentences of an event or a plan that did not run; each is compared or kept as a key. */
export const EVENT_TRIGGER_NOT_LIVE = 'Its trigger does not accept events, so these events are not run. Look at the trigger under Automation.';
export const EVENT_SHOP_MOVED = 'The event came from another shop than the one the trigger\'s connection now serves, so it was not run.';
export const EVENT_VALUES_UNREADABLE = 'The event\'s values could not be read with this instance\'s key, so it was not run, and it will not run later.';
/** Why a mandate's trigger the owner has not confirmed did not run. Stored as an event's reason, so
 *  it stays as it was; only its German names where to confirm (ux Rest-P E4). */
export const MANDATE_UNSTAMPED_RESULT = 'This schedule was set up or changed by someone you let in, and runs only after you confirm it — skipped.';
export const EVENT_MAPPING_REFUSED = 'Not run: in this workflow, a value from the event decides what a step runs with, not only what its task says. Change the workflow so event values appear only in a step\'s task text, or ask lynox in a chat to find the step. Later events run once that is changed; this one does not run again.';
export const EVENT_OUTCOME_UNKNOWN = 'An event was being run when the engine stopped. It may have run, and it is not run again by itself. Check whether it took effect before you do the same by hand.';
/** Why a webhook run of a workflow that asks its owner did not start. */
export const WEBHOOK_ASKS_RESULT = 'Not run: this workflow asks you a question while it runs, and a run started by a webhook event cannot wait for an answer. Change the workflow so it does not ask; later events then run, this one does not run again.';
/** The fixed result of a mandate's start by hand of a plan that acts for another mandate. */
export const PLAN_OF_ANOTHER_RESULT = 'Not run: this plan acts for another person with delegated access, so only the owner may start it by hand.';
/** The fixed result of a plan's run that did not start because its start could not be recorded. */
export const PLAN_RUN_UNRECORDED_RESULT = 'Not run: this plan acts for someone you let in, and its start cannot be recorded in the instance\'s log right now.';
/**
 * A run whose answered question came from a deleted contained conversation, and whose new one
 * could not be contained (ux U-089). The way on depends on who runs the instance.
 */
export const RESUMED_RUN_NOT_CONTAINED = 'This run\'s chat was marked as holding data from a connected shop and was deleted before your answer came. lynox could not mark the new chat the same way, so the run did not continue and your answer was not used. Run the task again.';
/** What a dropped event with no stored reason is told with. */
export const NO_REASON_RECORDED = 'no reason recorded';

/**
 * A webhook trigger switched off because its workflow needs first-run confirmation: the event's
 * stored reason, with the workflow's id in it. The writer and the reader below share these two
 * parts, so the reader recognises exactly what the writer stores.
 */
const FIRST_RUN_HEAD = 'Workflow "';
const FIRST_RUN_TAIL = '" needs first-run confirmation, so this trigger was switched off and refuses deliveries. Schedule it from the workflow library to confirm it, then switch the trigger on again.';
export function firstRunUnconfirmedReason(workflowId: string): string {
  return `${FIRST_RUN_HEAD}${workflowId}${FIRST_RUN_TAIL}`;
}
/** The workflow id of a stored {@link firstRunUnconfirmedReason}, or undefined for any other text. */
function firstRunUnconfirmedId(stored: string): string | undefined {
  if (stored.length <= FIRST_RUN_HEAD.length + FIRST_RUN_TAIL.length) return undefined;
  if (!stored.startsWith(FIRST_RUN_HEAD) || !stored.endsWith(FIRST_RUN_TAIL)) return undefined;
  return stored.slice(FIRST_RUN_HEAD.length, stored.length - FIRST_RUN_TAIL.length);
}
/** A workflow id is not bounded where it comes from (a task's pipeline id can come from the API or a
 *  sync), so a German sentence names at most this many of its characters (ux Rest-P W18). */
export const SAID_WORKFLOW_ID_MAX = 36;
function saidWorkflowId(id: string): string {
  return id.length > SAID_WORKFLOW_ID_MAX ? `${id.slice(0, SAID_WORKFLOW_ID_MAX)}…` : id;
}

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
  /**
   * A run that stopped at its cost ceiling (`value` like `$0.50`) or turn limit (`value` the
   * count) with work still pending: the sentence the push leads with.
   */
  budgetCut(kind: 'cost' | 'turns', value: string): string;
  /**
   * What follows it in the recorded result, which the push opens: no setting raises either limit
   * for one plan, so the way out is a smaller task. Not in the push, where it would take the
   * room of the result (web push cuts at 240; ux U-099).
   */
  readonly budgetCutWayOut: string;
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
  /** An event whose run did not complete, with the way on (ux U-105 W1). */
  readonly eventRunFailed: string;
  /**
   * A stored English reason of an event, as it is said (ux Rest-P rule 1): lynox's own sentence in
   * this language, the stored text as it is where there is none. English says it as stored.
   */
  eventReason(stored: string): string;
  /** One or more dropped events of a trigger, with the reason as {@link eventReason} says it. */
  eventsNotRun(count: number, why: string): string;
  /** An event that was running when the engine stopped (E3). */
  readonly eventOutcomeUnknown: string;
  /** A mandate's schedule the owner has not confirmed (E4). */
  readonly mandateUnstamped: string;
  /** A schedule whose workflow's authors could not be read (E5). */
  readonly planAuthorsUnreadable: string;
  /** A schedule a mandate whose access ended shaped (E6); stored as `PLAN_ENDED_RESULT`. */
  readonly planEnded: string;
  /** A mandate's start by hand of another's plan (E7). */
  readonly planOfAnother: string;
  /** A mandate's plan whose start cannot be recorded (E8). */
  readonly planRunUnrecorded: string;
  /** A trigger effect the engine does not know, quoted (E9). */
  unknownEffect(effect: string): string;
  /** A resumed run whose new chat could not be contained (W14). */
  resumedRunNotContained(provisioned: boolean): string;
  /** A watched page that changed, with the analysis (E15): the push only, the thread's seed stays English. */
  watchChanged(url: string, analysis: string): string;
}

/** The workflow statuses a notice names; any other, `unknown` included, is left out rather than quoted raw. */
const NAMED_WORKFLOW_STATUS: ReadonlySet<string> = new Set(['failed', 'rejected']);
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
    `Your scheduled workflow "${title}" didn't complete${status !== undefined && NAMED_WORKFLOW_STATUS.has(status) ? ` (status: ${status})` : ''}.`,
  budgetCut: (kind: 'cost' | 'turns', value: string) =>
    `Stopped at the ${kind === 'cost' ? `cost ceiling of ${value}` : `turn limit of ${value}`} with work still pending.`,
  budgetCutWayOut: 'Running it again can stop at the same point. Ask lynox in the chat to split the task into smaller plans.',
  errorLabel: 'Error:',
  failedStepsLabel: 'Failed steps:',
  writesLabel: 'Writes:',
  workflowRef: (runId: string | undefined, workflowId: string | undefined) => runId
    ? `(run ${runId}${workflowId ? ` · workflow ${workflowId}` : ''})`
    : (workflowId ? `(workflow ${workflowId})` : ''),
  workflowReply: (ref: string) => `Reply here and I'll help you fix it. I have this run loaded${ref ? ` ${ref}` : ''}.`,
  reminderTitle: 'Reminder',
  interrupted: 'lynox restarted while this run was in progress. It is recorded as interrupted and does not continue by itself, so that nothing it already did happens twice. Check what it already did, and start it again if needed.',
  confirmationSkipped: 'This scheduled action needs your confirmation before it runs without you. It was skipped. Confirm it under Automation › Triggers.',
  workflowCompleted: (runId: string | undefined) => `Workflow completed (run ${runId ?? 'unknown'})`,
  workflowGone: (workflowId: string | undefined) =>
    `${workflowId !== undefined ? `Workflow ${workflowId} no longer exists` : 'This plan\'s workflow no longer exists'}, so the run was skipped. Delete the plan under Automation › Triggers if you no longer need it.`,
  eventRunFailed: EVENT_RUN_FAILED_EN,
  eventReason: (stored: string) => stored,
  eventsNotRun: (count: number, why: string) => count === 1 ? `An event was not run: ${why}` : `${String(count)} events were not run: ${why}`,
  eventOutcomeUnknown: EVENT_OUTCOME_UNKNOWN,
  mandateUnstamped: MANDATE_UNSTAMPED_RESULT,
  planAuthorsUnreadable: 'Could not read who set up the workflow this schedule runs, so it did not run.',
  planEnded: PLAN_ENDED_RESULT,
  planOfAnother: PLAN_OF_ANOTHER_RESULT,
  planRunUnrecorded: PLAN_RUN_UNRECORDED_RESULT,
  unknownEffect: (effect: string) => `Unknown trigger effect '${effect}' — skipped`,
  resumedRunNotContained: (provisioned: boolean) => provisioned
    ? `${RESUMED_RUN_NOT_CONTAINED} If it stops the same way again, write to support@lynox.ai.`
    : `${RESUMED_RUN_NOT_CONTAINED} If it stops the same way again, the instance log names the cause.`,
  watchChanged: (url: string, analysis: string) => `${url} changed.\n\n${analysis}`,
});

/** A resumed run whose new chat could not be contained, in English (ux U-089). */
export function resumedRunNotContained(provisioned: boolean = isProvisionedInstance()): string {
  return EN.resumedRunNotContained(provisioned);
}

/**
 * The German sentence for each stored English reason of an event (ux Rest-P). Built on first use,
 * not at load, like `bulk-notices.ts`'s table: the constants of `plan-pause.ts` are read then.
 */
let deEventReasons: Readonly<Record<string, string>> | undefined;
function deEventReason(stored: string): string {
  deEventReasons ??= Object.freeze({
    [NO_REASON_RECORDED]: 'kein Grund festgehalten',
    [EVENT_RUN_FAILED_EN]: DE_EVENT_RUN_FAILED,
    [EVENT_TRIGGER_NOT_LIVE]: 'Sein Auslöser nimmt keine Ereignisse an, darum laufen sie nicht. Sieh dir den Auslöser unter Automation → Trigger an.',
    [EVENT_SHOP_MOVED]: 'Das Ereignis kam von einem anderen Shop als dem, mit dem der Auslöser jetzt verbunden ist; darum lief es nicht.',
    [EVENT_VALUES_UNREADABLE]: 'Die Werte des Ereignisses liessen sich mit dem Schlüssel dieser Instanz nicht lesen; es lief nicht und läuft auch später nicht.',
    [EVENT_MAPPING_REFUSED]: 'Nicht ausgeführt: Ein Wert aus dem Ereignis bestimmt in diesem Workflow, womit ein Schritt läuft; erlaubt ist er nur im Aufgabentext. Ändere den Workflow oder bitte lynox im Chat, den Schritt zu finden. Dieses Ereignis läuft nicht mehr.',
    [WEBHOOK_ASKS_RESULT]: 'Nicht ausgeführt: Dieser Workflow stellt beim Laufen eine Frage, und ein Lauf durch ein Webhook-Ereignis kann nicht auf eine Antwort warten. Ändere den Workflow, damit er nicht fragt; dann laufen spätere Ereignisse, dieses nicht mehr.',
    [ACCESS_ENDED_RESULT]: 'Mittendrin angehalten: Der Zugang einer Person, die diesen Plan eingerichtet oder geändert hat, ist beendet.',
    [MANDATE_UNSTAMPED_RESULT]: DE_MANDATE_UNSTAMPED,
    [PLAN_ENDED_RESULT]: DE_PLAN_ENDED,
  });
  const own = deEventReasons[stored];
  if (own !== undefined) return own;
  const workflowId = firstRunUnconfirmedId(stored);
  if (workflowId !== undefined) {
    return `Workflow „${saidWorkflowId(workflowId)}“ ist vor dem ersten Lauf noch nicht bestätigt; der Auslöser ist darum aus. Plane den Workflow in der Bibliothek ein und schalte den Auslöser wieder ein.`;
  }
  return stored;
}

const DE_EVENT_RUN_FAILED = 'Der Lauf zu einem Ereignis wurde nicht fertig. lynox führt dieses Ereignis nicht noch einmal aus; spätere Ereignisse laufen wie gewohnt. Sollte es etwas ändern, prüf, ob das fehlt, und erledige es von Hand oder bitte lynox im Chat darum.';
const DE_MANDATE_UNSTAMPED = 'Diesen Zeitplan hat jemand eingerichtet oder geändert, dem du Zugang gegeben hast. Er läuft erst nach deiner Bestätigung unter Automation → Trigger; übersprungen.';
const DE_PLAN_ENDED = 'Diesen Zeitplan oder seinen Workflow hat jemand eingerichtet oder geändert, dessen Zugang beendet ist; darum läuft er nicht.';
const DE_RESUMED_RUN_NOT_CONTAINED = 'Der Chat dieses Laufs wurde vor deiner Antwort gelöscht; lynox konnte den neuen nicht gleich schützen. Deine Antwort blieb ungenutzt. Starte die Aufgabe neu.';

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
  budgetCut: (kind: 'cost' | 'turns', value: string) =>
    `${kind === 'cost' ? `Gestoppt an der Kostengrenze (${value})` : `Gestoppt am Rundenlimit (${value})`}, obwohl noch Arbeit offen war.`,
  budgetCutWayOut: 'Ein Neustart kann wieder an derselben Stelle stoppen. Bitte lynox im Chat, die Aufgabe in kleinere Pläne aufzuteilen.',
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
  eventRunFailed: DE_EVENT_RUN_FAILED,
  eventReason: deEventReason,
  eventsNotRun: (count: number, why: string) => count === 1 ? `Ein Ereignis wurde nicht ausgeführt: ${why}` : `${String(count)} Ereignisse wurden nicht ausgeführt: ${why}`,
  eventOutcomeUnknown: 'Ein Ereignis lief gerade, als die Engine anhielt. Es kann gewirkt haben und läuft nicht von selbst noch einmal. Prüf, ob es gewirkt hat, bevor du dasselbe von Hand tust.',
  mandateUnstamped: DE_MANDATE_UNSTAMPED,
  planAuthorsUnreadable: 'Wer den Workflow dieses Zeitplans eingerichtet hat, liess sich nicht lesen; darum lief er nicht.',
  planEnded: DE_PLAN_ENDED,
  planOfAnother: 'Nicht ausgeführt: Dieser Plan handelt für eine andere Person mit Zugang. Von Hand starten darf ihn nur der Inhaber.',
  planRunUnrecorded: 'Nicht ausgeführt: Dieser Plan handelt für jemanden, dem du Zugang gegeben hast, und sein Start lässt sich gerade nicht im Protokoll der Instanz festhalten.',
  unknownEffect: (effect: string) => `Unbekannte Wirkung „${effect}“ im Auslöser; übersprungen.`,
  resumedRunNotContained: (provisioned: boolean) => provisioned
    ? `${DE_RESUMED_RUN_NOT_CONTAINED} Wiederholt es sich, schreib an support@lynox.ai.`
    : `${DE_RESUMED_RUN_NOT_CONTAINED} Wiederholt es sich, nennt das Instanz-Protokoll den Grund.`,
  watchChanged: (url: string, analysis: string) => `${url} hat sich geändert.\n\n${analysis}`,
});

export const WORKER_NOTICES: Readonly<Record<NoticeLanguage, WorkerNotices>> = Object.freeze({ en: EN, de: DE });
