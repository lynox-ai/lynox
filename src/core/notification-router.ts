/**
 * Notification router — best-effort delivery to registered channels.
 * Zero external dependencies.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
   * Channel-specific passthrough data — e.g. the inbox notifier sets
   * `{ itemId: '<inbox-row-id>' }` so the service worker's
   * `notificationclick` handler can deep-link to the affected mail.
   * Keep keys flat-string for JSON serialisation across web-push.
   */
  data?: Record<string, string> | undefined;
}

export interface NotificationChannel {
  readonly name: string;
  send(msg: NotificationMessage): Promise<boolean>;
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
   * Best-effort — failures are logged to stderr, never thrown.
   */
  async notify(msg: NotificationMessage): Promise<void> {
    const results = await Promise.allSettled(
      [...this.channels.values()].map(async (ch) => {
        try {
          const ok = await ch.send(msg);
          if (!ok) {
            process.stderr.write(
              `[notification-router] channel "${ch.name}" returned false\n`,
            );
          }
        } catch (err: unknown) {
          const detail =
            err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `[notification-router] channel "${ch.name}" failed: ${detail}\n`,
          );
        }
      }),
    );
    // Consume results — allSettled never rejects, but lint wants no floating promises.
    void results;
  }

  /**
   * Send to a specific channel by name.
   * Returns `false` if the channel is not found or the send failed.
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
      return await ch.send(msg);
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
