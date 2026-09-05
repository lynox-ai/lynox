/**
 * Escalation mail channel — delivers a notification to ONE named person by
 * email, for the case where that person has no account on the instance.
 *
 * Why this is a second channel rather than a wider web-push: the existing
 * channel is a POINTER. It fires a notification saying "something needs you"
 * and deep-links into a chat thread, which is worth nothing to someone who
 * cannot log in. This channel has to CARRY the case.
 *
 * ── Why this is not a way around `mail_send` ──────────────────────────────
 *
 * `mail_send` is guarded three times over (`tools/mail-send.ts`: a
 * permission-guard block in autonomous mode, `requiresConfirmation`, and an
 * inline `promptUser` before the send). All three exist to stop one thing: a
 * MODEL-CHOSEN address receiving model-written text with no human in the loop.
 *
 * So the address here is not model-chosen. `allowedRecipients` is set by
 * whoever constructs the channel, `recipient` only SELECTS from that set, and
 * an address outside it is refused. That is the same shape the sibling channel
 * already has: web-push can only reach endpoints that enrolled themselves
 * through an HTTP route (`push-subscriptions.db`, written by
 * `http-api.ts:6617`), never an endpoint a run named. The model picks the
 * words; it does not pick who reads them.
 *
 * An empty list refuses everything. Nothing in this repo stores a responsible
 * person's address yet, so empty is the state on arrival — and refusing is the
 * honest form of that, because the alternative is a default address chosen by
 * whoever wired it up.
 *
 * ── What it deliberately does NOT do ──────────────────────────────────────
 *
 * It writes no answer path into the mail. Whether the recipient may reply by
 * mail at all is an open decision with a security and data-protection side to
 * it, and a channel that phrased "just reply to this" would settle that
 * question by shipping it.
 */

import type { NotificationChannel, NotificationMessage } from '../../core/notification-router.js';
import type { MailRegistry } from './tools/registry.js';
import { sendMail, parseAddressList } from './send-core.js';

export interface EscalationMailChannelOptions {
  registry: MailRegistry;
  /**
   * Addresses this channel may deliver to, set by the operator wiring it up.
   * Omitted or empty means the channel refuses every message — see the header.
   */
  allowedRecipients?: readonly string[] | undefined;
  /**
   * Account to send FROM. Omitted uses the registry default.
   *
   * There is no system sender in this codebase: every send resolves through
   * `resolveProvider`, which THROWS when no account is configured. An
   * escalation therefore borrows a configured mailbox, and the recipient sees
   * that mailbox as the sender.
   */
  account?: string | undefined;
}

export class EscalationMailChannel implements NotificationChannel {
  readonly name = 'escalation-mail';
  private readonly registry: MailRegistry;
  private readonly allowed: ReadonlySet<string>;
  private readonly account: string | undefined;

  constructor(opts: EscalationMailChannelOptions) {
    this.registry = opts.registry;
    this.allowed = new Set((opts.allowedRecipients ?? []).map(normaliseAddress));
    this.account = opts.account;
  }

  /**
   * Three outcomes, and the difference between the first two is why this
   * returns what it returns.
   *
   * `notify()` fans a message out to EVERY registered channel, so the ordinary
   * case here is a message that was never meant for this channel — an inbox
   * summary, a nightly technical error. That is not a failure, and reporting it
   * as one would put a `channel returned false` line in stderr on every push
   * until nobody reads them. It returns true: handled, nothing to do.
   *
   * A message that IS addressed but names an address outside the allowlist is
   * the opposite — it is the case the allowlist exists for, so it is reported.
   */
  async send(msg: NotificationMessage): Promise<boolean> {
    const raw = msg.recipient?.trim();
    if (!raw) return true;

    // Parse rather than trust. A bare `{ address: raw }` skips `parseAddress`
    // and hands the string to nodemailer, where "a@b.example, evil@x.example"
    // becomes a single mailbox at the ATTACKER's domain and a bare "chef"
    // becomes a local user on the relay. Silent misdelivery is worse than a
    // refusal, so anything that is not exactly one address is refused.
    const parsed = parseAddressList(raw);
    if (parsed.length !== 1) {
      process.stderr.write(`[escalation-mail] refusing: not exactly one address\n`);
      return false;
    }
    const address = parsed[0]!.address;
    if (!this.allowed.has(normaliseAddress(address))) {
      process.stderr.write(`[escalation-mail] refusing: recipient not in the allowlist\n`);
      return false;
    }

    try {
      const result = await sendMail(this.registry, {
        ...(this.account === undefined ? {} : { account: this.account }),
        to: [{ address }],
        subject: msg.title,
        body: formatEscalationBody(msg),
      });
      if (!result.ok) {
        process.stderr.write(`[escalation-mail] send failed (${result.status}): ${result.message}\n`);
        return false;
      }
      return true;
    } catch (err: unknown) {
      // `resolveProvider` throws a MailError when no account is configured,
      // which is the normal state of an instance without mail set up. Without
      // this the documented boolean contract would be a lie on that path.
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[escalation-mail] send threw: ${detail}\n`);
      return false;
    }
  }
}

function normaliseAddress(a: string): string {
  return a.trim().toLowerCase();
}

/**
 * Renders the case into the mail body. Exported for unit testing.
 *
 * This is the first reader `NotificationMessage.inquiry` has ever had: the
 * field has been written in exactly one place and read nowhere, so a pending
 * question has so far reached the wire only as prose inside `body`.
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
