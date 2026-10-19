/**
 * The dry run of an external bulk run as a worker effect, `bulk_preview` (build plan B
 * §3): read each target of a `planned` run with one GET and record its before-image
 * over F, then move the run to `previewed` for the owner to review. Deterministic, no
 * model run. Its trigger is armed only by the owner's start or resume
 * (`BulkLedger.resumePreview`) — never by the plan, never by a task path.
 *
 * It writes only the ledger. What bounds it is the engine's host budget, consumed
 * before every request; the profile's own rate limit and a host's 429 are waited out,
 * never pushed through.
 *
 * A run whose targets come from a list (PRD bulk-loop §3.2) is read in two parts, each
 * started by the owner: first the list, page by page from where the last tick stopped, until
 * a short page ends it — then the run halts so the owner sees how many targets it holds;
 * then, once started again, each target as above, checked to be the element that was listed.
 */
import { setTimeout as delay } from 'node:timers/promises';
import {
  BULK_HOST_BUDGET, beforeOverFields, mintBulkContract,
  type BulkHostBudget, type ExternalClient, type ExternalRead,
} from './bulk-external.js';
import {
  BULK_LIST_FORMS, isOfferedListSource, isSameListItem, listItemKey, listPageCap, listPageElements, listPageUrl, listQueryParams, maxListPages,
} from './bulk-list.js';
import type { ListQueryConstraints } from '../tools/permission-guard.js';
import {
  BULK_HALT_REASONS, BULK_TARGET_BUDGET_MS, externalHostOf,
  type BulkHaltReason, type BulkInvalidReason, type BulkLedger, type BulkListRun, type BulkRunForPreview,
} from './bulk-ledger.js';

export interface BulkPreviewOutcome {
  /** `pending`: the preview waits (budget, rate limit, a 429, a stopped tick) and is
   *  due again at `retryAt`. */
  status: 'done' | 'halted' | 'refused' | 'pending';
  /** Engine-authored, counts only. Recorded as the trigger's run result. */
  summary: string;
  retryAt?: number | undefined;
}

export interface BulkPreviewDeps {
  ledger: BulkLedger;
  /** The client for the run's host, or null when the run cannot reach it. `listQuery` is
   *  given while the run's list is read: the query its pages may carry under the read
   *  contract (`withListQuery`). */
  clientFor: (run: BulkRunForPreview, listQuery?: ListQueryConstraints) => ExternalClient | null;
  budget?: BulkHostBudget | undefined;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
  /** The worker's task signal: a stopped tick ends the loop between targets (§6 Q7). */
  signal?: AbortSignal | undefined;
  /** The host profile's price per call, when it has a per-call cost model. There is no
   *  chat to show an `api_cost` event in, so the tick's result states what it spent. */
  costPerCallUsd?: number | undefined;
}

/** A wait this short is slept through; a longer one ends the tick as `pending`. */
const SLEEP_MAX_MS = 1_000;
/** A 429 is waited out once per target within a tick; a second one ends the tick. */
const MAX_429_PER_TARGET = 1;
/** Floor of a tick's time budget, whatever the run's size. */
const MIN_PREVIEW_BUDGET_MS = 60_000;
const HALT_CONSECUTIVE = 3;
/** When the budget or a rate limit gives no time of its own. */
const DEFAULT_RETRY_MS = 30_000;

const defaultSleep = async (ms: number, signal: AbortSignal | undefined): Promise<void> => {
  await delay(ms, undefined, signal ? { signal } : undefined).catch(() => {});
};

function summarize(ledger: BulkLedger, runId: string, lead: string): string {
  const s = ledger.getStatus(runId);
  if (!s) return lead;
  return `${lead} Read ${String(s.total - s.changes.invalid - s.unread)}, invalid ${String(s.changes.invalid)}, ` +
    `unread ${String(s.unread)} of ${String(s.total)} targets.`;
}

/** The fixed reason a read makes a target unplannable, or null when it does not. */
function invalidFor(read: ExternalRead): BulkInvalidReason | null {
  switch (read.kind) {
    case 'not_found': return 'not_found';
    case 'redirect': return 'redirect';
    case 'too_large': return 'target_too_large';
    case 'not_json': return 'not_json';
    // A 4xx answers for the target. A 5xx or a network error may be the host's: the
    // first leaves the target unread for a later tick (`BulkLedger.recordReadFailure`).
    case 'refused': return 'read_failed';
    // The address carries what looks like a secret: a property of the target, the same on
    // every read, so the target is unplannable rather than the run stopped.
    case 'secret': return 'secret_in_target';
    default: return null;
  }
}

/** The halt a read forces on the whole run, or null. Nothing past it would be sent
 *  any differently, so the first one stops the run instead of collecting N of them. */
function haltFor(read: ExternalRead): BulkHaltReason | null {
  switch (read.kind) {
    case 'no_credential': return BULK_HALT_REASONS.credential;
    case 'unauthorized': return BULK_HALT_REASONS.unauthorized;
    case 'blocked': return BULK_HALT_REASONS.blocked;
    case 'not_granted': return BULK_HALT_REASONS.contract;
    case 'unrecorded': return BULK_HALT_REASONS.unrecorded;
    default: return null;
  }
}

/**
 * Run the preview for one bulk run. Refuses unless the run is an external apply run in
 * `planned` and not halted (plan §6 Q2(a)) — checked again before every target, so a run
 * dropped, halted or moved on in between is not read further.
 */
export async function runBulkPreview(runId: string, deps: BulkPreviewDeps): Promise<BulkPreviewOutcome> {
  const { ledger } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const budget = deps.budget ?? BULK_HOST_BUDGET;
  const run = ledger.getRunForPreview(runId);
  if (!run) return { status: 'refused', summary: 'No bulk run with this id.' };
  const host = externalHostOf(run.targetSystem);
  if (host === null || run.kind !== 'apply') return { status: 'refused', summary: 'The bulk run has no external targets to read.' };
  if (run.phase !== 'planned' || run.haltReason !== null) {
    return { status: 'refused', summary: summarize(ledger, runId, `Bulk run is ${run.phase}${run.haltReason !== null ? ' and halted' : ''} — nothing read.`) };
  }
  const list = ledger.getListRun(runId);
  // A run planned from a list form that has since been narrowed is stopped, not read: neither
  // its list nor, once listed, its targets. Halted rather than skipped, so it frees its slot
  // and says why. Before the client is built: building it reads the list's form, and a form
  // that is no longer offered has no spec to read.
  if (list !== null && !isOfferedListSource(list.source)) {
    ledger.halt(runId, BULK_HALT_REASONS.listFormWithdrawn);
    return { status: 'halted', summary: summarize(ledger, runId, `Bulk preview halted: ${BULK_HALT_REASONS.listFormWithdrawn}.`) };
  }
  const client = deps.clientFor(run, list?.state === 'pending' ? listQueryParams(list.source) : undefined);
  if (!client) return halt(BULK_HALT_REASONS.unavailable);
  if (list?.state === 'pending') return await readList(list, client);

  const unread = ledger.listUnread(runId);
  const deadline = now() + Math.max(MIN_PREVIEW_BUDGET_MS, unread.length * BULK_TARGET_BUDGET_MS);
  let consecutive = 0;

  for (const seq of unread) {
    if (deps.signal?.aborted) return pending(now() + DEFAULT_RETRY_MS, 'Bulk preview paused.');
    const current = ledger.getRunForPreview(runId);
    if (!current || current.phase !== 'planned' || current.haltReason !== null) {
      return { status: 'halted', summary: summarize(ledger, runId, 'Bulk preview stopped: the run was dropped, halted or moved on.') };
    }
    if (now() > deadline) return halt(BULK_HALT_REASONS.timeBudget);
    const target = ledger.loadExternalTarget(runId, seq);
    if (!target) continue;

    // Every request made for this target, a retry after a 429 included, carries the credential
    // its before-image is read under.
    const carried = client.track();
    let read: ExternalRead | null = null;
    for (let tooMany = 0; read === null;) {
      const wait = budget.take(host, now());
      if (wait > 0) {
        if (wait > SLEEP_MAX_MS) return pending(now() + wait, 'Bulk preview waiting for the host budget.');
        await sleep(wait, deps.signal);
        if (deps.signal?.aborted) return pending(now() + DEFAULT_RETRY_MS, 'Bulk preview paused.');
        continue;
      }
      const got = await client.get(target.key, deps.signal);
      if (got.kind === 'rate_limited') return pending(now() + DEFAULT_RETRY_MS, 'Bulk preview waiting for the API rate limit.');
      if (got.kind === 'retry_after') {
        if (tooMany >= MAX_429_PER_TARGET || got.ms > SLEEP_MAX_MS) return pending(now() + got.ms, 'Bulk preview waiting: the host asked to slow down.');
        tooMany++;
        await sleep(got.ms, deps.signal);
        if (deps.signal?.aborted) return pending(now() + DEFAULT_RETRY_MS, 'Bulk preview paused.');
        continue;
      }
      read = got;
    }
    // A request cut short by the stopped tick is not an answer about the target.
    if (read.kind === 'failed' && deps.signal?.aborted) return pending(now() + DEFAULT_RETRY_MS, 'Bulk preview paused.');

    const stop = haltFor(read);
    if (stop !== null) return halt(stop);
    if (read.kind === 'ok') {
      // A listed target must still be the element that was listed: the same id in the same
      // field. Read under its address, anything else is not what the owner reviewed.
      const listedId = list === null ? null : target.key.slice(target.key.lastIndexOf('/') + 1);
      if (list !== null && !isSameListItem(read.value, list.source.idField, listedId!)) {
        ledger.recordRead(runId, seq, { invalid: 'list_item_mismatch' });
        consecutive = 0;
        continue;
      }
      ledger.recordRead(runId, seq, beforeOverFields(read.value, target.after), carried());
      consecutive = 0;
      continue;
    }
    if (read.kind === 'failed') {
      // A first failure leaves the target unread and last in line; a second one, on any
      // later tick, makes it invalid — so a target that always fails cannot keep the run
      // from finishing.
      ledger.recordReadFailure(runId, seq);
      // A host failing three reads in a row is down, not three bad targets.
      if (++consecutive >= HALT_CONSECUTIVE) return halt(BULK_HALT_REASONS.consecutiveFailures);
      continue;
    }
    consecutive = 0;
    const invalid = invalidFor(read);
    if (invalid !== null) ledger.recordRead(runId, seq, { invalid });
  }

  if (ledger.listUnread(runId).length > 0) return pending(now() + DEFAULT_RETRY_MS, 'Bulk preview has targets left to read.');
  // A judged run is read for its judge, which goes on in the same effect (`bulk-judge.ts`): its
  // targets have no after-state yet, so reading them does not make it previewed.
  if (ledger.getJudgeRun(runId) !== null) {
    return { status: 'done', summary: costed(summarize(ledger, runId, 'Bulk read done — the targets are to be judged next.')) };
  }
  if (!ledger.finishPreview(runId)) {
    return { status: 'halted', summary: summarize(ledger, runId, 'Bulk preview stopped: the run was dropped, halted or moved on.') };
  }
  return { status: 'done', summary: costed(summarize(ledger, runId, 'Bulk preview done — the run is ready for review.')) };

  /**
   * Read the run's list, page by page from the one after the last recorded, until a short
   * page ends it. Every outcome of a page maps to a fixed reason — nothing the provider sent
   * reaches the summary, which the model can read through `task_list`.
   */
  async function readList(listRun: BulkListRun, listClient: ExternalClient): Promise<BulkPreviewOutcome> {
    const { source } = listRun;
    const perPage = BULK_LIST_FORMS[source.form].perPage;
    const maxPages = maxListPages(source.form);
    // Each page may be tried a few times (a 5xx, a 429), never without bound.
    const maxCalls = maxPages * 3;
    const listDeadline = now() + Math.max(MIN_PREVIEW_BUDGET_MS, (maxPages - listRun.page) * BULK_TARGET_BUDGET_MS);
    let failures = 0;
    for (;;) {
      if (deps.signal?.aborted) return pending(now() + DEFAULT_RETRY_MS, 'Bulk list read paused.');
      const current = ledger.getListRun(runId);
      if (!current || current.state !== 'pending' || current.phase !== 'planned' || current.haltReason !== null) {
        return { status: 'halted', summary: summarize(ledger, runId, 'Bulk list read stopped: the run was dropped, halted or moved on.') };
      }
      // The progress is kept page by page, so a tick that runs out of time goes on from here.
      if (now() > listDeadline) return pending(now() + DEFAULT_RETRY_MS, 'Bulk list read has pages left to read.');
      const next = current.page + 1;
      if (next > maxPages) return halt(BULK_HALT_REASONS.listTooLarge);
      const cap = listPageCap(current.bytes);
      if (cap === 0) return halt(BULK_HALT_REASONS.listTooLarge);

      let got: ExternalRead | null = null;
      for (let tooMany = 0; got === null;) {
        const wait = budget.take(host!, now());
        if (wait > 0) {
          if (wait > SLEEP_MAX_MS) return pending(now() + wait, 'Bulk list read waiting for the host budget.');
          await sleep(wait, deps.signal);
          if (deps.signal?.aborted) return pending(now() + DEFAULT_RETRY_MS, 'Bulk list read paused.');
          continue;
        }
        if (!ledger.takeListCall(runId, maxCalls)) {
          const still = ledger.getListRun(runId);
          return still?.state === 'pending' && still.phase === 'planned' && still.haltReason === null
            ? halt(BULK_HALT_REASONS.listTooLarge)
            : { status: 'halted', summary: summarize(ledger, runId, 'Bulk list read stopped: the run was dropped, halted or moved on.') };
        }
        const answer = await listClient.get(listPageUrl(host!, source, next), deps.signal, cap);
        if (answer.kind === 'rate_limited') {
          // Nothing was sent: the call is not one of the run's.
          ledger.returnListCall(runId);
          return pending(now() + DEFAULT_RETRY_MS, 'Bulk list read waiting for the API rate limit.');
        }
        if (answer.kind === 'retry_after') {
          if (tooMany >= MAX_429_PER_TARGET || answer.ms > SLEEP_MAX_MS) return pending(now() + answer.ms, 'Bulk list read waiting: the host asked to slow down.');
          tooMany++;
          await sleep(answer.ms, deps.signal);
          if (deps.signal?.aborted) return pending(now() + DEFAULT_RETRY_MS, 'Bulk list read paused.');
          continue;
        }
        got = answer;
      }
      if (got.kind === 'failed' && deps.signal?.aborted) return pending(now() + DEFAULT_RETRY_MS, 'Bulk list read paused.');
      const stop = haltFor(got);
      if (stop !== null) return halt(stop);
      if (got.kind === 'failed') {
        // The same page again: a host failing three times in a row is down.
        if (++failures >= HALT_CONSECUTIVE) return halt(BULK_HALT_REASONS.consecutiveFailures);
        continue;
      }
      if (got.kind === 'too_large') return halt(BULK_HALT_REASONS.listTooLarge);
      if (got.kind !== 'ok') return halt(BULK_HALT_REASONS.listUnreadable);
      failures = 0;
      const elements = listPageElements(got.value);
      if (elements === null) return halt(BULK_HALT_REASONS.listNotAList);
      const recorded = ledger.recordListPage(runId, {
        page: next, items: elements.map((e) => listItemKey(host!, source, e)), bytes: got.bytes ?? 0,
      });
      if (!recorded.ok) {
        if (recorded.reason === 'too_large') return halt(BULK_HALT_REASONS.listTooLarge);
        return { status: 'halted', summary: summarize(ledger, runId, 'Bulk list read stopped: the run was dropped, halted or moved on.') };
      }
      // A short page is the last one. A full page that adds nothing is a list that pages in
      // circles, or ignores the page asked for: it is not read to the page cap.
      if (elements.length < perPage) break;
      if (recorded.added === 0) return halt(BULK_HALT_REASONS.listNoProgress);
    }
    const closed = ledger.finishList(runId, (keys) => mintBulkContract(host!, keys, source.method));
    if (closed === 'moved') {
      return { status: 'halted', summary: summarize(ledger, runId, 'Bulk list read stopped: the run was dropped, halted or moved on.') };
    }
    return {
      status: 'done',
      summary: costed(summarize(ledger, runId, closed === 'empty'
        ? 'Bulk list read done — the list holds no target that could be planned.'
        : 'Bulk list read done — waiting for the owner to review the targets and start reading them.')),
    };
  }

  function halt(reason: BulkHaltReason): BulkPreviewOutcome {
    ledger.halt(runId, reason);
    return { status: 'halted', summary: costed(summarize(ledger, runId, `Bulk preview halted: ${reason}.`)) };
  }
  function pending(retryAt: number, lead: string): BulkPreviewOutcome {
    return { status: 'pending', summary: costed(summarize(ledger, runId, lead)), retryAt };
  }
  function costed(text: string): string {
    const n = client?.sent ?? 0;
    if (deps.costPerCallUsd === undefined || n === 0) return text;
    return `${text} ${String(n)} API calls this tick at $${String(deps.costPerCallUsd)} each ($${(n * deps.costPerCallUsd).toFixed(4)}).`;
  }
}
