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
 * ⚠ What this does NOT cover, stated because it is easy to read the paragraph
 * above as covering it: only the ADDRESS half. The subject and body are still
 * model-written and unconfirmed — the guards also exist against that, and an
 * allowlist does not answer it. Two consequences worth knowing before wiring
 * this up. `prompts.ts` tells the model it reaches the operator through
 * "exactly these surfaces and no others" and that email goes out "only via the
 * `mail_send` tool, and only after the user has confirmed it". That sentence
 * is still TRUE while this channel is registered nowhere — it stops being true
 * at the registration, not at the build, and the prompt line belongs in the
 * same change as the registration, because a rule the model has learnt and
 * that no longer holds is worse than a missing one. And a model that knows an
 * escalation is mailed can address the outside world through its wording: the
 * allowlist bounds WHERE, not WHAT. Neither is settled here.
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
  /** normalised form → the entry as the operator wrote it. */
  private readonly allowed: ReadonlyMap<string, string>;
  private readonly account: string | undefined;

  constructor(opts: EscalationMailChannelOptions) {
    this.registry = opts.registry;
    const allowed = new Map<string, string>();
    const configured = opts.allowedRecipients ?? [];
    let dropped = 0;
    for (const entry of configured) {
      // Parse the ENTRIES too, so `Chef <chef@betrieb.example>` in the config
      // matches a plain `chef@betrieb.example` in a message.
      //
      // One entry means one address, the same rule `send()` applies to the
      // message. An entry holding two would otherwise expand silently into two
      // permitted recipients while the identical string is refused on the way
      // in — one direction of the same config being stricter than the other.
      const parsed = parseAddressList(entry);
      if (parsed.length !== 1) {
        dropped += 1;
        continue;
      }
      allowed.set(normaliseAddress(parsed[0]!.address), parsed[0]!.address);
    }
    // Report DROPPED entries, not just an empty result. An entry that parses to
    // nothing is invisible otherwise: every send it should have permitted is
    // refused with "not in the allowlist", which reads like a rejected
    // recipient rather than a line of config that never took effect. Counting
    // only the empty case would leave the partial one silent — and a partly
    // unusable list is the likelier one, because a single good entry makes the
    // channel look like it works. (Same shape as the present-but-unreadable
    // file list in the public-repo guard: an unusable input and an empty result
    // must not look alike.)
    if (dropped > 0) {
      process.stderr.write(
        `[escalation-mail] ${String(dropped)} of ${String(configured.length)} configured recipient(s) unusable and ignored\n`,
      );
    }
    this.allowed = allowed;
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
   *
   * The `true` for an unaddressed message means HANDLED, not delivered, and
   * that distinction leaves this class: `NotificationRouter.sendTo()` returns
   * this boolean to its caller unchanged, and at least one caller throttles on
   * it (`integrations/inbox/notifier.ts`). Anyone reaching this channel through
   * `sendTo` rather than `notify` is asking a different question than the one
   * answered here.
   */
  async send(msg: NotificationMessage): Promise<boolean> {
    const raw = msg.recipient;
    if (raw === undefined) return true;

    // Parse rather than trust: a bare `{ address: raw }` would hand the whole
    // string to the provider, and a comma-separated or bare-word value is not
    // an address in the sense this check assumes. Anything that is not exactly
    // one address is refused, because silent misdelivery is worse than a
    // refusal. (An empty string lands here rather than in the `undefined`
    // branch above: it is a FAILED attempt to address, not an absent one, and
    // reporting it as handled would hide a broken caller.)
    const parsed = parseAddressList(raw);
    if (parsed.length !== 1) {
      process.stderr.write(`[escalation-mail] refusing: not exactly one address\n`);
      return false;
    }
    // Look the entry up and send THE ENTRY, never the message's own string.
    // Checking one value and sending another is the gap this closes: a string
    // that merely case-folds onto an entry would pass the check and be
    // delivered as typed, and for a domain that is a different IDNA label.
    // Now the delivered value always comes from the operator's list, so the
    // message can only SELECT a recipient — it can never supply one.
    const entry = this.allowed.get(normaliseAddress(parsed[0]!.address));
    if (entry === undefined) {
      process.stderr.write(`[escalation-mail] refusing: recipient not in the allowlist\n`);
      return false;
    }
    const address = entry;

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
