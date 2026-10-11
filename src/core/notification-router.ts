/**
 * Notification router — best-effort delivery to registered channels.
 * Zero external dependencies.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The options of a question as they leave the box: without the `'\x00'` marker a prompt's
 * option list ends with to say "free text is allowed too". The marker is for the owner's own
 * dialog; a mail or a push that lists it shows an empty or garbled choice.
 */
export function inquiryOptions(options: string[] | undefined): string[] | undefined {
  const shown = options?.filter((o) => o !== '\x00');
  return shown && shown.length > 0 ? shown : undefined;
}

export interface NotificationMessage {
  title: string;
  body: string;
  taskId?: string | undefined;
  priority: 'low' | 'normal' | 'high';
  followUps?: Array<{ label: string; task: string }> | undefined;
  inquiry?: {
    question: string;
    options?: string[] | undefined;
  } | undefined;
  /**
   * Who this message is FOR, when it is for one named person rather than for
   * whoever is watching the instance. Channel-specific address form; the
   * escalation mail channel reads it as an email address.
   *
   * Deliberately its own field and NOT a key in `data`: `data` is passthrough
   * that web-push serialises straight into the browser payload, so an address
   * parked there would ship a person's email to every subscribed browser of
   * the instance. Addressing is not payload.
   *
   * Absent is the normal case and means "not addressed" — `notify()` fans out
   * to every channel, so a channel that delivers to a person must refuse a
   * message without this field rather than guess a default recipient.
   */
  recipient?: string | undefined;
  /**
   * Channel-specific passthrough data — e.g. the inbox notifier sets
   * `{ itemId: '<inbox-row-id>' }` so the service worker's
   * `notificationclick` handler can deep-link to the affected mail.
   * Keep keys flat-string for JSON serialisation across web-push.
   */
  data?: Record<string, string> | undefined;
}

/**
 * What one channel did with one message. Three values because two of them used to be one:
 * a channel that a message was not meant for (an unaddressed message reaching a channel that
 * delivers to a named person) answered `true`, the same as a channel that delivered it.
 * Anyone counting `true` as "someone was told" then counted a channel that told nobody.
 *
 * - `delivered` — the message left for at least one reader.
 * - `skipped` — the message was not for this channel; nothing to do, nothing wrong.
 * - `failed` — the message was for this channel and did not reach anyone, including the
 *   case of a channel with nobody to deliver to.
 */
export type ChannelOutcome = 'delivered' | 'skipped' | 'failed';

export interface NotificationChannel {
  readonly name: string;
  send(msg: NotificationMessage): Promise<ChannelOutcome>;
}

/** Per-channel outcome of one `notify()`, in registration order. Empty: no channel. */
export type NotifyReport = ReadonlyArray<{ readonly channel: string; readonly outcome: ChannelOutcome }>;

/**
 * Whether a `notify()` reached anyone: `delivered` iff at least one channel delivered,
 * `no_channel` when none was registered, `not_delivered` otherwise. A `skipped` channel
 * never counts — that is the reason `ChannelOutcome` has three values.
 */
export type DeliverySummary = 'delivered' | 'not_delivered' | 'no_channel';

/**
 * What a channel's `send` resolved to, read strictly. `NotificationChannel` is exported, and a
 * channel written against the earlier contract resolves to a boolean. Under that contract `true`
 * meant "handled" — delivered, or not for this channel (the escalation mail channel answered
 * `true` for an unaddressed message) — so it is read as `skipped`: still handled for `sendTo`,
 * as before, and never counted as someone told. Reading it as `delivered` would let such a
 * channel make an escalation read "sent" with nobody reached. `false` and any other value read
 * as `failed`.
 */
export function outcomeOf(value: unknown): ChannelOutcome {
  if (value === 'delivered' || value === 'skipped' || value === 'failed') return value;
  return value === true ? 'skipped' : 'failed';
}

export function summarizeDelivery(report: NotifyReport): DeliverySummary {
  if (report.length === 0) return 'no_channel';
  return report.some((r) => r.outcome === 'delivered') ? 'delivered' : 'not_delivered';
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export class NotificationRouter {
  private channels = new Map<string, NotificationChannel>();

  /** Register a channel. Replaces any existing channel with the same name. */
  register(channel: NotificationChannel): void {
    this.channels.set(channel.name, channel);
  }

  /** Unregister a channel by name. No-op if not found. */
  unregister(name: string): void {
    this.channels.delete(name);
  }

  /**
   * Send notification to **all** registered channels.
   * Best-effort — failures are logged to stderr, never thrown. Resolves to what each
   * channel did, so a caller that must know whether anyone was told can ask
   * (`summarizeDelivery`); a channel that threw counts as `failed`.
   */
  async notify(msg: NotificationMessage): Promise<NotifyReport> {
    return Promise.all(
      [...this.channels.values()].map(async (ch) => {
        let outcome: ChannelOutcome;
        try {
          outcome = outcomeOf(await ch.send(msg));
          if (outcome === 'failed') {
            process.stderr.write(
              `[notification-router] channel "${ch.name}" did not deliver\n`,
            );
          }
        } catch (err: unknown) {
          outcome = 'failed';
          const detail =
            err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `[notification-router] channel "${ch.name}" failed: ${detail}\n`,
          );
        }
        return { channel: ch.name, outcome };
      }),
    );
  }

  /**
   * Send to a specific channel by name.
   * Returns `false` if the channel is not found or the send failed. A `skipped` message
   * returns `true`, as it did when channels answered with a boolean — callers throttle on
   * this value (`integrations/inbox/notifier.ts`), so its meaning stays "handled".
   */
  async sendTo(
    channelName: string,
    msg: NotificationMessage,
  ): Promise<boolean> {
    const ch = this.channels.get(channelName);
    if (!ch) {
      return false;
    }
    try {
      const outcome = outcomeOf(await ch.send(msg));
      return outcome === 'delivered' || outcome === 'skipped';
    } catch (err: unknown) {
      const detail =
        err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[notification-router] channel "${channelName}" failed: ${detail}\n`,
      );
      return false;
    }
  }

  /** Whether at least one channel is registered. */
  hasChannels(): boolean {
    return this.channels.size > 0;
  }

  /** Names of all registered channels in insertion order. */
  getChannelNames(): string[] {
    return [...this.channels.keys()];
  }
}
