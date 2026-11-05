import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { noticeLanguage } from './notice-language.js';
import {
  EVENT_MAPPING_REFUSED, EVENT_OUTCOME_UNKNOWN, EVENT_RUN_FAILED_EN, EVENT_SHOP_MOVED, EVENT_TRIGGER_NOT_LIVE, EVENT_VALUES_UNREADABLE,
  MANDATE_UNSTAMPED_RESULT, NO_REASON_RECORDED, SAID_WORKFLOW_ID_MAX, WEBHOOK_ASKS_RESULT, WORKER_NOTICES, firstRunUnconfirmedReason,
  type WorkerNotices,
} from './worker-notices.js';
import { BULK_NOTICES, type BulkNotices } from './bulk-notices.js';
import { BULK_HALT_REASONS } from './bulk-ledger.js';
import { ACCESS_ENDED_RESULT, PLAN_ENDED_RESULT } from './plan-pause.js';
import { EVENT_STOPPED, OWN_FAILURE_REASONS, REMINDER_BODY_MAX } from './worker-loop.js';

afterEach(() => { vi.unstubAllEnvs(); });

describe('the notice language (noticeLanguage)', () => {
  it('takes a configured German or English, regional tags included, wherever the instance runs', () => {
    for (const provisioned of [true, false]) {
      expect(['de', 'DE', ' de-CH ', 'de-DE'].map((l) => noticeLanguage(l, provisioned))).toEqual(['de', 'de', 'de', 'de']);
      expect(['en', 'EN', ' en-US ', 'en-GB'].map((l) => noticeLanguage(l, provisioned))).toEqual(['en', 'en', 'en', 'en']);
    }
  });

  it('without a language it has a table for: German on a provisioned instance, English on a self-hosted one', () => {
    for (const l of [undefined, '', '  ', 'fr', 'it-CH']) {
      expect([l, noticeLanguage(l, true), noticeLanguage(l, false)]).toEqual([l, 'de', 'en']);
    }
  });

  it('reads "provisioned" from any of the control plane\'s markers', () => {
    for (const marker of ['LYNOX_MANAGED_INSTANCE_ID', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE', undefined]) {
      for (const k of ['LYNOX_MANAGED_INSTANCE_ID', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE']) vi.stubEnv(k, '');
      if (marker !== undefined) vi.stubEnv(marker, 'set');
      expect([marker, noticeLanguage(undefined)]).toEqual([marker, marker === undefined ? 'en' : 'de']);
    }
  });
});

/** Every sentence of a table with sample arguments, so the two languages can be compared one by one. */
function workerSamples(n: WorkerNotices): Record<string, string> {
  return {
    consentManyTitle: n.consentManyTitle(4), consentManyBody: n.consentManyBody, consentOneTitle: n.consentOneTitle,
    consentOneBody: n.consentOneBody('Wochenbericht', true), failed: n.failed('E'), stoppedWith: n.stoppedWith('E'),
    stopped: n.stopped, chipRunAgain: n.chipRunAgain, chipRetry: n.chipRetry, chipExplain: n.chipExplain,
    containedResult: n.containedResult, containedQuestion: n.containedQuestion, containedQuestionInquiry: n.containedQuestionInquiry,
    workflowIncomplete: n.workflowIncomplete('Wochenbericht', 'failed'), errorLabel: n.errorLabel,
    failedStepsLabel: n.failedStepsLabel, writesLabel: n.writesLabel, workflowRef: n.workflowRef('r-1', 'w-1'),
    workflowReply: n.workflowReply('(x)'), reminderTitle: n.reminderTitle, interrupted: n.interrupted,
    confirmationSkipped: n.confirmationSkipped, workflowCompleted: n.workflowCompleted('r-1'),
    workflowGone: n.workflowGone(undefined), workflowGoneId: n.workflowGone('w-1'), eventRunFailed: n.eventRunFailed,
    ...Object.fromEntries(Object.entries(STORED_EVENT_REASONS).map(([k, r]) => [`eventReason.${k}`, n.eventReason(r)])),
    eventNotRun: n.eventsNotRun(1, 'X'), eventsNotRun: n.eventsNotRun(3, 'X'), eventOutcomeUnknown: n.eventOutcomeUnknown,
    mandateUnstamped: n.mandateUnstamped, planAuthorsUnreadable: n.planAuthorsUnreadable, planEnded: n.planEnded,
    planOfAnother: n.planOfAnother, planRunUnrecorded: n.planRunUnrecorded, unknownEffect: n.unknownEffect('bulk_x'),
    resumedManaged: n.resumedRunNotContained(true), resumedSelfHosted: n.resumedRunNotContained(false),
    watchChanged: n.watchChanged('https://a.example/p', 'A'),
  };
}
/** Each stored English reason of an event that is said, as an old row holds it. */
const STORED_EVENT_REASONS = {
  noReason: NO_REASON_RECORDED, runFailed: EVENT_RUN_FAILED_EN, triggerNotLive: EVENT_TRIGGER_NOT_LIVE, shopMoved: EVENT_SHOP_MOVED,
  valuesUnreadable: EVENT_VALUES_UNREADABLE, mappingRefused: EVENT_MAPPING_REFUSED, asks: WEBHOOK_ASKS_RESULT,
  accessEnded: ACCESS_ENDED_RESULT, mandateUnstamped: MANDATE_UNSTAMPED_RESULT, planEnded: PLAN_ENDED_RESULT,
  firstRun: firstRunUnconfirmedReason('wf-orders'),
} as const;
/** The German of each worker sentence, as ux wrote it (Rest-P), compared whole. */
const DE_WORKER: Readonly<Record<string, string>> = {
  'eventReason.noReason': 'kein Grund festgehalten',
  'eventReason.runFailed': 'Der Lauf zu einem Ereignis wurde nicht fertig. lynox führt dieses Ereignis nicht noch einmal aus; spätere Ereignisse laufen wie gewohnt. Sollte es etwas ändern, prüf, ob das fehlt, und erledige es von Hand oder bitte lynox im Chat darum.',
  'eventReason.triggerNotLive': 'Sein Auslöser nimmt keine Ereignisse an, darum laufen sie nicht. Sieh dir den Auslöser unter Automation → Trigger an.',
  'eventReason.shopMoved': 'Das Ereignis kam von einem anderen Shop als dem, mit dem der Auslöser jetzt verbunden ist; darum lief es nicht.',
  'eventReason.valuesUnreadable': 'Die Werte des Ereignisses liessen sich mit dem Schlüssel dieser Instanz nicht lesen; es lief nicht und läuft auch später nicht.',
  'eventReason.mappingRefused': 'Nicht ausgeführt: Ein Wert aus dem Ereignis bestimmt in diesem Workflow, womit ein Schritt läuft; erlaubt ist er nur im Aufgabentext. Ändere den Workflow oder bitte lynox im Chat, den Schritt zu finden. Dieses Ereignis läuft nicht mehr.',
  'eventReason.asks': 'Nicht ausgeführt: Dieser Workflow stellt beim Laufen eine Frage, und ein Lauf durch ein Webhook-Ereignis kann nicht auf eine Antwort warten. Ändere den Workflow, damit er nicht fragt; dann laufen spätere Ereignisse, dieses nicht mehr.',
  'eventReason.accessEnded': 'Mittendrin angehalten: Der Zugang einer Person, die diesen Plan eingerichtet oder geändert hat, ist beendet.',
  'eventReason.mandateUnstamped': 'Diesen Zeitplan hat jemand eingerichtet oder geändert, dem du Zugang gegeben hast. Er läuft erst nach deiner Bestätigung unter Automation → Trigger; übersprungen.',
  'eventReason.planEnded': 'Diesen Zeitplan oder seinen Workflow hat jemand eingerichtet oder geändert, dessen Zugang beendet ist; darum läuft er nicht.',
  'eventReason.firstRun': 'Workflow „wf-orders“ ist vor dem ersten Lauf noch nicht bestätigt; der Auslöser ist darum aus. Plane den Workflow in der Bibliothek ein und schalte den Auslöser wieder ein.',
  eventNotRun: 'Ein Ereignis wurde nicht ausgeführt: X',
  eventsNotRun: '3 Ereignisse wurden nicht ausgeführt: X',
  eventOutcomeUnknown: 'Ein Ereignis lief gerade, als die Engine anhielt. Es kann gewirkt haben und läuft nicht von selbst noch einmal. Prüf, ob es gewirkt hat, bevor du dasselbe von Hand tust.',
  mandateUnstamped: 'Diesen Zeitplan hat jemand eingerichtet oder geändert, dem du Zugang gegeben hast. Er läuft erst nach deiner Bestätigung unter Automation → Trigger; übersprungen.',
  planAuthorsUnreadable: 'Wer den Workflow dieses Zeitplans eingerichtet hat, liess sich nicht lesen; darum lief er nicht.',
  planEnded: 'Diesen Zeitplan oder seinen Workflow hat jemand eingerichtet oder geändert, dessen Zugang beendet ist; darum läuft er nicht.',
  planOfAnother: 'Nicht ausgeführt: Dieser Plan handelt für eine andere Person mit Zugang. Von Hand starten darf ihn nur der Inhaber.',
  planRunUnrecorded: 'Nicht ausgeführt: Dieser Plan handelt für jemanden, dem du Zugang gegeben hast, und sein Start lässt sich gerade nicht im Protokoll der Instanz festhalten.',
  unknownEffect: 'Unbekannte Wirkung „bulk_x“ im Auslöser; übersprungen.',
  resumedManaged: 'Der Chat dieses Laufs wurde vor deiner Antwort gelöscht; lynox konnte den neuen nicht gleich schützen. Deine Antwort blieb ungenutzt. Starte die Aufgabe neu. Wiederholt es sich, schreib an support@lynox.ai.',
  resumedSelfHosted: 'Der Chat dieses Laufs wurde vor deiner Antwort gelöscht; lynox konnte den neuen nicht gleich schützen. Deine Antwort blieb ungenutzt. Starte die Aufgabe neu. Wiederholt es sich, nennt das Instanz-Protokoll den Grund.',
  watchChanged: 'https://a.example/p hat sich geändert.\n\nA',
};
/** The German of the rest of the halt reasons (ux Rest-P HR), compared whole. */
const DE_HALT_REST: Readonly<Partial<Record<keyof typeof BULK_HALT_REASONS, string>>> = {
  checksum: 'Der Lauf hat sich seit der Freigabe geändert.',
  atomicRolledBack: 'Ein Ziel liess sich nicht schreiben; alle zuvor geschriebenen sind zurückgenommen. Geändert ist nichts.',
  atomicRollbackIncomplete: 'Ein Ziel liess sich nicht schreiben, und das Zurücknehmen gelang nicht ganz. Die markierten Ziele unter Massenläufe von Hand prüfen.',
  atomicStoppedRolledBack: 'Von Hand gestoppt; alle zuvor geschriebenen Ziele sind zurückgenommen. Geändert ist nichts.',
  atomicStoppedRollbackIncomplete: 'Von Hand gestoppt, und das Zurücknehmen gelang nicht ganz. Die markierten Ziele unter Massenläufe von Hand prüfen.',
  atomicTimeRolledBack: 'Zeitbudget aufgebraucht; alle zuvor geschriebenen Ziele sind zurückgenommen. Geändert ist nichts.',
  atomicTimeRollbackIncomplete: 'Zeitbudget aufgebraucht, und das Zurücknehmen gelang nicht ganz. Die markierten Ziele unter Massenläufe von Hand prüfen.',
  unrecorded: 'Ein Lesezugriff liess sich nicht im Protokoll der Instanz festhalten und wurde deshalb nicht gesendet.',
  runUnrecorded: 'Der Lauf liess sich nicht im Protokoll der Instanz festhalten; nichts gelesen, nichts geschrieben.',
  listed: 'Liste gelesen. Wartet, bis die Ziele geprüft sind und das Lesen gestartet wird.',
  listNotAList: 'Eine Seite der Liste ist keine Liste.',
  listUnreadable: 'Eine Seite der Liste liess sich nicht lesen.',
  listTooLarge: 'Die Liste ist länger oder grösser, als ein Massenlauf fassen kann.',
  listNoProgress: 'Eine volle Seite der Liste brachte kein neues Ziel.',
  listFormWithdrawn: 'Die Adresse der Liste darf ein Massenlauf nicht mehr lesen.',
  listFilterWithdrawn: 'Mit diesem Filter darf ein Massenlauf die Liste nicht mehr lesen. Geändert hat lynox nichts.',
  listOrder: 'Eine Seite der Liste ging nicht in der Reihenfolge der IDs weiter.',
  listReadFailed: 'Der Shop hat eine Seite der Liste mit einem Fehler beantwortet.',
  shopInactive: 'Der Shop ist geschlossen oder gesperrt.',
  formCost: 'Der Shop hat eine Abfrage als zu aufwendig abgelehnt.',
  shopifyReadOff: 'Lesen von Shopify-Shops per Massenlauf ist auf dieser Instanz ausgeschaltet.',
  shopifyWriteOff: 'Schreiben in Shopify-Shops per Massenlauf ist auf dieser Instanz ausgeschaltet. Ist es wieder an, lässt sich der Lauf fortsetzen.',
  superseded: 'An seiner Stelle wurde ein anderer Lauf mit Beurteilung gestartet. Dieser hat nichts geschrieben.',
  judgeModel: 'Der KI-Anbieter dieses Laufs hat kein Modell zum Beurteilen, oder der Betreiber erlaubt es nicht.',
};
/** The German of each bulk lead, as ux wrote it (Rest-P), compared whole. */
const DE_BULK: Readonly<Record<string, string>> = {
  noRun: 'Diesen Massenlauf gibt es nicht.',
  effectMismatch: 'Der Auslöser passt nicht zu diesem Massenlauf.',
  notApproved: 'Massenlauf nicht freigegeben; nichts geschrieben.',
  haltedResume: 'Massenlauf angehalten; geschrieben wird erst nach dem Fortsetzen.',
  otherLoop: 'Massenlauf beendet: Ein anderer Durchgang bearbeitet ihn.',
  otherLoopHolds: 'Massenlauf wartet auf Ziele, die ein anderer Durchgang hält.',
  noJudgedRun: 'Diesen Massenlauf mit Beurteilung gibt es nicht.',
  nothingToJudge: 'Der Massenlauf hat noch nichts zu beurteilen.',
  notReadyToJudge: 'Massenlauf nicht bereit zum Beurteilen; nichts beurteilt.',
  notReadyToJudgeHalted: 'Massenlauf nicht bereit zum Beurteilen und angehalten; nichts beurteilt.',
  noExternalTargets: 'Der Massenlauf hat keine externen Ziele zum Lesen.',
  notReadyToRead: 'Massenlauf nicht bereit zum Lesen; nichts gelesen.',
  notReadyToReadHalted: 'Massenlauf nicht bereit zum Lesen und angehalten; nichts gelesen.',
  'atomic.stopped.complete': 'Massenlauf (ganz oder gar nicht) gestoppt und zurückgenommen.',
  'atomic.stopped.incomplete': 'Massenlauf (ganz oder gar nicht) gestoppt; das Zurücknehmen gelang nicht ganz. Markierte Ziele unter Massenläufe prüfen.',
  'atomic.time.complete': 'Massenlauf (ganz oder gar nicht): Zeit abgelaufen, alles zurückgenommen.',
  'atomic.time.incomplete': 'Massenlauf (ganz oder gar nicht): Zeit abgelaufen; das Zurücknehmen gelang nicht ganz. Markierte Ziele unter Massenläufe prüfen.',
  'atomic.failed.complete': 'Massenlauf (ganz oder gar nicht) abgebrochen und zurückgenommen.',
  'atomic.failed.incomplete': 'Massenlauf (ganz oder gar nicht) abgebrochen; das Zurücknehmen gelang nicht ganz. Markierte Ziele unter Massenläufe prüfen.',
  bulkOff: 'Massenläufe sind auf dieser Instanz nicht verfügbar; übersprungen.',
  previewEnded: 'Vorschau beendet.',
  judgeEnded: 'Beurteilung beendet.',
  writeError: 'Das Schreiben des Massenlaufs hat wegen eines Fehlers in lynox angehalten.',
};
/** Every reason a bulk run halts on, read off the table itself: each has a German sentence (ux Rest-P). */
const ALL_HALTS = Object.keys(BULK_HALT_REASONS) as (keyof typeof BULK_HALT_REASONS)[];
/** The unclear-send warning alone, as the counts open with it. */
function applyWarning(n: BulkNotices, sentUnknown: number): string {
  const all = n.applyCounts({ applied: 0, foundAsPlanned: 0, failed: 0, conflicts: 0, undone: 0, total: 1, sentUnknown });
  return all.slice(0, all.indexOf('.') + 1);
}
function bulkSamples(n: BulkNotices): Record<string, string> {
  return {
    applyDone: n.applyDone, previewDone: n.previewDone, readDone: n.readDone, listEmpty: n.listEmpty,
    listWaiting: n.listWaiting, judgeDone: n.judgeDone,
    listNoMatchType: n.listNoMatch('product_type'), listNoMatchVendor: n.listNoMatch('vendor'), listNoMatchBoth: n.listNoMatch('both'),
    listNoneLeftType: n.listNoneLeft('product_type'), listNoneLeftVendor: n.listNoneLeft('vendor'), listNoneLeftBoth: n.listNoneLeft('both'),
    applyCounts: n.applyCounts({ applied: 3, foundAsPlanned: 1, failed: 1, conflicts: 0, undone: 0, total: 5, sentUnknown: 1 }),
    previewCounts: n.previewCounts(2, 1, 0, 3), judgeCounts: n.judgeCounts(2, 1, 0, 3), costs: n.costs(2, 0.01),
    previewStopped: n.previewStopped, listStopped: n.listStopped, judgeStopped: n.judgeStopped,
    ...Object.fromEntries(ALL_HALTS.map((k) => [`halted.${k}`, n.halted('apply', BULK_HALT_REASONS[k])])),
    noRun: n.noRun, effectMismatch: n.effectMismatch, notApproved: n.notApproved('planned'), haltedResume: n.haltedResume,
    otherLoop: n.otherLoop, otherLoopHolds: n.otherLoopHolds, noJudgedRun: n.noJudgedRun, nothingToJudge: n.nothingToJudge,
    notReadyToJudge: n.notReadyToJudge('approved', false), notReadyToJudgeHalted: n.notReadyToJudge('planned', true),
    noExternalTargets: n.noExternalTargets,
    notReadyToRead: n.notReadyToRead('approved', false), notReadyToReadHalted: n.notReadyToRead('planned', true),
    ...Object.fromEntries((['stopped', 'time', 'failed'] as const).flatMap((cause) => [true, false].map((complete) =>
      [`atomic.${cause}.${complete ? 'complete' : 'incomplete'}`, n.atomicEnded(cause, complete)]))),
    bulkOff: n.bulkOff, previewEnded: n.previewEnded, judgeEnded: n.judgeEnded, writeError: n.writeError,
  };
}

describe('the notice tables', () => {
  // A sentence that is the same in both languages was not translated — except one that is the
  // same word in German.
  const SAME_IN_BOTH = new Set(['chipDetails']);
  it('has a German sentence for every English one of the worker', () => {
    const [en, de] = [workerSamples(WORKER_NOTICES.en), workerSamples(WORKER_NOTICES.de)];
    expect(Object.keys(de)).toEqual(Object.keys(en));
    expect(Object.keys(en).filter((k) => !SAME_IN_BOTH.has(k) && en[k] === de[k])).toEqual([]);
    expect(Object.keys(WORKER_NOTICES.de).sort()).toEqual(Object.keys(WORKER_NOTICES.en).sort());
  });

  it('has a German sentence for every English one of a bulk run', () => {
    const [en, de] = [bulkSamples(BULK_NOTICES.en), bulkSamples(BULK_NOTICES.de)];
    expect(Object.keys(en).filter((k) => en[k] === de[k])).toEqual([]);
    // Each reason is a German sentence, not the stored English text, in every phase.
    for (const k of ALL_HALTS) {
      expect([k, BULK_NOTICES.de.halted('apply', BULK_HALT_REASONS[k]).includes(BULK_HALT_REASONS[k])]).toEqual([k, false]);
    }
    // A judging pass halts as unavailable on its model too, so only its sentence names the model (ux U-105 M1).
    expect(BULK_NOTICES.de.halted('judge', BULK_HALT_REASONS.unavailable)).toBe('Beurteilung angehalten: KI-Modell oder Zielsystem nicht erreichbar, oder Fehler in lynox. Der Lauf lässt sich fortsetzen; hält er gleich wieder an, später erneut versuchen.');
    for (const phase of ['apply', 'preview'] as const) {
      expect([phase, BULK_NOTICES.de.halted(phase, BULK_HALT_REASONS.unavailable).includes('Zielsystem nicht erreichbar oder Fehler in lynox.')]).toEqual([phase, true]);
    }
    // No other reason a judging pass halts on gets the model's sentence.
    for (const k of ALL_HALTS.filter((r) => r !== 'unavailable')) {
      expect([k, BULK_NOTICES.de.halted('judge', BULK_HALT_REASONS[k]).includes('KI-Modell oder Zielsystem')]).toEqual([k, false]);
    }
    // A reason the table has no German for is quoted as stored, not dropped.
    expect(BULK_NOTICES.de.halted('preview', 'a cause the run named')).toBe('Vorschau angehalten: a cause the run named.');
  });

  it('says every halt reason in German, as ux wrote the rest, and a row stored in English before too', () => {
    for (const [k, de] of Object.entries(DE_HALT_REST)) {
      const r = BULK_HALT_REASONS[k as keyof typeof BULK_HALT_REASONS];
      expect([k, BULK_NOTICES.de.halted('apply', r)]).toEqual([k, `Massenlauf angehalten: ${de}`]);
      expect([k, BULK_NOTICES.de.halted('preview', r)]).toEqual([k, `Vorschau angehalten: ${de}`]);
      expect([k, BULK_NOTICES.de.halted('judge', r)]).toEqual([k, `Beurteilung angehalten: ${de}`]);
    }
    // No reason of the table is quoted as stored any more: each is a German sentence in every phase.
    for (const k of ALL_HALTS) {
      for (const phase of ['apply', 'preview', 'judge'] as const) {
        expect([k, phase, BULK_NOTICES.de.halted(phase, BULK_HALT_REASONS[k]).endsWith(`${BULK_HALT_REASONS[k]}.`)]).toEqual([k, phase, false]);
      }
    }
    // A halt stored in English earlier (the text as an old row holds it) is said in German.
    expect(BULK_NOTICES.de.halted('preview', 'the target system is not available'))
      .toBe('Vorschau angehalten: Zielsystem nicht erreichbar oder Fehler in lynox. Der Lauf lässt sich fortsetzen; hält er gleich wieder an, ist das Zielsystem noch nicht erreichbar.');
    expect(BULK_NOTICES.de.halted('apply', 'the run no longer matches what was approved')).toBe('Massenlauf angehalten: Der Lauf hat sich seit der Freigabe geändert.');
    // The English stays as it was: the stored reason in the frame.
    expect(BULK_NOTICES.en.halted('apply', BULK_HALT_REASONS.checksum)).toBe(`Bulk run halted: ${BULK_HALT_REASONS.checksum}.`);
  });

  it('says each bulk lead and each worker sentence in German as ux wrote it', () => {
    const bulk = bulkSamples(BULK_NOTICES.de);
    expect(Object.fromEntries(Object.keys(DE_BULK).map((k) => [k, bulk[k]]))).toEqual(DE_BULK);
    const worker = workerSamples(WORKER_NOTICES.de);
    expect(Object.fromEntries(Object.keys(DE_WORKER).map((k) => [k, worker[k]]))).toEqual(DE_WORKER);
    // English says a stored reason as it is stored.
    for (const r of Object.values(STORED_EVENT_REASONS)) expect(WORKER_NOTICES.en.eventReason(r)).toBe(r);
  });

  it('says every reason of a failed event that may be said in German, and quotes one it has none for', () => {
    // Every member of OWN_FAILURE_REASONS but the owner's stop, which is never said (the drain skips it).
    for (const r of OWN_FAILURE_REASONS) {
      if (r === EVENT_STOPPED) continue;
      expect([r, WORKER_NOTICES.de.eventReason(r) !== r]).toEqual([r, true]);
    }
    expect(WORKER_NOTICES.de.eventReason('misdelivered')).toBe('misdelivered');
    // A stored reason as an old row holds it, written out, is said in German.
    expect(WORKER_NOTICES.de.eventReason('The event came from another shop than the one the trigger\'s connection now serves, so it was not run.'))
      .toBe('Das Ereignis kam von einem anderen Shop als dem, mit dem der Auslöser jetzt verbunden ist; darum lief es nicht.');
    // Only the stored shape of a first-run refusal is read as one: anchored at both ends, with an id.
    const first = firstRunUnconfirmedReason('wf-1');
    for (const near of [`x${first}`, `${first} `, firstRunUnconfirmedReason(''), first.replace('first-run', 'first run')]) {
      expect(WORKER_NOTICES.de.eventReason(near)).toBe(near);
    }
  });

  it('cuts a long workflow id in the German first-run sentence, and keeps it within the web-push cut', () => {
    const n = WORKER_NOTICES.de;
    const fits = 'w'.repeat(SAID_WORKFLOW_ID_MAX);
    const fitsBody = n.eventsNotRun(1, n.eventReason(firstRunUnconfirmedReason(fits)));
    expect(fitsBody).toContain(`„${fits}“`);
    expect(fitsBody).not.toContain('…');
    expect(fitsBody.length).toBe(236);
    const long = `${'a'.repeat(SAID_WORKFLOW_ID_MAX)}${'q'.repeat(24)}`;
    const longBody = n.eventsNotRun(1, n.eventReason(firstRunUnconfirmedReason(long)));
    expect(longBody.length <= REMINDER_BODY_MAX).toBe(true);
    expect(longBody).toContain('…');
    expect(longBody).toContain(`„${'a'.repeat(SAID_WORKFLOW_ID_MAX)}…“`);
    expect(longBody).not.toContain('q');
    expect(longBody.length).toBe(237);
    // One character over is cut too.
    expect(n.eventReason(firstRunUnconfirmedReason(`${fits}x`))).toContain(`„${fits}…“`);
  });

  it('names a German workflow status it knows, and leaves out one it does not', () => {
    expect(WORKER_NOTICES.de.workflowIncomplete('W', 'rejected')).toBe('Dein geplanter Workflow „W“ ist nicht fertig geworden (Status: abgelehnt).');
    expect(WORKER_NOTICES.en.workflowIncomplete('W', 'failed')).toBe('Your scheduled workflow "W" didn\'t complete (status: failed).');
    for (const s of [undefined, 'unknown', 'running']) {
      expect(WORKER_NOTICES.de.workflowIncomplete('W', s)).toBe('Dein geplanter Workflow „W“ ist nicht fertig geworden.');
      expect(WORKER_NOTICES.en.workflowIncomplete('W', s)).toBe('Your scheduled workflow "W" didn\'t complete.');
    }
  });

  // Web push cuts a body at REMINDER_BODY_MAX: the sentence after the quoted title must survive
  // the longest title the reminder lets through (80 units) with the outside-content note.
  // A bulk outcome is pushed whole: the longest a run produces in ordinary use must fit, and when
  // a body runs long the cut takes the counts, never the unclear-send warning before them.
  it('keeps a bulk outcome within the web-push cut, the warning first, in both languages', () => {
    const c = { applied: 12_400, foundAsPlanned: 3_120, failed: 130, conflicts: 20, undone: 10, total: 15_000, sentUnknown: 30 };
    for (const lang of ['de', 'en'] as const) {
      const b = BULK_NOTICES[lang];
      for (const lead of [b.applyDone, ...(['timeBudget', 'failureRate', 'consecutiveFailures', 'maxTargets', 'expired'] as const)
        .map((k) => b.halted('apply', BULK_HALT_REASONS[k]))]) {
        const body = `${lead} ${b.applyCounts(c)}`;
        expect([lang, lead, body.length <= REMINDER_BODY_MAX]).toEqual([lang, lead, true]);
      }
      // A longer reason leaves the cut to the counts, but the lead and the warning after it stand
      // whole: at most 180 for lead and reason in every phase (ux U-105), which leaves the
      // warning room even with a four-digit count.
      const warning = applyWarning(b, 9_999);
      for (const phase of ['apply', 'preview', 'judge'] as const) {
        for (const k of ALL_HALTS) {
          const lead = b.halted(phase, BULK_HALT_REASONS[k]);
          if (lang === 'de') {
            // The reason itself at most 157 (ux Rest-P rule 5), and with its frame at most 180.
            const frame = `${phase === 'apply' ? 'Massenlauf' : phase === 'preview' ? 'Vorschau' : 'Beurteilung'} angehalten: `;
            expect([phase, k, lead.startsWith(frame), lead.length - frame.length <= 157]).toEqual([phase, k, true, true]);
          }
          expect([lang, phase, k, lead.length <= 180]).toEqual([lang, phase, k, true]);
          expect([lang, phase, k, `${lead} ${warning}`.length <= REMINDER_BODY_MAX]).toEqual([lang, phase, k, true]);
        }
      }
      // Every other lead a counted summary opens with leaves the warning room too.
      const leads = [b.notApproved('approved'), b.haltedResume, b.otherLoop, b.otherLoopHolds, b.notReadyToJudge('approved', true),
        b.notReadyToRead('approved', true), ...(['stopped', 'time', 'failed'] as const).flatMap((cause) => [b.atomicEnded(cause, true), b.atomicEnded(cause, false)])];
      for (const lead of leads) expect([lang, lead, `${lead} ${warning}`.length <= REMINDER_BODY_MAX]).toEqual([lang, lead, true]);
      const counts = b.applyCounts(c);
      expect(counts.indexOf(lang === 'de' ? 'unklar' : 'unclear')).toBeLessThan(counts.indexOf(lang === 'de' ? 'geschrieben' : 'applied'));
      // A count of 0 is left out, but what was written and the total always stand.
      expect(b.applyCounts({ applied: 0, foundAsPlanned: 0, failed: 0, conflicts: 0, undone: 0, total: 4, sentUnknown: 0 }))
        .toBe(lang === 'de' ? '0 geschrieben, von 4 Zielen.' : '0 applied, of 4 targets.');
    }
  });

  it('keeps every fixed push body within the web-push cut, in both languages', () => {
    const longest = 'x'.repeat(79) + '…';
    for (const lang of ['de', 'en'] as const) {
      const n = WORKER_NOTICES[lang];
      for (const body of [n.consentOneBody(longest, true), n.consentManyBody, n.interrupted, n.confirmationSkipped,
        n.workflowGone(undefined), n.containedResult, n.containedQuestion, n.eventRunFailed,
        // Three digits before the point, so the room is real (ux U-099).
        `${n.budgetCut('cost', '$150.00')}\n\n${n.containedResult}`, `${n.budgetCut('turns', '300')}\n\n${n.containedResult}`]) {
        expect([lang, body.length <= REMINDER_BODY_MAX]).toEqual([lang, true]);
      }
    }
  });

  it('keeps every German push of an event, a plan and a bulk refusal within the web-push cut, frame included', () => {
    const n = WORKER_NOTICES.de;
    const b = BULK_NOTICES.de;
    // A dropped event's reason is said in its frame, one event or many. A first-run refusal switches
    // its trigger off, so the events after the first are dropped as not live: up to 999 of it fit.
    for (const r of [NO_REASON_RECORDED, EVENT_TRIGGER_NOT_LIVE, EVENT_SHOP_MOVED, MANDATE_UNSTAMPED_RESULT, PLAN_ENDED_RESULT,
      firstRunUnconfirmedReason('w'.repeat(SAID_WORKFLOW_ID_MAX)), firstRunUnconfirmedReason('w'.repeat(60))]) {
      for (const count of r.startsWith('Workflow "') ? [1, 999] : [1, 99_999]) {
        const body = n.eventsNotRun(count, n.eventReason(r));
        expect([r, count, body.length <= REMINDER_BODY_MAX]).toEqual([r, count, true]);
      }
    }
    // A failed event's reason, the unknown outcome and the plan refusals are said on their own.
    for (const body of [...[EVENT_RUN_FAILED_EN, EVENT_VALUES_UNREADABLE, EVENT_MAPPING_REFUSED, WEBHOOK_ASKS_RESULT, ACCESS_ENDED_RESULT].map((r) => n.eventReason(r)),
      n.eventOutcomeUnknown, n.mandateUnstamped, n.planAuthorsUnreadable, n.planEnded, n.planOfAnother, n.planRunUnrecorded,
      n.unknownEffect('x'.repeat(40)), b.bulkOff, b.previewEnded, b.judgeEnded, b.noRun, b.effectMismatch, b.noJudgedRun,
      b.nothingToJudge, b.noExternalTargets, n.failed(b.writeError)]) {
      expect([body, body.length <= REMINDER_BODY_MAX]).toEqual([body, true]);
    }
    // A resumed run that could not be contained, in its failure frame: managed, and self-hosted at exactly the cut.
    expect(n.failed(n.resumedRunNotContained(true)).length).toBe(230);
    expect(n.failed(n.resumedRunNotContained(false)).length).toBe(REMINDER_BODY_MAX);
  });
});

// ---------------------------------------------------------------------------------------------
// The detector: a notice sentence written as a fixed string at a call site, instead of through a
// table. It reads the sources line by line, at the forms a notice takes there (a recorded and
// pushed result, an event line, a message's title or body, a bulk outcome's summary), and reports
// a literal that holds prose. A literal over several lines is not seen.
// ---------------------------------------------------------------------------------------------

const ROOT = join(__dirname, '..', '..');
const SOURCES = [
  'src/core/worker-loop.ts', 'src/core/bulk-apply.ts', 'src/core/bulk-preview.ts', 'src/core/bulk-judge.ts',
  'src/integrations/inbox/inbox-reminder-poller.ts',
];
const LITERAL = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.|\$\{[^}]*\})*`/g;
const SITE = /recordAndNotify\(task|#sayEvent\([^)]|#refuseBeforeDispatch\(task|\btitle: |\bbody: |summary: |summarize\(ledger, [^,]+, |halted: /;
/** A constant handed to a site that pushes what it is given (the old `INTERRUPTED_RESULT` form). */
const CONSTANT_ARG = /(?:recordAndNotify\(task|#sayEvent\([^,]+,[^,]+|#refuseBeforeDispatch\(task, entry), ([A-Z][A-Z0-9_]{3,})\b/;
/** A stored constant recorded as it is, with what is pushed in its place from the table (`recordAndNotify`'s `said`). */
const SAID_FROM_TABLE = /^\s*this\.recordAndNotify\(task, [A-Z][A-Z0-9_]{3,}, [^,]+, this\.#notices\(\)\.\w+\);$/;

function fixedNotices(file: string, source: string): string[] {
  const found: string[] = [];
  for (const line of source.split('\n')) {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
    // The English table at a call site skips the language as surely as a fixed string does.
    if (file.endsWith('worker-loop.ts') && /\b(?:WORKER|BULK)_NOTICES\.en\b/.test(line)
      && !t.startsWith('export const CONTAINED_') && !t.startsWith('notices: WorkerNotices = WORKER_NOTICES.en')) {
      found.push(`${file}: ${t}`);
    }
    // A `pending` outcome is recorded, never pushed (worker-loop.ts, the bulk branches).
    if (!SITE.test(line) || /\bpending\(/.test(line)) continue;
    const constant = CONSTANT_ARG.exec(line);
    if (constant && !SAID_FROM_TABLE.test(line)) found.push(`${file}: ${constant[1]!}`);
    for (const m of line.matchAll(LITERAL)) {
      // Prose is two words, an interpolation counting as one (`${url} changed.`), but never two
      // interpolations alone (`${mark} ${task.title}`); a lone word counts too where a title or
      // body is nothing but that word (`title: 'Erinnerung'`).
      const text = m[0].slice(1, -1).replace(/\$\{[^}]*\}/g, ' \u0000 ').replace(/\\u[0-9A-Fa-f]{4}|\\n/g, ' ');
      const words = text.match(/[A-Za-zÄÖÜäöü]{2,}|\u0000/g) ?? [];
      const real = words.filter((w) => w !== '\u0000').length;
      const lone = /\b(?:title|body): $/.test(line.slice(0, m.index)) && real === 1 && words.length === 1 && words[0]!.length >= 3;
      if (lone || (real >= 1 && words.length >= 2)) found.push(`${file}: ${m[0]}`);
    }
  }
  return found;
}

/**
 * The notices still English at their call site, as the detector sees them; each is still to be
 * translated, or says why it stays English. This list only shrinks: a new entry is a new fixed notice, and an entry the code no
 * longer has must be taken out. It is what the DETECTOR sees, not all that is left: a sentence
 * built in a variable first, or a literal over several lines, is not in it.
 */
const STILL_ENGLISH: readonly string[] = [
  // Excluded on purpose (ux Rest-P E15, inventory D4): the watch's escalation BODY is the seed of
  // its chat thread, which the model reads when the owner replies, so it stays English model
  // context. The push the owner reads is `pushBody`, from the table (`WorkerNotices.watchChanged`).
  'src/core/worker-loop.ts: `${config.url} changed.\\n\\n${truncatedAnalysis}`',
];

describe('the fixed-notice detector', () => {
  it('finds a notice written as a fixed string, and an English table at a call site', () => {
    expect(fixedNotices('src/core/worker-loop.ts', [
      "      this.recordAndNotify(task, 'A new sentence for the owner.', false);",
      '        body: `Your run ${id} finished early.`,',
      "    this.#sayEvent(triggerId, title, 'Nothing came in.');",
      '      title: WORKER_NOTICES.en.reminderTitle,',
      "      title: 'Erinnerung',",
      '        body: `${config.url} changed.`,',
      '      this.recordAndNotify(task, NEW_FIXED_RESULT, false);',
      "  return { status: 'done', summary: summarize(ledger, runId, 'Bulk run done.') };",
      // A said argument that is not the table's does not excuse the constant.
      "      this.recordAndNotify(task, NEW_FIXED_RESULT, 'stopped', 'Not the table.');",
      "      this.recordAndNotify(task, NEW_FIXED_RESULT, 'stopped', WORKER_NOTICES.de.planEnded);",
    ].join('\n'))).toHaveLength(11);
    // …and not a sentence through the table, an id, a mark or a pending lead.
    expect(fixedNotices('src/core/worker-loop.ts', [
      '      this.recordAndNotify(task, this.#notices().interrupted, false);',
      '        title: `\\u2753 ${task.title}`,',
      "    return pending(now() + 1, 'Bulk preview paused.');",
      // A stored constant recorded as it is, pushed from the table in the owner's language.
      "            this.recordAndNotify(task, PLAN_ENDED_RESULT, 'stopped', this.#notices().planEnded);",
      '    // body: \'A comment is not a notice.\'',
    ].join('\n'))).toEqual([]);
  });

  it('finds in the sources exactly the notices still listed as English', () => {
    const found = SOURCES.flatMap((f) => fixedNotices(f, readFileSync(join(ROOT, f), 'utf8')));
    expect(found).toEqual([...STILL_ENGLISH]);
  });
});
