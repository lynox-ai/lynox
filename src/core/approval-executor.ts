/**
 * The approval queue's executor (PRD unattended-approval-queue §4.8): it sends a mail the owner
 * approved, exactly as it was filed, without a model and outside any run.
 *
 * One tick sends at most one entry:
 * 1. the send limit: the hourly and daily caps over the tool calls plus the queue's own sends,
 *    counted in the claim's transaction; over a cap the entry stays `approved` with the hold
 *    `send_limit` and is tried again on a later tick;
 * 2. the claim `approved → executing`, then the checksum recomputed over the stored payload;
 * 3. the mandate that filed it still live (a `mandate:` filer without a mandate id counts as
 *    ended), the account still configured and able to send, and its sending address still the
 *    one filed;
 * 4. for `mail_reply` the recipient dedup window, which its shared commit does not check; then
 *    the send through the same commit the tools use;
 * 5. the outcome, a row in the outward trail and a line in the run's thread.
 *
 * What it does not check again is what the filing judged and the checksum fixes: the secret
 * scan, the auto-reply header, the recipient parsing and the tool's own rate check. Every path
 * that cannot prove the mail was not sent ends `unknown`, which is never tried again (I4); only
 * a provably-not-sent failure is retried, and a failure that would repeat ends `failed`.
 */

import type { AuditLog } from './audit-log.js';
import { newCorrelationId } from './audit-log.js';
import { APPROVAL_CLAIM_STALE_MS, APPROVAL_RETRY_DELAY_MS, type ApprovalEntry, type ApprovalKind, type ApprovalStatus, type ApprovalStore, type FinishOutcome } from './approval-store.js';
import { principalOfPrompt } from './prompt-store.js';
import { isOwnerPrincipal, principalHasEnded, type RequestPrincipal } from './request-principal.js';
import { buildDisplayNoteContent } from './render-projection.js';
import type { ThreadStore } from './thread-store.js';
import type { MailContext } from '../integrations/mail/context.js';
import type { MailAddress } from '../integrations/mail/provider.js';
import { checkSendAccount, resolveSendingAddress, sendMail, type SendCoreFailureStatus } from '../integrations/mail/send-core.js';
import { commitReply } from '../integrations/mail/tools/mail-reply.js';
import { checkRecipientDedup, mailDedupWindowMs, mailSendLimitAdmits } from '../integrations/mail/tools/rate-limit.js';
import { getErrorMessage } from './utils.js';

/** How many approved entries one tick looks at to find one it may send. */
const CANDIDATES_PER_TICK = 200;

/**
 * How long one entry may take from its claim until it is settled: below the sweep's stale-claim
 * limit ({@link APPROVAL_CLAIM_STALE_MS}), so the sweep never decides about an entry the executor
 * still works on. Past it, an entry whose send had not begun is settled for another attempt, and
 * the send is barred from beginning later; one whose send had begun ends `unknown`, because the
 * mail may still arrive, and is never tried again.
 */
export const APPROVAL_SEND_DEADLINE_MS = APPROVAL_CLAIM_STALE_MS - 5 * 60_000;

/** Whether the deadline of one entry has passed, and whether its send had begun by then. */
interface Attempt {
  deadlinePassed: boolean;
  sending: boolean;
}

export interface ApprovalExecutorDeps {
  store: ApprovalStore;
  /** The engine's mail context, or null when mail is not set up. */
  mail: () => MailContext | null;
  /** The outward trail, or null when this instance keeps none. */
  audit: () => AuditLog | null;
  threads: () => ThreadStore | null;
  isMandateLive: (mandateId: string) => boolean;
  now?: (() => number) | undefined;
}

/** What one tick did: nothing to do, or the entry it settled and the status it left. */
export type TickResult = null | { id: string; status: ApprovalStatus };

type Settled = { outcome: FinishOutcome; result: Record<string, unknown> };

/** A send failure that proves nothing went out and would not change on its own. */
const FAILS_FOR_GOOD: ReadonlySet<SendCoreFailureStatus> = new Set<SendCoreFailureStatus>([
  'invalid_recipients', 'receive_only', 'account_not_configured', 'secret_in_body', 'cancelled', 'queued', 'rate_limit',
]);

export class ApprovalExecutor {
  private readonly now: () => number;
  private running = false;

  constructor(private readonly deps: ApprovalExecutorDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Send at most one approved entry. A tick that starts while the last one runs does nothing. */
  async tick(): Promise<TickResult> {
    if (this.running) return null;
    this.running = true;
    try {
      return await this.tickOnce();
    } finally {
      this.running = false;
    }
  }

  private async tickOnce(): Promise<TickResult> {
    const { store } = this.deps;
    const now = this.now();
    // A retry waits out the recipient dedup window as configured, or the same window refuses it again.
    const retryDelay = Math.max(APPROVAL_RETRY_DELAY_MS, mailDedupWindowMs());
    // Entries are tried in the order they were approved. Once the send limit holds a kind, the
    // rest of that kind waits too, stamped so the claim window does not expire it, and the tick
    // goes on with the other kind: a full limit for one kind does not hold up the other.
    const heldKinds = new Set<ApprovalKind>();
    for (const { id, kind } of store.executable(now, CANDIDATES_PER_TICK, retryDelay)) {
      if (heldKinds.has(kind)) continue;
      const claim = store.claim(id, now, { admits: (sent) => mailSendLimitAdmits(kind, sent) });
      if (!claim.ok) {
        if (claim.reason === 'held') {
          heldKinds.add(kind);
          store.holdKind(kind, now);
        }
        continue;
      }
      const entry = claim.entry;
      const principal = principalOfPrompt({ created_by: entry.createdBy, mandate_id: entry.mandateId });
      const settled = await this.withinDeadline(entry, principal);
      // Null when the entry was no longer `executing`: then what it is now is what it ended as.
      const status = store.finish(id, settled.outcome, settled.result, this.now()) ?? store.get(id)?.status ?? 'unknown';
      if (status !== 'approved') this.noteInThread(entry, status);
      return { id, status };
    }
    return null;
  }

  /** {@link execute} bounded by {@link APPROVAL_SEND_DEADLINE_MS}, counted from the claim. */
  private withinDeadline(entry: ApprovalEntry, principal: RequestPrincipal): Promise<Settled> {
    const attempt: Attempt = { deadlinePassed: false, sending: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<Settled>((resolve) => {
      timer = setTimeout(() => {
        attempt.deadlinePassed = true;
        resolve(attempt.sending
          ? { outcome: 'unknown', result: { reason: 'send_timeout' } }
          : { outcome: 'retry', result: { reason: 'deadline_before_send' } });
      }, APPROVAL_SEND_DEADLINE_MS);
      timer.unref?.();
    });
    return Promise.race([this.execute(entry, principal, attempt), deadline]).finally(() => clearTimeout(timer));
  }

  private async execute(entry: ApprovalEntry, principal: RequestPrincipal, attempt: Attempt): Promise<Settled> {
    const notSent = (reason: string): Settled => ({ outcome: 'failed', result: { reason } });
    const retry = (reason: string): Settled => ({ outcome: 'retry', result: { reason } });
    const filing = entry.filing;
    if (filing === null || entry.origin === null) return notSent('not_executable');
    if (!this.deps.store.checksumMatches(entry.id)) return notSent('checksum');
    if (principalHasEnded(principal, this.deps.isMandateLive)) return notSent('mandate_ended');

    const mail = this.deps.mail();
    if (mail === null) return retry('mail_unavailable');
    const { accountId, fromAddress } = filing.payload;
    const verdict = checkSendAccount(mail, accountId);
    if (!verdict.ok) return notSent(verdict.status);
    const provider = mail.registry.get(accountId);
    if (provider === null) return notSent('account_not_configured');
    let sendingAddress: string;
    try {
      sendingAddress = await resolveSendingAddress(provider);
    } catch {
      return retry('sending_address_unavailable');
    }
    if (sendingAddress.trim().toLowerCase() !== fromAddress.trim().toLowerCase()) return notSent('account_changed');

    const to = filing.payload.to.map(toMailAddress);
    const cc = filing.payload.cc.map(toMailAddress);
    if (filing.kind === 'mail_reply' && checkRecipientDedup([...to, ...cc], filing.payload.subject) !== null) {
      return retry('dedup_window');
    }

    const recipients = new Set([...to, ...cc, ...(filing.kind === 'mail_send' ? filing.payload.bcc.map(toMailAddress) : [])]
      .map(a => a.address.trim().toLowerCase())).size;
    // From this check to the start of the send nothing awaits, so a deadline cannot pass between
    // them: either the send is barred, or it is marked as begun before the deadline can see it.
    if (attempt.deadlinePassed) return retry('deadline_before_send');
    const trail = this.beginTrail(entry, principal, recipients);
    if (trail === 'refused') return retry('trail_unavailable');
    attempt.sending = true;

    let settled: Settled;
    try {
      if (filing.kind === 'mail_reply') {
        const p = filing.payload;
        await commitReply(provider, {
          to, cc, subject: p.subject, body: p.bodyText, inReplyTo: p.inReplyTo, references: p.references,
          originalThreadKey: p.originalThreadKey,
        }, mail);
        settled = { outcome: 'done', result: {} };
      } else {
        const p = filing.payload;
        const res = await sendMail(mail.registry, {
          account: accountId, to, cc, bcc: p.bcc.map(toMailAddress), subject: p.subject, body: p.bodyText,
        }, { skipRateLimit: true, ...(p.trackFollowup !== null ? { trackFollowup: p.trackFollowup } : {}) }, mail);
        if (res.ok) settled = { outcome: 'done', result: { messageId: res.result.messageId } };
        else if (res.status === 'dedup_window') settled = retry('dedup_window');
        else if (FAILS_FOR_GOOD.has(res.status)) settled = notSent(res.status);
        else settled = { outcome: 'unknown', result: { reason: res.status, message: res.message } };
      }
    } catch (err) {
      // The provider may have accepted the mail before it failed: never tried again.
      settled = { outcome: 'unknown', result: { reason: 'send_threw', message: getErrorMessage(err) } };
    }
    this.endTrail(trail, settled.outcome);
    return settled;
  }

  /**
   * The `attempt` row before the send. `refused` when the row could not be written: the mail is
   * then not sent, as an agent's write is not. Without a trail, a mail the owner's own run filed
   * goes out without a row, as the owner's own writes do today; one a mandate's run filed does
   * not go out, as a mandate's write without a trail does not (`agent.ts`, `_beginOutwardTrail`).
   */
  private beginTrail(entry: ApprovalEntry, principal: RequestPrincipal, recipients: number):
    null | 'refused' | { log: AuditLog; principal: RequestPrincipal; action: string; target: string; correlationId: string; runId: string | undefined } {
    const log = this.deps.audit();
    if (log === null) return isOwnerPrincipal(principal) ? null : 'refused';
    const row = {
      log,
      principal,
      action: entry.kind === 'mail_reply' ? 'mail_reply:reply' : 'mail_send:send',
      target: `approval ${entry.id}: ${entry.kind}, ${String(recipients)} recipient${recipients === 1 ? '' : 's'}, approved by ${entry.decidedBy ?? 'unknown'}`,
      correlationId: newCorrelationId(),
      runId: entry.origin?.runId,
    };
    try {
      log.record({ principal, action: row.action, target: row.target, phase: 'attempt', correlationId: row.correlationId, runId: row.runId });
    } catch {
      return 'refused';
    }
    return row;
  }

  private endTrail(trail: ReturnType<ApprovalExecutor['beginTrail']>, outcome: FinishOutcome): void {
    if (trail === null || trail === 'refused') return;
    try {
      trail.log.record({
        principal: trail.principal, action: trail.action, target: trail.target,
        phase: outcome === 'done' ? 'done' : 'failed', correlationId: trail.correlationId, runId: trail.runId,
      });
    } catch { /* the mail's outcome is settled; a missing end row does not change it */ }
  }

  /** A display-only line in the thread the run belonged to; the model never reads it. */
  private noteInThread(entry: ApprovalEntry, status: ApprovalStatus): void {
    const threadId = entry.origin?.threadId;
    const threads = this.deps.threads();
    if (threadId === undefined || threads === null) return;
    const code = status === 'done' ? 'approval_sent' : status === 'unknown' ? 'approval_unknown' : 'approval_failed';
    try {
      if (threads.getThread(threadId) === undefined) return;
      const count = threads.getMessageCount(threadId);
      threads.appendDisplayNotes(threadId, [{ role: 'assistant', content: buildDisplayNoteContent(code) }], threads.getNextSeq(threadId));
      threads.updateThread(threadId, { message_count: count + 1 });
    } catch { /* the note is a courtesy; the entry's status is the record */ }
  }
}

function toMailAddress(a: { name?: string | undefined; address: string }): MailAddress {
  return a.name !== undefined ? { name: a.name, address: a.address } : { address: a.address };
}
