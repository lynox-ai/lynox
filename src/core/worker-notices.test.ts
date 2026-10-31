import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { noticeLanguage } from './notice-language.js';
import { WORKER_NOTICES, type WorkerNotices } from './worker-notices.js';
import { BULK_NOTICES, type BulkNotices } from './bulk-notices.js';
import { BULK_HALT_REASONS } from './bulk-ledger.js';
import { REMINDER_BODY_MAX } from './worker-loop.js';

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
    workflowGone: n.workflowGone(undefined), workflowGoneId: n.workflowGone('w-1'),
  };
}
function bulkSamples(n: BulkNotices): Record<string, string> {
  return {
    applyDone: n.applyDone, previewDone: n.previewDone, readDone: n.readDone, listEmpty: n.listEmpty,
    listWaiting: n.listWaiting, judgeDone: n.judgeDone,
    applyCounts: n.applyCounts({ applied: 3, foundAsPlanned: 1, failed: 1, conflicts: 0, undone: 0, total: 5, sentUnknown: 1 }),
    previewCounts: n.previewCounts(2, 1, 0, 3), judgeCounts: n.judgeCounts(2, 1, 0, 3), costs: n.costs(2, 0.01),
    previewStopped: n.previewStopped, listStopped: n.listStopped, judgeStopped: n.judgeStopped,
    ...Object.fromEntries(['timeBudget', 'failureRate', 'consecutiveFailures', 'stoppedByOwner', 'maxTargets', 'awaitingStart', 'expired']
      .map((k) => [`halted.${k}`, n.halted('apply', BULK_HALT_REASONS[k as keyof typeof BULK_HALT_REASONS])])),
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
    // Each of the seven ordinary reasons is a German sentence, not the stored English text.
    for (const k of ['timeBudget', 'failureRate', 'consecutiveFailures', 'stoppedByOwner', 'maxTargets', 'awaitingStart', 'expired'] as const) {
      expect([k, BULK_NOTICES.de.halted('apply', BULK_HALT_REASONS[k]).includes(BULK_HALT_REASONS[k])]).toEqual([k, false]);
    }
    // A reason the table has no German for is quoted as stored, not dropped.
    expect(BULK_NOTICES.de.halted('preview', BULK_HALT_REASONS.unavailable)).toBe(`Vorschau angehalten: ${BULK_HALT_REASONS.unavailable}.`);
  });

  it('names a German workflow status it knows, and leaves out one it does not', () => {
    expect(WORKER_NOTICES.de.workflowIncomplete('W', 'rejected')).toBe('Dein geplanter Workflow „W“ ist nicht fertig geworden (Status: abgelehnt).');
    for (const s of [undefined, 'unknown', 'running']) {
      expect(WORKER_NOTICES.de.workflowIncomplete('W', s)).toBe('Dein geplanter Workflow „W“ ist nicht fertig geworden.');
    }
  });

  // Web push cuts a body at REMINDER_BODY_MAX: the sentence after the quoted title must survive
  // the longest title the reminder lets through (80 units) with the outside-content note.
  it('keeps every fixed push body within the web-push cut, in both languages', () => {
    const longest = 'x'.repeat(79) + '…';
    for (const lang of ['de', 'en'] as const) {
      const n = WORKER_NOTICES[lang];
      for (const body of [n.consentOneBody(longest, true), n.consentManyBody, n.interrupted, n.confirmationSkipped,
        n.workflowGone(undefined), n.containedResult, n.containedQuestion]) {
        expect([lang, body.length <= REMINDER_BODY_MAX]).toEqual([lang, true]);
      }
    }
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
const SITE = /recordAndNotify\(task|#sayEvent\([^)]|\btitle: |\bbody: |summary: |summarize\(ledger, [^,]+, |halted: /;

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
    for (const m of line.matchAll(LITERAL)) {
      if (/[A-Za-z]{2,} [A-Za-z]{2,}/.test(m[0].slice(1, -1).replace(/\$\{[^}]*\}/g, ' X '))) found.push(`${file}: ${m[0]}`);
    }
  }
  return found;
}

/**
 * The notices still English at their call site; each is still to be translated.
 * This list only shrinks: a new entry is a new fixed notice,
 * and an entry the code no longer has must be taken out, so the list says what is left.
 */
const STILL_ENGLISH: readonly string[] = [
  // Events (ux U-099 item 8, after the cut).
  'src/core/worker-loop.ts: `An event was not run: ${why}`',
  'src/core/worker-loop.ts: `${String(count)} events were not run: ${why}`',
  // An effect the engine does not know: a defect, not a customer path.
  'src/core/worker-loop.ts: `Unknown trigger effect \'${effect}\' — skipped`',
  // Bulk branches outside ordinary use.
  'src/core/worker-loop.ts: \'Bulk runs are not available on this instance — skipped.\'',
  'src/core/worker-loop.ts: \'Bulk runs are not available on this instance — skipped.\'',
  'src/core/worker-loop.ts: `Bulk preview halted: ${reason}.`',
  'src/core/worker-loop.ts: \'Bulk preview stopped.\'',
  'src/core/worker-loop.ts: \'Bulk runs are not available on this instance — skipped.\'',
  'src/core/worker-loop.ts: `Bulk judge halted: ${reason}.`',
  'src/core/worker-loop.ts: \'Bulk judge stopped.\'',
  'src/core/bulk-apply.ts: \'No bulk run with this id.\'',
  'src/core/bulk-apply.ts: \'The trigger effect does not match the bulk run.\'',
  'src/core/bulk-apply.ts: `Bulk run is ${run.phase}, not approved — nothing written.`',
  'src/core/bulk-apply.ts: \'Bulk run is halted — resume it to continue.\'',
  'src/core/bulk-apply.ts: `Bulk run halted: ${BULK_HALT_REASONS.checksum}.`',
  'src/core/bulk-apply.ts: `Bulk run halted: ${BULK_HALT_REASONS.shopifyWriteOff}.`',
  'src/core/bulk-apply.ts: `Bulk run halted: ${BULK_HALT_REASONS.unavailable}.`',
  'src/core/bulk-apply.ts: `Bulk run halted: ${BULK_HALT_REASONS.runUnrecorded}.`',
  'src/core/bulk-apply.ts: \'Bulk run stopped by another loop.\'',
  'src/core/bulk-apply.ts: \'Bulk run waiting for targets another loop holds.\'',
  'src/core/bulk-preview.ts: \'No bulk run with this id.\'',
  'src/core/bulk-preview.ts: \'The bulk run has no external targets to read.\'',
  'src/core/bulk-preview.ts: `Bulk run is ${run.phase}${run.haltReason !== null ? \' and halted\' : \'\'} — nothing read.`',
  'src/core/bulk-judge.ts: \'No judged bulk run with this id.\'',
  'src/core/bulk-judge.ts: \'The bulk run has nothing to judge yet.\'',
  'src/core/bulk-judge.ts: `Bulk run is ${run.phase}${run.haltReason !== null ? \' and halted\' : \'\'} — nothing judged.`',
];

describe('the fixed-notice detector', () => {
  it('finds a notice written as a fixed string, and an English table at a call site', () => {
    expect(fixedNotices('src/core/worker-loop.ts', [
      "      this.recordAndNotify(task, 'A new sentence for the owner.', false);",
      '        body: `Your run ${id} finished early.`,',
      "    this.#sayEvent(triggerId, title, 'Nothing came in.');",
      '      title: WORKER_NOTICES.en.reminderTitle,',
      "  return { status: 'done', summary: summarize(ledger, runId, 'Bulk run done.') };",
    ].join('\n'))).toHaveLength(5);
    // …and not a sentence through the table, an id, a mark or a pending lead.
    expect(fixedNotices('src/core/worker-loop.ts', [
      '      this.recordAndNotify(task, this.#notices().interrupted, false);',
      '        title: `\\u2753 ${task.title}`,',
      "    return pending(now() + 1, 'Bulk preview paused.');",
      '    // body: \'A comment is not a notice.\'',
    ].join('\n'))).toEqual([]);
  });

  it('finds in the sources exactly the notices still listed as English', () => {
    const found = SOURCES.flatMap((f) => fixedNotices(f, readFileSync(join(ROOT, f), 'utf8')));
    expect(found).toEqual([...STILL_ENGLISH]);
  });
});
