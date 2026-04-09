/**
 * Web Push notification channel — delivers notifications via Web Push API.
 * Stores push subscriptions in SQLite, sends via `web-push` library.
 * VAPID keys are auto-generated on first use and persisted to disk.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import webPush from 'web-push';
import Database from 'better-sqlite3';
import type {
  NotificationChannel,
  NotificationMessage,
} from '../../core/notification-router.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PushSubscriptionRow {
  endpoint: string;
  keys_p256dh: string;
  keys_auth: string;
  created_at: string;
}

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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint     TEXT PRIMARY KEY,
        keys_p256dh  TEXT NOT NULL,
        keys_auth    TEXT NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  add(endpoint: string, p256dh: string, auth: string): void {
    // Limit to 50 subscriptions per instance (prevents DB bloat)
    const count = this.count();
    if (count >= 50) {
      // Remove oldest subscription to make room
      this.db.prepare(`DELETE FROM push_subscriptions WHERE rowid IN (SELECT rowid FROM push_subscriptions ORDER BY created_at ASC LIMIT 1)`).run();
    }
    this.db
      .prepare(
        `INSERT OR REPLACE INTO push_subscriptions (endpoint, keys_p256dh, keys_auth) VALUES (?, ?, ?)`,
      )
      .run(endpoint, p256dh, auth);
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
      .prepare(`SELECT endpoint, keys_p256dh, keys_auth, created_at FROM push_subscriptions`)
      .all() as PushSubscriptionRow[];
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

  constructor(dataDir: string) {
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

  /** Add a push subscription. */
  subscribe(endpoint: string, p256dh: string, auth: string): void {
    this.store.add(endpoint, p256dh, auth);
  }

  /** Remove a push subscription. */
  unsubscribe(endpoint: string): void {
    this.store.remove(endpoint);
  }

  /** Number of active subscriptions. */
  subscriptionCount(): number {
    return this.store.count();
  }

  async send(msg: NotificationMessage): Promise<boolean> {
    const result = await this.sendDetailed(msg);
    return result.sent > 0;
  }

  async sendDetailed(msg: NotificationMessage): Promise<{ sent: number; failed: number; cleaned: number }> {
    // Prune expired subscriptions on each send (lightweight — SQLite handles it fast)
    this.store.prune();

    const subscriptions = this.store.getAll();
    if (subscriptions.length === 0) return { sent: 0, failed: 0, cleaned: 0 };

    const tag = msg.taskId ?? `lynox-${Date.now()}`;
    const payload: PushPayload = {
      title: msg.title.slice(0, 64),
      body: msg.body.slice(0, 240),
      tag,
      data: {
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
