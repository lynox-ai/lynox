/**
 * Web Push notification channel — delivers notifications via Web Push API.
 * Stores push subscriptions in SQLite, sends via `web-push` library.
 * VAPID keys are auto-generated on first use and persisted to disk.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import webPush from 'web-push';
import Database from 'better-sqlite3';
import { scrubFreedPages, zeroDeletedContent } from '../../core/sqlite-constants.js';
import type {
  ChannelOutcome,
  NotificationChannel,
  NotificationMessage,
} from '../../core/notification-router.js';
import { isMandateTag, isOwnerPrincipal, principalTag, type RequestPrincipal } from '../../core/request-principal.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PushSubscriptionRow {
  endpoint: string;
  keys_p256dh: string;
  keys_auth: string;
  created_at: string;
  /** Who added it, as a principal tag; NULL for the owner (and every row from before tags). */
  created_by: string | null;
  /** The grant a mandate added it under; its end ends the subscription. NULL for the owner. */
  mandate_id: string | null;
}

/** How many subscriptions the whole instance keeps. */
const MAX_SUBSCRIPTIONS = 50;
/** How many of those one mandate may hold (PRD customer-granted-operator-access §3.13 B3). */
export const MAX_MANDATE_SUBSCRIPTIONS = 5;

/** Who a subscription is added for: the owner, or a mandate with the grant whose end ends it. */
type SubscriptionOwner = { readonly createdBy: null; readonly mandateId: null } | { readonly createdBy: string; readonly mandateId: string };

interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// VAPID key management
// ---------------------------------------------------------------------------

interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

function loadOrGenerateVapidKeys(dataDir: string): VapidKeys {
  const keysPath = join(dataDir, 'vapid-keys.json');

  if (existsSync(keysPath)) {
    const raw = readFileSync(keysPath, 'utf-8');
    return JSON.parse(raw) as VapidKeys;
  }

  const keys = webPush.generateVAPIDKeys();
  const subject = 'mailto:notifications@lynox.ai';
  const vapidKeys: VapidKeys = {
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    subject,
  };

  // Ensure directory exists
  const dir = join(keysPath, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  writeFileSync(keysPath, JSON.stringify(vapidKeys, null, 2), { mode: 0o600 });
  return vapidKeys;
}

// ---------------------------------------------------------------------------
// Subscription store (SQLite)
// ---------------------------------------------------------------------------

class PushSubscriptionStore {
  private readonly db: InstanceType<typeof Database>;

  constructor(dbPath: string) {
    const dir = join(dbPath, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    zeroDeletedContent(this.db);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint     TEXT PRIMARY KEY,
        keys_p256dh  TEXT NOT NULL,
        keys_auth    TEXT NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    // Who added a subscription, added to files from before; their rows stay the owner's (NULL).
    const columns = new Set((this.db.prepare('PRAGMA table_info(push_subscriptions)').all() as Array<{ name: string }>).map((c) => c.name));
    if (!columns.has('created_by')) this.db.exec('ALTER TABLE push_subscriptions ADD COLUMN created_by TEXT');
    if (!columns.has('mandate_id')) this.db.exec('ALTER TABLE push_subscriptions ADD COLUMN mandate_id TEXT');
  }

  /**
   * Add or replace a subscription. The instance keeps 50; the owner's add always succeeds and
   * makes room by removing the owner's own oldest, or the oldest a mandate added when the owner
   * holds none. A mandate holds at most `MAX_MANDATE_SUBSCRIPTIONS` and makes
   * room only among its own, so its adds never remove one of the owner's; when the instance is
   * full and it has none of its own to remove, the add is refused (`full`). Re-adding an endpoint
   * that is already stored takes no room.
   */
  add(endpoint: string, p256dh: string, auth: string, owner: SubscriptionOwner): 'ok' | 'full' {
    if (this.get(endpoint) === undefined) {
      if (owner.createdBy === null) {
        // The owner always gets in: room comes from the owner's own oldest, and only when the
        // owner holds none, from the oldest a mandate added.
        if (this.count() >= MAX_SUBSCRIPTIONS) {
          this.db.prepare(`DELETE FROM push_subscriptions WHERE rowid IN (SELECT rowid FROM push_subscriptions ORDER BY COALESCE(created_by LIKE 'mandate:%', 0) ASC, created_at ASC, rowid ASC LIMIT 1)`).run();
        }
      } else {
        const own = (this.db.prepare('SELECT COUNT(*) AS cnt FROM push_subscriptions WHERE created_by = ?').get(owner.createdBy) as { cnt: number }).cnt;
        if (own >= MAX_MANDATE_SUBSCRIPTIONS) {
          this.db.prepare(`DELETE FROM push_subscriptions WHERE rowid IN (SELECT rowid FROM push_subscriptions WHERE created_by = ? ORDER BY created_at ASC, rowid ASC LIMIT 1)`).run(owner.createdBy);
        } else if (this.count() >= MAX_SUBSCRIPTIONS) {
          return 'full';
        }
      }
    }
    this.db
      .prepare(
        `INSERT OR REPLACE INTO push_subscriptions (endpoint, keys_p256dh, keys_auth, created_by, mandate_id) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(endpoint, p256dh, auth, owner.createdBy, owner.mandateId);
    return 'ok';
  }

  get(endpoint: string): PushSubscriptionRow | undefined {
    return this.db
      .prepare(`SELECT endpoint, keys_p256dh, keys_auth, created_at, created_by, mandate_id FROM push_subscriptions WHERE endpoint = ?`)
      .get(endpoint) as PushSubscriptionRow | undefined;
  }

  /** Remove subscriptions older than 90 days. */
  prune(): number {
    const result = this.db
      .prepare(`DELETE FROM push_subscriptions WHERE created_at < datetime('now', '-90 days')`)
      .run();
    return result.changes;
  }

  remove(endpoint: string): void {
    this.db
      .prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`)
      .run(endpoint);
  }

  getAll(): PushSubscriptionRow[] {
    return this.db
      .prepare(`SELECT endpoint, keys_p256dh, keys_auth, created_at, created_by, mandate_id FROM push_subscriptions`)
      .all() as PushSubscriptionRow[];
  }

  /** GDPR Art. 17: every subscription (each names a browser endpoint of the user). */
  deleteAll(): void {
    this.db.prepare('DELETE FROM push_subscriptions').run();
  }

  scrubFreedPages(): void {
    scrubFreedPages(this.db);
  }

  count(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM push_subscriptions`)
      .get() as { cnt: number };
    return row.cnt;
  }
}

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

export class WebPushNotificationChannel implements NotificationChannel {
  readonly name = 'web-push';
  private readonly store: PushSubscriptionStore;
  private readonly vapidKeys: VapidKeys;

  /** GDPR Art. 17: delete every subscription and scrub the file. */
  eraseSubscriptions(): void {
    this.store.deleteAll();
  }

  scrubFreedPages(): void {
    this.store.scrubFreedPages();
  }

  /** Whether a mandate is still live; a subscription it added ends with it. */
  private readonly isMandateLive: (mandateId: string) => boolean;

  /**
   * `isMandateLive` answers for the grant a mandate's subscription was added under. Without
   * one, every mandate counts as ended, so nothing reaches a device a mandate added.
   */
  constructor(dataDir: string, opts: { isMandateLive?: (mandateId: string) => boolean } = {}) {
    this.isMandateLive = opts.isMandateLive ?? (() => false);
    this.vapidKeys = loadOrGenerateVapidKeys(dataDir);
    this.store = new PushSubscriptionStore(join(dataDir, 'push-subscriptions.db'));
    webPush.setVapidDetails(
      this.vapidKeys.subject,
      this.vapidKeys.publicKey,
      this.vapidKeys.privateKey,
    );
  }

  /** Public VAPID key — safe to expose to browser. */
  getPublicKey(): string {
    return this.vapidKeys.publicKey;
  }

  /**
   * Add a push subscription for whoever asked. A mandate's is tied to the grant it logged in
   * with: `no_grant` when its session names no grant to end it with, `full` when the instance
   * has no room it may take (see `PushSubscriptionStore.add`).
   */
  subscribe(endpoint: string, p256dh: string, auth: string, by: RequestPrincipal): 'ok' | 'full' | 'no_grant' {
    if (isOwnerPrincipal(by)) return this.store.add(endpoint, p256dh, auth, { createdBy: null, mandateId: null });
    if (by.kind !== 'mandate' || by.mandateId === undefined) return 'no_grant';
    return this.store.add(endpoint, p256dh, auth, { createdBy: principalTag(by), mandateId: by.mandateId });
  }

  /** Remove a push subscription. */
  unsubscribe(endpoint: string): void {
    this.store.remove(endpoint);
  }

  /** Who added the subscription at `endpoint` (`created_by`, NULL for the owner); undefined when none is stored. */
  addedBy(endpoint: string): { created_by: string | null } | undefined {
    const row = this.store.get(endpoint);
    return row === undefined ? undefined : { created_by: row.created_by };
  }

  /** Number of live subscriptions; for a mandate, of its own. */
  subscriptionCount(of?: RequestPrincipal): number {
    return this.liveSubscriptions(of).length;
  }

  /**
   * The subscriptions a send may reach: the owner's, and those of mandates still live. One a
   * mandate added whose grant has ended (or that names no grant) is removed here, so its
   * device is told nothing after the end (PRD customer-granted-operator-access §3.13 B3).
   * With `of` a mandate, only that mandate's own.
   */
  private liveSubscriptions(of?: RequestPrincipal): PushSubscriptionRow[] {
    const live: PushSubscriptionRow[] = [];
    for (const row of this.store.getAll()) {
      if (isMandateTag(row.created_by) && (row.mandate_id === null || !this.isMandateLive(row.mandate_id))) {
        this.store.remove(row.endpoint);
        continue;
      }
      live.push(row);
    }
    if (of === undefined || isOwnerPrincipal(of)) return live;
    const tag = principalTag(of);
    return live.filter((row) => row.created_by === tag);
  }

  /** `failed` with no subscription too: nobody was told, and that is what the caller asks. */
  async send(msg: NotificationMessage): Promise<ChannelOutcome> {
    const result = await this.sendDetailed(msg);
    return result.sent > 0 ? 'delivered' : 'failed';
  }

  /** With `onlyFor` a mandate, the message goes only to that mandate's own subscriptions. */
  async sendDetailed(msg: NotificationMessage, onlyFor?: RequestPrincipal): Promise<{ sent: number; failed: number; cleaned: number }> {
    // Prune expired subscriptions on each send (lightweight — SQLite handles it fast)
    this.store.prune();

    const subscriptions = this.liveSubscriptions(onlyFor);
    if (subscriptions.length === 0) return { sent: 0, failed: 0, cleaned: 0 };

    const tag = msg.taskId ?? `lynox-${Date.now()}`;
    const payload: PushPayload = {
      title: msg.title.slice(0, 64),
      body: msg.body.slice(0, 240),
      tag,
      data: {
        // Channel passthrough — inbox notifier sets `itemId`; SW reads
        // it for the deep-link. Spread first so the typed `priority`/
        // `taskId` fields below WIN — caller `data` can't silently
        // override them just by reusing the key name.
        ...(msg.data ?? {}),
        priority: msg.priority,
        taskId: msg.taskId,
      },
    };

    const payloadStr = JSON.stringify(payload);
    const staleEndpoints: string[] = [];
    let sent = 0;
    let failed = 0;

    await Promise.allSettled(
      subscriptions.map(async (sub) => {
        try {
          await webPush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth },
            },
            payloadStr,
            { TTL: 86400 }, // 24h
          );
          sent++;
        } catch (err: unknown) {
          // 404 or 410 = subscription expired, remove it
          const statusCode = (err as { statusCode?: number })?.statusCode;
          if (statusCode === 404 || statusCode === 410) {
            staleEndpoints.push(sub.endpoint);
          } else {
            failed++;
            const detail = err instanceof Error ? err.message : String(err);
            process.stderr.write(
              `[web-push] failed for ${sub.endpoint.slice(0, 50)}…: ${detail}\n`,
            );
          }
        }
      }),
    );

    // Clean up stale subscriptions
    for (const ep of staleEndpoints) {
      this.store.remove(ep);
    }

    return { sent, failed, cleaned: staleEndpoints.length };
  }
}
