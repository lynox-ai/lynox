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
 */
import { setTimeout as delay } from 'node:timers/promises';
import {
  BULK_HOST_BUDGET, beforeOverFields,
  type BulkHostBudget, type ExternalClient, type ExternalRead,
} from './bulk-external.js';
import {
  BULK_HALT_REASONS, BULK_TARGET_BUDGET_MS, externalHostOf,
  type BulkHaltReason, type BulkInvalidReason, type BulkLedger, type BulkRunForPreview,
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
  /** The client for the run's host, or null when the run cannot reach it. */
  clientFor: (run: BulkRunForPreview) => ExternalClient | null;
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
    case 'secret': return BULK_HALT_REASONS.secret;
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
  const client = deps.clientFor(run);
  if (!client) return halt(BULK_HALT_REASONS.unavailable);

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
      ledger.recordRead(runId, seq, beforeOverFields(read.value, target.after));
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
  if (!ledger.finishPreview(runId)) {
    return { status: 'halted', summary: summarize(ledger, runId, 'Bulk preview stopped: the run was dropped, halted or moved on.') };
  }
  return { status: 'done', summary: costed(summarize(ledger, runId, 'Bulk preview done — the run is ready for review.')) };

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
