/**
 * Escalation mail channel — delivers a notification to ONE named person by
 * email, for the case where that person has no account on the instance.
 *
 * Why this is a second channel rather than a wider web-push: the existing
 * channel is a POINTER. It fires a notification that says "something needs
 * you" and deep-links into a chat thread, which is worth nothing to someone
 * who cannot log in. This channel has to CARRY the case.
 *
 * ── What it deliberately does NOT do ──────────────────────────────────────
 *
 * It does not write an answer path into the mail. Whether the recipient may
 * reply by mail at all is an open product decision with a security and data
 * protection side to it, and a channel that phrases "just reply to this" would
 * settle that question by shipping it. The caller owns `body`; this channel
 * adds the pending question and its options, nothing else.
 *
 * It also does not resolve WHO the recipient is. `msg.recipient` arrives from
 * outside and its origin is unsettled — today nothing in this repo stores a
 * responsible person's address. Guessing a default here would turn a missing
 * field into a silently wrong delivery.
 */

import type { NotificationChannel, NotificationMessage } from '../../core/notification-router.js';
import type { MailRegistry } from './tools/registry.js';
import { sendMail } from './send-core.js';

export interface EscalationMailChannelOptions {
  registry: MailRegistry;
  /**
   * Account to send FROM. Omitted uses the registry default.
   *
   * There is no system sender in this codebase: every send resolves through
   * `resolveProvider`, which throws when no account is configured. An
   * escalation therefore BORROWS a configured mailbox, and the recipient sees
   * that mailbox as the sender. That is a property of the current design, not
   * a decision taken here.
   */
  account?: string | undefined;
}

export class EscalationMailChannel implements NotificationChannel {
  readonly name = 'escalation-mail';
  private readonly registry: MailRegistry;
  private readonly account: string | undefined;

  constructor(opts: EscalationMailChannelOptions) {
    this.registry = opts.registry;
    this.account = opts.account;
  }

  /**
   * Refuses anything not addressed to a person.
   *
   * `NotificationRouter.notify()` fans a message out to EVERY registered
   * channel, so without this guard the first unrelated notification — an inbox
   * summary, a nightly technical error — would be mailed to whoever was last
   * escalated to. Refusing (rather than falling back to some default address)
   * is the direction that fails safely: a missing escalation is visible in the
   * router's stderr line, a wrongly delivered one is not visible at all.
   */
  async send(msg: NotificationMessage): Promise<boolean> {
    const to = msg.recipient?.trim();
    if (!to) return false;

    // Rate limiting is NOT skipped. The scheduled-send poller skips it because
    // it drains a queue the user filled; an escalation is model-triggered, so
    // the limiter is the only thing standing between a looping run and a
    // mailbox. A dropped mail does not lose the case — the run stays parked on
    // its prompt row either way — it only means nobody was told, which is why
    // the failure is reported rather than swallowed.
    const result = await sendMail(this.registry, {
      ...(this.account === undefined ? {} : { account: this.account }),
      to: [{ address: to }],
      subject: msg.title,
      body: formatEscalationBody(msg),
    });

    if (!result.ok) {
      process.stderr.write(
        `[escalation-mail] send failed (${result.status}): ${result.message}\n`,
      );
      return false;
    }
    return true;
  }
}

/**
 * Renders the case into the mail body.
 *
 * This is the first reader `NotificationMessage.inquiry` has ever had: the
 * field has been written in exactly one place and read nowhere, so a pending
 * question has so far reached the wire only as prose inside `body`. Carrying
 * the structured question and its options is the whole point of a channel that
 * has to work for someone who cannot open the thread.
 */
export function formatEscalationBody(msg: NotificationMessage): string {
  const parts: string[] = [msg.body];
  const inquiry = msg.inquiry;
  if (inquiry) {
    parts.push('', inquiry.question);
    const options = inquiry.options;
    if (options && options.length > 0) {
      parts.push('', ...options.map((o) => `- ${o}`));
    }
  }
  return parts.join('\n');
}
