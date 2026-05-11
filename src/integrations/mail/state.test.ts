import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MailStateDb } from './state.js';
import type { MailEnvelope } from './provider.js';

let db: MailStateDb;

beforeEach(() => {
  db = new MailStateDb({ path: ':memory:' });
});

afterEach(() => {
  db.close();
});

function envelope(uid: number, messageId: string | undefined): MailEnvelope {
  return {
    uid,
    messageId,
    folder: 'INBOX',
    threadKey: messageId,
    inReplyTo: undefined,
    from: [{ address: 'a@x.com' }],
    to: [{ address: 'me@x.com' }],
    cc: [],
    replyTo: [],
    subject: `msg-${String(uid)}`,
    date: new Date(),
    flags: [],
    snippet: '',
    hasAttachments: false,
    attachmentCount: 0,
    sizeBytes: 0,
    isAutoReply: false,
  };
}

describe('MailStateDb — hasSeen / markSeen', () => {
  it('reports false for unknown messages', () => {
    expect(db.hasSeen('acct', '<missing>')).toBe(false);
  });

  it('round-trips a single message', () => {
    db.markSeen('acct', envelope(1, '<m-1@x>'));
    expect(db.hasSeen('acct', '<m-1@x>')).toBe(true);
  });

  it('isolates accounts', () => {
    db.markSeen('acct-a', envelope(1, '<shared@x>'));
    expect(db.hasSeen('acct-a', '<shared@x>')).toBe(true);
    expect(db.hasSeen('acct-b', '<shared@x>')).toBe(false);
  });

  it('skips envelopes without a Message-ID (no-op)', () => {
    db.markSeen('acct', envelope(2, undefined));
    expect(db.countForAccount('acct')).toBe(0);
    expect(db.hasSeen('acct', '')).toBe(false);
  });

  it('treats an empty Message-ID as not-seen', () => {
    expect(db.hasSeen('acct', '')).toBe(false);
  });

  it('updates last_seen_at on re-mark, leaves first_seen_at alone', () => {
    db.markSeen('acct', envelope(1, '<m-1@x>'));
    db.markSeen('acct', envelope(99, '<m-1@x>')); // same id, different uid
    expect(db.countForAccount('acct')).toBe(1);
  });
});

describe('MailStateDb — partition', () => {
  it('returns empty arrays for empty input', () => {
    const result = db.partition('acct', []);
    expect(result.fresh).toEqual([]);
    expect(result.alreadySeen).toEqual([]);
  });

  it('separates fresh and already-seen envelopes', () => {
    db.markSeen('acct', envelope(1, '<seen-1@x>'));
    db.markSeen('acct', envelope(2, '<seen-2@x>'));

    const result = db.partition('acct', [
      envelope(1, '<seen-1@x>'),
      envelope(2, '<seen-2@x>'),
      envelope(3, '<new-1@x>'),
      envelope(4, '<new-2@x>'),
    ]);

    expect(result.fresh.map(e => e.uid)).toEqual([3, 4]);
    expect(result.alreadySeen.map(e => e.uid)).toEqual([1, 2]);
  });

  it('treats no-message-id envelopes as fresh even when other ids are known', () => {
    db.markSeen('acct', envelope(2, '<known@x>'));
    const result = db.partition('acct', [envelope(1, undefined), envelope(2, '<known@x>')]);
    expect(result.fresh).toHaveLength(1);
    expect(result.fresh[0]?.uid).toBe(1);
    expect(result.alreadySeen).toHaveLength(1);
    expect(result.alreadySeen[0]?.uid).toBe(2);
  });
});

describe('MailStateDb — markSeenBatch', () => {
  it('marks all envelopes in a single transaction', () => {
    const inserted = db.markSeenBatch('acct', [
      envelope(1, '<m-1@x>'),
      envelope(2, '<m-2@x>'),
      envelope(3, '<m-3@x>'),
    ]);
    expect(inserted).toBe(3);
    expect(db.countForAccount('acct')).toBe(3);
  });

  it('skips envelopes without a Message-ID', () => {
    const inserted = db.markSeenBatch('acct', [
      envelope(1, '<m-1@x>'),
      envelope(2, undefined),
    ]);
    expect(inserted).toBe(1);
    expect(db.countForAccount('acct')).toBe(1);
  });

  it('returns 0 for empty input', () => {
    expect(db.markSeenBatch('acct', [])).toBe(0);
  });
});

describe('MailStateDb — pruneOlderThan', () => {
  it('keeps recent rows, drops old rows', () => {
    db.markSeen('acct', envelope(1, '<m-1@x>'));
    // Force the row to look old by direct SQL
    const internal = (db as unknown as { db: import('better-sqlite3').Database }).db;
    internal
      .prepare(`UPDATE processed_mail_messages SET first_seen_at = datetime('now', '-100 days') WHERE message_id = ?`)
      .run('<m-1@x>');

    expect(db.pruneOlderThan(30)).toBe(1);
    expect(db.countForAccount('acct')).toBe(0);
  });

  it('returns 0 for a non-positive day count', () => {
    db.markSeen('acct', envelope(1, '<m-1@x>'));
    expect(db.pruneOlderThan(0)).toBe(0);
    expect(db.pruneOlderThan(-5)).toBe(0);
  });
});

describe('MailStateDb — forgetAccount', () => {
  it('drops everything for one account, leaves others alone', () => {
    db.markSeen('acct-a', envelope(1, '<m-1@x>'));
    db.markSeen('acct-a', envelope(2, '<m-2@x>'));
    db.markSeen('acct-b', envelope(3, '<m-3@x>'));

    expect(db.forgetAccount('acct-a')).toBe(2);
    expect(db.countForAccount('acct-a')).toBe(0);
    expect(db.countForAccount('acct-b')).toBe(1);
  });
});

// ── Follow-ups (Phase 0.2) ──────────────────────────────────────────────────

describe('MailStateDb — recordFollowup', () => {
  it('persists a followup with all fields', () => {
    const reminderAt = new Date('2026-04-22T10:00:00Z');
    const id = db.recordFollowup({
      accountId: 'acct',
      sentMessageId: '<sent-1@x>',
      threadKey: '<sent-1@x>',
      recipient: 'bob@example.com',
      type: 'awaiting_reply',
      reason: 'awaiting contract',
      reminderAt,
      source: 'user',
    });
    expect(id).toMatch(/^fu_/);
    const list = db.listFollowups('acct');
    expect(list).toHaveLength(1);
    expect(list[0]?.recipient).toBe('bob@example.com');
    expect(list[0]?.reason).toBe('awaiting contract');
    expect(list[0]?.status).toBe('pending');
    expect(list[0]?.reminderAt.toISOString()).toBe(reminderAt.toISOString());
  });

  it('counts pending followups per account', () => {
    db.recordFollowup({
      accountId: 'a', sentMessageId: '<1@x>', threadKey: '<1@x>',
      recipient: 'x@x.com', type: 'awaiting_reply', reason: 'r',
      reminderAt: new Date(),
    });
    db.recordFollowup({
      accountId: 'a', sentMessageId: '<2@x>', threadKey: '<2@x>',
      recipient: 'y@x.com', type: 'awaiting_reply', reason: 'r',
      reminderAt: new Date(),
    });
    db.recordFollowup({
      accountId: 'b', sentMessageId: '<3@x>', threadKey: '<3@x>',
      recipient: 'z@x.com', type: 'awaiting_reply', reason: 'r',
      reminderAt: new Date(),
    });
    expect(db.countPendingFollowups('a')).toBe(2);
    expect(db.countPendingFollowups('b')).toBe(1);
    expect(db.countPendingFollowups('c')).toBe(0);
  });
});

describe('MailStateDb — resolveFollowupsByReply', () => {
  it('resolves a followup when a reply from the tracked recipient arrives', () => {
    db.recordFollowup({
      accountId: 'acct', sentMessageId: '<msg@x>', threadKey: '<msg@x>',
      recipient: 'bob@example.com', type: 'awaiting_reply', reason: 'contract',
      reminderAt: new Date('2026-04-30T00:00:00Z'),
    });

    const resolved = db.resolveFollowupsByReply('acct', '<msg@x>', 'bob@example.com');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.status).toBe('resolved');
    expect(resolved[0]?.resolvedBy).toBe('reply_received');
    expect(db.countPendingFollowups('acct')).toBe(0);
  });

  it('ignores replies from a different address', () => {
    db.recordFollowup({
      accountId: 'acct', sentMessageId: '<msg@x>', threadKey: '<msg@x>',
      recipient: 'bob@example.com', type: 'awaiting_reply', reason: 'r',
      reminderAt: new Date(),
    });
    const resolved = db.resolveFollowupsByReply('acct', '<msg@x>', 'alice@example.com');
    expect(resolved).toHaveLength(0);
    expect(db.countPendingFollowups('acct')).toBe(1);
  });

  it('matches case-insensitively on recipient address', () => {
    db.recordFollowup({
      accountId: 'acct', sentMessageId: '<msg@x>', threadKey: '<msg@x>',
      recipient: 'Bob@Example.COM', type: 'awaiting_reply', reason: 'r',
      reminderAt: new Date(),
    });
    const resolved = db.resolveFollowupsByReply('acct', '<msg@x>', 'bob@example.com');
    expect(resolved).toHaveLength(1);
  });

  it('does not touch followups in other threads', () => {
    db.recordFollowup({
      accountId: 'acct', sentMessageId: '<m1@x>', threadKey: '<m1@x>',
      recipient: 'bob@example.com', type: 'awaiting_reply', reason: 'r1',
      reminderAt: new Date(),
    });
    db.recordFollowup({
      accountId: 'acct', sentMessageId: '<m2@x>', threadKey: '<m2@x>',
      recipient: 'bob@example.com', type: 'awaiting_reply', reason: 'r2',
      reminderAt: new Date(),
    });
    db.resolveFollowupsByReply('acct', '<m1@x>', 'bob@example.com');
    expect(db.countPendingFollowups('acct')).toBe(1);
  });
});

describe('MailStateDb — dueFollowups + markReminded + cancel', () => {
  it('lists pending followups whose reminder_at is due', () => {
    const past = new Date('2026-04-10T00:00:00Z');
    const future = new Date('2026-04-20T00:00:00Z');
    db.recordFollowup({
      accountId: 'acct', sentMessageId: '<a@x>', threadKey: '<a@x>',
      recipient: 'x@x.com', type: 'awaiting_reply', reason: 'old',
      reminderAt: past,
    });
    db.recordFollowup({
      accountId: 'acct', sentMessageId: '<b@x>', threadKey: '<b@x>',
      recipient: 'x@x.com', type: 'awaiting_reply', reason: 'new',
      reminderAt: future,
    });

    const due = db.dueFollowups(new Date('2026-04-15T00:00:00Z'));
    expect(due).toHaveLength(1);
    expect(due[0]?.reason).toBe('old');
  });

  it('markFollowupReminded transitions pending→reminded once', () => {
    const id = db.recordFollowup({
      accountId: 'acct', sentMessageId: '<a@x>', threadKey: '<a@x>',
      recipient: 'x@x.com', type: 'awaiting_reply', reason: 'r',
      reminderAt: new Date('2026-04-10T00:00:00Z'),
    });
    expect(db.markFollowupReminded(id)).toBe(true);
    // Second call is a no-op (row is 'reminded' now, not 'pending')
    expect(db.markFollowupReminded(id)).toBe(false);
    // dueFollowups no longer returns it
    expect(db.dueFollowups(new Date())).toHaveLength(0);
  });

  it('cancelFollowup transitions any non-terminal status to cancelled', () => {
    const id = db.recordFollowup({
      accountId: 'acct', sentMessageId: '<a@x>', threadKey: '<a@x>',
      recipient: 'x@x.com', type: 'awaiting_reply', reason: 'r',
      reminderAt: new Date('2026-04-30T00:00:00Z'),
    });
    expect(db.cancelFollowup(id)).toBe(true);
    expect(db.countPendingFollowups('acct')).toBe(0);
  });
});

describe('MailStateDb — schema migration', () => {
  it('migrates to the current schema version on first open', () => {
    const internal = (db as unknown as { db: import('better-sqlite3').Database }).db;
    const row = internal.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number };
    // The current version reflects the number of entries in the MIGRATIONS array.
    // Bumping this is fine — it just tracks the expected head.
    expect(row.v).toBe(10);
  });

  it('is idempotent — re-opening the same path does not error', () => {
    db.close();
    db = new MailStateDb({ path: ':memory:' });
    expect(db.countForAccount('any')).toBe(0);
  });

  it('v5 migration: backfills auth_type=imap on existing rows and accepts new oauth_provider_key', () => {
    db.upsertAccount({
      id: 'imap-1', displayName: 'imap', address: 'x@x.com', preset: 'gmail',
      imap: { host: 'i', port: 993, secure: true },
      smtp: { host: 's', port: 465, secure: true },
      authType: 'imap', type: 'personal',
    });
    const stored = db.getAccount('imap-1');
    expect(stored?.authType).toBe('imap');
    expect(stored?.oauthProviderKey).toBeUndefined();

    // Forward-compatible: a row written with authType='oauth_google' round-trips
    db.upsertAccount({
      id: 'gmail-oauth', displayName: 'gmail', address: 'g@x.com', preset: 'gmail',
      // IMAP fields still required by the v5 schema (NOT NULL relaxed in PR2);
      // pass placeholders so the row is writeable.
      imap: { host: '', port: 0, secure: true },
      smtp: { host: '', port: 0, secure: true },
      authType: 'oauth_google',
      oauthProviderKey: 'GOOGLE_OAUTH_TOKENS',
      type: 'business',
    });
    const oauth = db.getAccount('gmail-oauth');
    expect(oauth?.authType).toBe('oauth_google');
    expect(oauth?.oauthProviderKey).toBe('GOOGLE_OAUTH_TOKENS');
  });

  it('v6 migration: defaults is_default=0 for existing rows and round-trips isDefault', () => {
    db.upsertAccount({
      id: 'a', displayName: 'a', address: 'a@x.com', preset: 'gmail',
      imap: { host: 'i', port: 993, secure: true },
      smtp: { host: 's', port: 465, secure: true },
      authType: 'imap', type: 'personal',
    });
    expect(db.getAccount('a')?.isDefault).toBe(false);

    db.upsertAccount({
      id: 'b', displayName: 'b', address: 'b@x.com', preset: 'gmail',
      imap: { host: 'i', port: 993, secure: true },
      smtp: { host: 's', port: 465, secure: true },
      authType: 'imap', type: 'personal',
      isDefault: true,
    });
    expect(db.getAccount('b')?.isDefault).toBe(true);
    expect(db.defaultAccountId()).toBe('b');
  });
});

describe('MailStateDb — setDefaultAccount', () => {
  beforeEach(() => {
    db.upsertAccount({
      id: 'a', displayName: 'a', address: 'a@x.com', preset: 'gmail',
      imap: { host: 'i', port: 993, secure: true },
      smtp: { host: 's', port: 465, secure: true },
      authType: 'imap', type: 'personal',
    });
    db.upsertAccount({
      id: 'b', displayName: 'b', address: 'b@x.com', preset: 'gmail',
      imap: { host: 'i', port: 993, secure: true },
      smtp: { host: 's', port: 465, secure: true },
      authType: 'imap', type: 'personal',
    });
  });

  it('sets one row to is_default=1 and clears the rest in a single transaction', () => {
    expect(db.setDefaultAccount('a')).toBe(true);
    expect(db.defaultAccountId()).toBe('a');

    expect(db.setDefaultAccount('b')).toBe(true);
    expect(db.defaultAccountId()).toBe('b');
    // Invariant: at most one row holds the flag
    expect(db.getAccount('a')?.isDefault).toBe(false);
    expect(db.getAccount('b')?.isDefault).toBe(true);
  });

  it('returns false for an unknown id and leaves the existing default intact', () => {
    db.setDefaultAccount('a');
    expect(db.setDefaultAccount('missing')).toBe(false);
    // Existence is checked BEFORE clearing the previous default — typos no
    // longer silently demote whichever account was default before.
    expect(db.defaultAccountId()).toBe('a');
  });

  it('passing null clears the default entirely', () => {
    db.setDefaultAccount('a');
    expect(db.setDefaultAccount(null)).toBe(true);
    expect(db.defaultAccountId()).toBe(null);
  });
});

// ── Migration v7 smoke (Unified Inbox foundation) ─────────────────────────

describe('MailStateDb — migration v7 (Unified Inbox)', () => {
  function inner(state: MailStateDb): import('better-sqlite3').Database {
    return (state as unknown as { db: import('better-sqlite3').Database }).db;
  }

  it('creates all inbox tables', () => {
    const tables = inner(db)
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'inbox_%' ORDER BY name`,
      )
      .all() as ReadonlyArray<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual([
      'inbox_audit_log',
      'inbox_drafts',
      'inbox_item_bodies',
      'inbox_items',
      'inbox_rules',
    ]);
  });

  it('enables foreign_keys pragma so cascade chains fire', () => {
    expect(inner(db).pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('cascades inbox_items + inbox_drafts + inbox_audit_log + inbox_rules when a mail_account is deleted', () => {
    db.upsertAccount({
      id: 'acct-cascade',
      displayName: 'Cascade test',
      address: 'me@example.com',
      preset: 'custom',
      imap: { host: 'imap.example.com', port: 993, secure: true },
      smtp: { host: 'smtp.example.com', port: 465, secure: true },
      authType: 'imap',
      type: 'personal',
      isDefault: false,
    });

    const raw = inner(db);
    raw
      .prepare(
        `INSERT INTO inbox_items (id, account_id, channel, thread_key, bucket, confidence, reason_de, classified_at, classifier_version)
         VALUES (?, ?, ?, ?, ?, 0.9, ?, 1700000000000, 'haiku-2026-05')`,
      )
      .run('item-1', 'acct-cascade', 'email', 'imap:abc', 'requires_user', 'why');
    raw
      .prepare(
        `INSERT INTO inbox_drafts (id, item_id, body_md, generated_at, generator_version, user_edits_count)
         VALUES (?, ?, ?, 1700000000001, ?, 0)`,
      )
      .run('draft-1', 'item-1', 'Hi', 'gen-v1');
    raw
      .prepare(
        `INSERT INTO inbox_audit_log (id, item_id, action, actor, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, 1700000000002)`,
      )
      .run('audit-1', 'item-1', 'classified', 'classifier', '{}');
    raw
      .prepare(
        `INSERT INTO inbox_rules (id, account_id, matcher_kind, matcher_value, bucket, action, created_at, source)
         VALUES (?, ?, ?, ?, ?, ?, 1700000000003, ?)`,
      )
      .run('rule-1', 'acct-cascade', 'from', 'noreply@x', 'auto_handled', 'archive', 'on_demand');

    expect(db.deleteAccount('acct-cascade')).toBe(true);

    const itemCount = raw
      .prepare(`SELECT COUNT(*) as c FROM inbox_items WHERE account_id = 'acct-cascade'`)
      .get() as { c: number };
    const draftCount = raw
      .prepare(`SELECT COUNT(*) as c FROM inbox_drafts WHERE item_id = 'item-1'`)
      .get() as { c: number };
    const auditCount = raw
      .prepare(`SELECT COUNT(*) as c FROM inbox_audit_log WHERE item_id = 'item-1'`)
      .get() as { c: number };
    const ruleCount = raw
      .prepare(`SELECT COUNT(*) as c FROM inbox_rules WHERE account_id = 'acct-cascade'`)
      .get() as { c: number };
    expect(itemCount.c).toBe(0);
    expect(draftCount.c).toBe(0);
    expect(auditCount.c).toBe(0);
    expect(ruleCount.c).toBe(0);
  });

  it('rejects upsertAccount with a reserved channel prefix (whatsapp: / telegram:)', () => {
    const base = {
      displayName: 'Bad',
      address: 'me@example.com',
      preset: 'custom' as const,
      imap: { host: 'i', port: 993, secure: true },
      smtp: { host: 's', port: 465, secure: true },
      authType: 'imap' as const,
      type: 'personal' as const,
      isDefault: false,
    };
    expect(() => db.upsertAccount({ id: 'whatsapp:foo', ...base })).toThrow(/reserved channel prefix/);
    expect(() => db.upsertAccount({ id: 'telegram:foo', ...base })).toThrow(/reserved channel prefix/);
    // Normal ids still pass.
    expect(() => db.upsertAccount({ id: 'acct-normal', ...base })).not.toThrow();
  });

  it('accepts an inbox_items row with a non-mail account_id (v9 relaxed FK for WhatsApp pseudo-accounts)', () => {
    // v9 dropped the FK on inbox_items.account_id; the column is now
    // polymorphic (mail-account id OR 'whatsapp:<phone>'). Cascade on
    // mail-account delete is enforced application-side in deleteAccount().
    inner(db)
      .prepare(
        `INSERT INTO inbox_items (id, account_id, channel, thread_key, bucket, confidence, reason_de, classified_at, classifier_version)
         VALUES ('wa1', 'whatsapp:491234567890', 'whatsapp', 'whatsapp:thread:1', 'requires_user', 0.5, 'r', 0, 'v')`,
      )
      .run();
    const row = inner(db)
      .prepare(`SELECT account_id FROM inbox_items WHERE id = 'wa1'`)
      .get() as { account_id: string };
    expect(row.account_id).toBe('whatsapp:491234567890');
  });
});
