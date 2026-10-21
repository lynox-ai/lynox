import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { EngineDb } from './engine-db.js';
import {
  ApprovalStore, approvalKeys, approvalQueueEnabled,
  APPROVAL_TTL_MS, APPROVAL_CLAIM_WINDOW_MS, APPROVAL_CLAIM_STALE_MS, APPROVAL_PURGE_AFTER_MS, APPROVAL_DEDUP_WINDOW_MS,
  type ApprovalOrigin, type MailReplyPayload, type MailSendPayload, type FileApprovalInput,
} from './approval-store.js';

const T0 = Date.parse('2026-10-21T08:00:00.000Z');
const H = 60 * 60_000;
const D = 24 * H;

const origin = (over: Partial<ApprovalOrigin> = {}): ApprovalOrigin => ({
  source: 'workflow', triggerId: 'trg-1', runId: 'run-1', rootRunId: 'run-1', ...over,
});

const reply = (over: Partial<MailReplyPayload> = {}): MailReplyPayload => ({
  accountId: 'acc-1',
  fromAddress: 'owner@example.com',
  to: [{ address: 'anna@example.com' }],
  cc: [],
  subject: 'Re: Angebot',
  bodyText: 'Guten Tag, danke für die Anfrage.',
  originalThreadKey: 'thread-1',
  originalMessageId: '<m1@example.com>',
  originalFolderUid: 'INBOX:41',
  original: { from: 'anna@example.com', to: ['owner@example.com'], cc: [], subject: 'Angebot', date: '2026-10-20T10:00:00.000Z' },
  ...over,
});

const send = (over: Partial<MailSendPayload> = {}): MailSendPayload => ({
  accountId: 'acc-1',
  fromAddress: 'owner@example.com',
  to: [{ address: 'Bob@Example.com' }],
  cc: [],
  bcc: [],
  subject: 'Wochenbericht',
  bodyText: 'Hier der Bericht.',
  trackFollowup: false,
  ...over,
});

const replyFiling = (over: Partial<MailReplyPayload> = {}, now = T0, o: Partial<ApprovalOrigin> = {}): FileApprovalInput => ({
  filing: { kind: 'mail_reply', payload: reply(over) }, origin: origin(o), createdBy: 'owner', mandateId: null, now,
});

const sendFiling = (over: Partial<MailSendPayload> = {}, now = T0, o: Partial<ApprovalOrigin> = {}): FileApprovalInput => ({
  filing: { kind: 'mail_send', payload: send(over) }, origin: origin(o), createdBy: 'owner', mandateId: null, now,
});

let dir: string;
let engine: EngineDb;
let store: ApprovalStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lynox-approval-'));
  engine = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
  store = new ApprovalStore(engine);
});

afterEach(() => {
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

function fileOk(input: FileApprovalInput, s: ApprovalStore = store): string {
  const r = s.file(input);
  if (!r.ok) throw new Error(`filing refused: ${r.reason}`);
  return r.id;
}

/** Approve an entry the way the decide route will: with the checksum the owner was shown. */
function approve(id: string, now = T0 + H): void {
  const e = store.get(id)!;
  expect(store.decide(id, { action: 'approve', checksum: e.checksum }, 'owner', now)).toEqual({ ok: true });
}

/** Approve and claim; the claim's own result is asserted. */
function approveAndClaim(id: string, now = T0 + H): void {
  approve(id, now);
  expect(store.claim(id, now).ok).toBe(true);
}

/** End an entry `unknown` the way a lost send does. */
function endUnknown(id: string, now = T0 + H): void {
  approveAndClaim(id, now);
  expect(store.finish(id, 'unknown', { error: 'connection lost' }, now)).toBe('unknown');
}

const raw = (): Database.Database => engine.getDb();

/**
 * A direct write to the file, as someone with access to it could make: the write-once trigger
 * is dropped first, because what these tests check is what the store does with a row that
 * changed anyway.
 */
function tamper(sql: string, ...args: unknown[]): void {
  raw().exec('DROP TRIGGER IF EXISTS approval_entries_written_once');
  raw().prepare(sql).run(...args);
}

describe('approval_entries migration (v48)', () => {
  it('a fresh database has the table, its indexes, its trigger and version 48', () => {
    const objects = raw().prepare("SELECT type, name FROM sqlite_master WHERE tbl_name = 'approval_entries' AND name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
    expect(objects).toEqual([
      { type: 'index', name: 'idx_approval_entries_active' }, { type: 'index', name: 'idx_approval_entries_dedup' },
      { type: 'index', name: 'idx_approval_entries_family' }, { type: 'index', name: 'idx_approval_entries_purge' },
      { type: 'index', name: 'idx_approval_entries_status' },
      { type: 'table', name: 'approval_entries' },
      { type: 'trigger', name: 'approval_entries_written_once' },
    ]);
    expect((raw().prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(48);
  });

  it('migrates an existing v47 database with data in it, leaves that data alone, and does not run twice', () => {
    const path = join(dir, 'existing.db');
    new EngineDb(path, 'test-vault-key').close();
    const db = new Database(path);
    // A v47 database: the current schema with v48 taken back out, holding rows in the tables
    // around it.
    db.exec(`
      DELETE FROM schema_version WHERE version >= 48; DROP TABLE approval_entries;
      INSERT INTO triggers (id, title) VALUES ('t1', 'Wochenbericht');
      INSERT INTO inbound_events (id, trigger_id, dedup_key, received_at, state, updated_at) VALUES ('ev1', 't1', 'k1', '2026-10-20T00:00:00.000Z', 'received', '2026-10-20T00:00:00.000Z');
    `);
    const before = {
      triggers: db.prepare('SELECT * FROM triggers ORDER BY id').all(),
      events: db.prepare('SELECT * FROM inbound_events ORDER BY id').all(),
    };
    expect(db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'approval_entries'").get()).toEqual({ c: 0 });
    db.close();

    const migrated = new EngineDb(path, 'test-vault-key');
    const m = migrated.getDb();
    expect((m.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(48);
    expect(m.prepare('SELECT * FROM triggers ORDER BY id').all()).toEqual(before.triggers);
    expect(m.prepare('SELECT * FROM inbound_events ORDER BY id').all()).toEqual(before.events);
    expect(new ApprovalStore(migrated).file(replyFiling()).ok).toBe(true);
    migrated.close();

    // A restart does not migrate again, and the entry is still there.
    const again = new EngineDb(path, 'test-vault-key');
    expect(again.getDb().prepare('SELECT COUNT(*) AS c FROM schema_version WHERE version = 48').get()).toEqual({ c: 1 });
    expect(again.getDb().prepare('SELECT COUNT(*) AS c FROM approval_entries').get()).toEqual({ c: 1 });
    again.close();
  });

  it('the database itself makes two open entries with one key one, but lets an ended one stand beside a new one', () => {
    const ins = raw().prepare(
      `INSERT INTO approval_entries (id, kind, payload_json, origin_json, dedup_key, checksum, binding, status, created_at, expires_at)
       VALUES (?, 'mail_reply', '{}', '{}', 'k', 'c', 'keyed', ?, '2026-10-21T08:00:00.000Z', '2026-10-24T08:00:00.000Z')`,
    );
    ins.run('a', 'done');
    ins.run('b', 'pending');
    expect(() => ins.run('c', 'unknown')).toThrow(/UNIQUE/);
    expect(() => ins.run('d', 'approved')).toThrow(/UNIQUE/);
    ins.run('e', 'rejected');
  });

  it('checks kind and status, and leaves the origin source open', () => {
    const ins = raw().prepare(
      `INSERT INTO approval_entries (id, kind, payload_json, origin_json, dedup_key, checksum, binding, status, created_at, expires_at)
       VALUES (?, ?, '{}', ?, ?, 'c', 'keyed', ?, '2026-10-21T08:00:00.000Z', '2026-10-24T08:00:00.000Z')`,
    );
    expect(() => ins.run('a', 'http_request', '{}', 'k1', 'pending')).toThrow(/CHECK/);
    expect(() => ins.run('b', 'mail_send', '{}', 'k2', 'superseded')).toThrow(/CHECK/);
    ins.run('c', 'mail_send', JSON.stringify({ source: 'inbox' }), 'k3', 'pending');
  });

  it('the trigger refuses any change to what an entry binds, and lets the status move', () => {
    const id = fileOk(replyFiling());
    const columns: Array<[string, string]> = [
      ['payload_json', 'x'], ['origin_json', '{}'], ['checksum', 'c'], ['kind', 'mail_send'], ['binding', 'unkeyed'],
      ['dedup_key', 'k'], ['family_key', 'f'], ['created_by', 'someone'], ['mandate_id', 'm'],
      ['created_at', '2020-01-01T00:00:00.000Z'], ['expires_at', '2099-01-01T00:00:00.000Z'], ['id', 'other'],
    ];
    for (const [column, value] of columns) {
      expect(() => raw().prepare(`UPDATE approval_entries SET ${column} = ? WHERE id = ?`).run(value, id), column).toThrow(/written once/);
    }
    raw().prepare("UPDATE approval_entries SET status = 'rejected' WHERE id = ?").run(id);
    expect(store.get(id)!.status).toBe('rejected');
  });

  it('the trigger lets only a tombstone empty the payload', () => {
    const id = fileOk(replyFiling());
    expect(() => raw().prepare("UPDATE approval_entries SET payload_json = '', tombstoned_at = 'x' WHERE id = ?").run(id)).toThrow(/written once/);
    endUnknown(id);
    expect(() => raw().prepare("UPDATE approval_entries SET payload_json = 'other', tombstoned_at = 'x' WHERE id = ?").run(id)).toThrow(/written once/);
    expect(() => raw().prepare("UPDATE approval_entries SET payload_json = '' WHERE id = ?").run(id)).toThrow(/written once/);
    raw().prepare("UPDATE approval_entries SET payload_json = '', tombstoned_at = 'x' WHERE id = ?").run(id);
  });
});

describe('ApprovalStore.file', () => {
  it('inserts a pending entry with a checksum, a 72-hour expiry, the payload encrypted and the keys hashed', () => {
    const id = fileOk(replyFiling());
    const e = store.get(id)!;
    expect(e).toMatchObject({
      kind: 'mail_reply', status: 'pending', executable: true, binding: 'keyed', attempts: 0,
      createdAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + APPROVAL_TTL_MS).toISOString(),
      createdBy: 'owner', mandateId: null, decidedAt: null, claimedAt: null, purgeAfter: null, tombstonedAt: null,
    });
    expect(e.filing).toEqual({ kind: 'mail_reply', payload: reply() });
    expect(e.origin).toEqual(origin());
    expect(e.checksum).toMatch(/^[0-9a-f]{64}$/);
    const row = raw().prepare('SELECT payload_json, dedup_key, family_key FROM approval_entries WHERE id = ?').get(id) as Record<string, string | null>;
    expect(row['payload_json']).toMatch(/^enc:/);
    expect(row['payload_json']).not.toContain('Angebot');
    expect(row['dedup_key']).toMatch(/^[0-9a-f]{64}$/);
    expect(row['dedup_key']).not.toContain('acc-1');
    expect(row['family_key']).toBeNull();
    expect(store.checksumMatches(id)).toBe(true);
  });

  it('the stored keys are an HMAC under the instance key: they cannot be recomputed without it', () => {
    const id = fileOk(sendFiling());
    const row = raw().prepare('SELECT dedup_key, family_key FROM approval_entries WHERE id = ?').get(id) as { dedup_key: string; family_key: string };
    const keys = approvalKeys({ kind: 'mail_send', payload: send() }, origin());
    // What anyone could compute from the addresses and the subject alone, with no key.
    const unkeyed = (plain: string): string => {
      const h = createHash('sha256');
      for (const p of ['approval-dedup-v1', plain]) h.update(`${String(Buffer.byteLength(p, 'utf8'))}:`).update(p);
      return h.digest('hex');
    };
    expect(row.family_key).toMatch(/^[0-9a-f]{64}$/);
    expect(row.family_key).not.toBe(unkeyed(keys.familyKey!));
    expect(row.dedup_key).not.toBe(unkeyed(keys.dedupKey));
    // The same store under another key does not meet them either.
    const other = new EngineDb(join(dir, 'other.db'), 'another-key');
    expect(new ApprovalStore(other).file(sendFiling()).ok).toBe(true);
    const otherRow = other.getDb().prepare('SELECT family_key FROM approval_entries').get() as { family_key: string };
    expect(otherRow.family_key).not.toBe(row.family_key);
    other.close();
    // The unkeyed form is exactly what an instance without a vault key stores, and says so.
    const plain = new EngineDb(join(dir, 'plain.db'), '');
    const p = new ApprovalStore(plain);
    const pid = fileOk(sendFiling(), p);
    const plainRow = plain.getDb().prepare('SELECT family_key, binding FROM approval_entries WHERE id = ?').get(pid) as { family_key: string; binding: string };
    expect(plainRow).toEqual({ family_key: unkeyed(keys.familyKey!), binding: 'unkeyed' });
    plain.close();
  });

  it('refuses an origin without its trigger, run or root run, or with a source this engine does not know', () => {
    expect(store.file(replyFiling({}, T0, { triggerId: '' }))).toEqual({ ok: false, reason: 'invalid_origin' });
    expect(store.file(replyFiling({}, T0, { runId: '' }))).toEqual({ ok: false, reason: 'invalid_origin' });
    expect(store.file(replyFiling({}, T0, { rootRunId: '' }))).toEqual({ ok: false, reason: 'invalid_origin' });
    expect(store.file(replyFiling({}, T0, { source: 'inbox' as 'task' }))).toEqual({ ok: false, reason: 'invalid_origin' });
    expect(store.file(sendFiling({}, T0, { eventId: '' }))).toEqual({ ok: false, reason: 'invalid_origin' });
    expect(raw().prepare('SELECT COUNT(*) AS c FROM approval_entries').get()).toEqual({ c: 0 });
    expect(store.file(replyFiling({}, T0, { source: 'task' })).ok).toBe(true);
    expect(store.file(sendFiling({}, T0, { eventId: 'ev-1' })).ok).toBe(true);
  });

  it('refuses the same reply while one waits or runs, and says it waits', () => {
    const first = fileOk(replyFiling());
    expect(store.file(replyFiling({ bodyText: 'Eine andere Fassung.' }, T0 + H))).toEqual({ ok: false, reason: 'waiting', existingId: first });
    approve(first);
    expect(store.file(replyFiling({}, T0 + 2 * H))).toEqual({ ok: false, reason: 'waiting', existingId: first });
    expect(store.claim(first, T0 + 2 * H).ok).toBe(true);
    expect(store.file(replyFiling({}, T0 + 2 * H))).toEqual({ ok: false, reason: 'waiting', existingId: first });
  });

  it('refuses a reply whose earlier outcome is unknown, at any age before the purge, and says so', () => {
    const first = fileOk(replyFiling());
    endUnknown(first);
    expect(store.file(replyFiling({}, T0 + 20 * D))).toEqual({ ok: false, reason: 'unknown', existingId: first });
  });

  it('a reply to another message of the same conversation is a different entry', () => {
    fileOk(replyFiling());
    expect(store.file(replyFiling({ originalMessageId: '<m2@example.com>', originalFolderUid: 'INBOX:42' })).ok).toBe(true);
  });

  it('refuses a reply sent within 14 days, and takes it after', () => {
    const first = fileOk(replyFiling());
    approveAndClaim(first);
    expect(store.finish(first, 'done', { messageId: '<sent@x>' }, T0 + H)).toBe('done');
    const window = APPROVAL_DEDUP_WINDOW_MS.mail_reply;
    expect(store.file(replyFiling({}, T0 + H + window - 1))).toEqual({ ok: false, reason: 'sent', existingId: first });
    expect(store.file(replyFiling({}, T0 + H + window)).ok).toBe(true);
  });

  it('refuses a reply the owner discarded within the window, but not one cleared after an unknown outcome', () => {
    const discarded = fileOk(replyFiling());
    expect(store.decide(discarded, { action: 'reject', reason: 'owner' }, 'owner', T0 + H)).toEqual({ ok: true });
    expect(store.file(replyFiling({}, T0 + 2 * H))).toEqual({ ok: false, reason: 'discarded', existingId: discarded });

    const other = { originalMessageId: '<m9@example.com>' };
    const lost = fileOk(replyFiling(other));
    endUnknown(lost);
    expect(store.decide(lost, { action: 'clear_unknown' }, 'owner', T0 + 2 * H)).toEqual({ ok: true });
    expect(store.get(lost)).toMatchObject({
      status: 'rejected', decidedReason: 'cleared_unknown', purgeAfter: new Date(T0 + 2 * H + APPROVAL_PURGE_AFTER_MS).toISOString(),
    });
    expect(store.file(replyFiling(other, T0 + 3 * H)).ok).toBe(true);
  });

  it('a failed or expired entry does not refuse the same mail again', () => {
    const failed = fileOk(replyFiling());
    approveAndClaim(failed);
    store.finish(failed, 'failed', { reason: 'account changed' }, T0 + H);
    expect(store.file(replyFiling({}, T0 + 2 * H)).ok).toBe(true);

    const o = { originalMessageId: '<m7@example.com>' };
    fileOk(replyFiling(o));
    store.sweep({ now: T0 + APPROVAL_TTL_MS, engineStartedAt: T0, flagOn: true });
    expect(store.file(replyFiling(o, T0 + APPROVAL_TTL_MS)).ok).toBe(true);
  });

  it('mail_send: a re-drafted mail of an open family is refused with its own reason, at any age', () => {
    const a = fileOk(sendFiling());
    // The next cron run drafts the same mail anew: new run id, new body, same account, recipients and subject.
    const redraft = (now: number): FileApprovalInput => sendFiling(
      { bodyText: 'Der Bericht, neu.', to: [{ address: 'bob@example.com ' }], subject: ' wochenbericht' }, now, { runId: 'run-2', rootRunId: 'run-2' });
    expect(store.file(redraft(T0 + 30 * 60_000))).toEqual({ ok: false, reason: 'family_open', existingId: a });
    // The identical mail meets its exact key first, and says it waits.
    expect(store.file(sendFiling({}, T0 + 30 * 60_000))).toEqual({ ok: false, reason: 'waiting', existingId: a });
    approve(a);
    expect(store.file(redraft(T0 + 2 * H))).toEqual({ ok: false, reason: 'family_open', existingId: a });
    expect(store.claim(a, T0 + 2 * H).ok).toBe(true);
    expect(store.finish(a, 'unknown', null, T0 + 2 * H)).toBe('unknown');
    expect(store.file(redraft(T0 + 20 * D))).toEqual({ ok: false, reason: 'unknown', existingId: a });
    expect(store.file(sendFiling({}, T0 + 20 * D))).toEqual({ ok: false, reason: 'unknown', existingId: a });
  });

  it('mail_send: a family with an unknown entry and a newer open one names the unknown one', () => {
    const lost = fileOk(sendFiling());
    endUnknown(lost);
    // A second mail of the family by another run with another body, from before G1 or a writer
    // outside the store: the family then holds two open entries.
    raw().prepare(
      `INSERT INTO approval_entries (id, kind, payload_json, origin_json, dedup_key, family_key, checksum, binding, status, created_at, expires_at)
       SELECT 'newer', kind, payload_json, origin_json, 'other-key', family_key, checksum, binding, 'pending', ?, ? FROM approval_entries WHERE id = ?`,
    ).run(new Date(T0 + 2 * H).toISOString(), new Date(T0 + 2 * H + APPROVAL_TTL_MS).toISOString(), lost);
    expect(store.file(sendFiling({ bodyText: 'dritte Fassung' }, T0 + 3 * H, { runId: 'run-3' }))).toEqual({ ok: false, reason: 'unknown', existingId: lost });
  });

  it('mail_send: other recipients, another subject or another account file beside an open entry', () => {
    fileOk(sendFiling());
    expect(store.file(sendFiling({ to: [{ address: 'carla@example.com' }] })).ok).toBe(true);
    expect(store.file(sendFiling({ subject: 'Monatsbericht' })).ok).toBe(true);
    // Another account is another family; the same run's identical mail would still meet its
    // exact key (§4.3a keys a send by run, recipients, subject and body, not by account).
    expect(store.file(sendFiling({ accountId: 'acc-2', bodyText: 'Vom zweiten Konto.' })).ok).toBe(true);
  });

  it('mail_send: once the first is sent its family waits 24 hours; once discarded too', () => {
    const a = fileOk(sendFiling());
    approveAndClaim(a);
    store.finish(a, 'done', null, T0 + H);
    const next = sendFiling({ bodyText: 'Der Bericht, neu.' }, T0 + 2 * H, { runId: 'run-2', rootRunId: 'run-2' });
    expect(store.file(next)).toEqual({ ok: false, reason: 'sent', existingId: a });
    expect(store.file({ ...next, now: T0 + H + APPROVAL_DEDUP_WINDOW_MS.mail_send }).ok).toBe(true);

    const b = fileOk(sendFiling({ subject: 'Offerte' }));
    store.decide(b, { action: 'reject', reason: 'moved_to_chat' }, 'owner', T0 + H);
    expect(store.file(sendFiling({ subject: 'Offerte', bodyText: 'neu' }, T0 + 2 * H, { runId: 'run-3' }))).toEqual({ ok: false, reason: 'discarded', existingId: b });
  });
});

describe('approvalKeys', () => {
  it('a reply is keyed by the replied-to message, else by folder and uid', () => {
    expect(approvalKeys({ kind: 'mail_reply', payload: reply() }, origin()).dedupKey).toBe('["mail_reply","acc-1","<m1@example.com>"]');
    expect(approvalKeys({ kind: 'mail_reply', payload: reply({ originalMessageId: undefined }) }, origin()).dedupKey).toBe('["mail_reply","acc-1","INBOX:41"]');
  });

  it('a send is keyed by its event before its run, with sorted recipients and the trimmed, lower-cased subject', () => {
    const k = approvalKeys({ kind: 'mail_send', payload: send({ cc: [{ address: 'a@x.ch' }] }) }, origin({ eventId: 'ev-9' }));
    expect(k.dedupKey).toMatch(/^\["mail_send","ev-9",\["a@x\.ch","bob@example\.com"\],"wochenbericht","[0-9a-f]{64}"\]$/);
    expect(k.familyKey).toBe('["mail_send","acc-1",["a@x.ch","bob@example.com"],"wochenbericht"]');
    expect(approvalKeys({ kind: 'mail_send', payload: send() }, origin()).dedupKey).toMatch(/^\["mail_send","run-1",/);
  });

  it('an address or subject holding a separator does not run into the next part', () => {
    const a = approvalKeys({ kind: 'mail_send', payload: send({ to: [{ address: 'x@y' }], subject: 'a|b' }) }, origin()).familyKey;
    const b = approvalKeys({ kind: 'mail_send', payload: send({ to: [{ address: 'x@y|a' }], subject: 'b' }) }, origin()).familyKey;
    expect(a).not.toBe(b);
  });
});

describe('reading', () => {
  it('reads by dedup key in every status until the purge', () => {
    const id = fileOk(replyFiling());
    store.decide(id, { action: 'reject', reason: 'owner' }, 'owner', T0 + H);
    const key = approvalKeys({ kind: 'mail_reply', payload: reply() }, origin()).dedupKey;
    expect(store.listByDedupKey(key).map(e => [e.id, e.status])).toEqual([[id, 'rejected']]);
    store.sweep({ now: T0 + H + APPROVAL_PURGE_AFTER_MS, engineStartedAt: T0, flagOn: true });
    expect(store.listByDedupKey(key)).toEqual([]);
  });

  it('an origin this engine does not know is shown, never approved or claimed, and can still be discarded', () => {
    const id = fileOk(replyFiling());
    approve(id);
    const pendingOne = fileOk(replyFiling({ originalMessageId: '<m5@example.com>' }));
    tamper('UPDATE approval_entries SET origin_json = ? WHERE id IN (?, ?)',
      JSON.stringify({ source: 'inbox', triggerId: 't', runId: 'r', rootRunId: 'r' }), id, pendingOne);

    const e = store.get(id)!;
    expect(e.origin).toBeNull();
    expect(e.executable).toBe(false);
    expect(e.originJson).toContain('inbox');
    expect(store.claim(id, T0 + 2 * H)).toEqual({ ok: false, reason: 'not_executable' });
    expect(store.get(id)!.status).toBe('approved');

    const p = store.get(pendingOne)!;
    expect(store.decide(pendingOne, { action: 'approve', checksum: p.checksum }, 'owner', T0 + H)).toEqual({ ok: false, reason: 'not_executable' });
    expect(store.decide(pendingOne, { action: 'reject', reason: 'owner' }, 'owner', T0 + H)).toEqual({ ok: true });
  });

  it('an origin missing a field, or with an empty one, is not executable either', () => {
    const a = fileOk(replyFiling());
    const b = fileOk(replyFiling({ originalMessageId: '<m6@example.com>' }));
    tamper('UPDATE approval_entries SET origin_json = ? WHERE id = ?', JSON.stringify({ source: 'task', runId: 'r', rootRunId: 'r' }), a);
    tamper('UPDATE approval_entries SET origin_json = ? WHERE id = ?', JSON.stringify({ source: 'task', triggerId: '', runId: 'r', rootRunId: 'r' }), b);
    expect(store.get(a)!.executable).toBe(false);
    expect(store.get(b)!.executable).toBe(false);
  });

  it('a payload that does not fit its kind is not executable', () => {
    const bad: Array<Record<string, unknown>> = [
      { ...reply(), original: {} },
      { ...reply(), to: [{ address: 'a@x.ch', name: 5 }] },
      { ...reply(), inReplyTo: 7 },
      { ...reply(), original: { ...reply().original, to: 'owner@example.com' } },
      { ...reply(), original: { ...reply().original, from: 3 } },
    ];
    for (const payload of bad) {
      const id = fileOk(replyFiling({ originalMessageId: `<bad-${String(bad.indexOf(payload))}>` }));
      tamper('UPDATE approval_entries SET payload_json = ? WHERE id = ?', engine.enc(JSON.stringify(payload)), id);
      expect(store.get(id)!.executable, JSON.stringify(payload)).toBe(false);
    }
  });

  it('a payload that does not decrypt is not executable and fails its checksum', () => {
    const id = fileOk(replyFiling());
    engine.close();
    engine = new EngineDb(join(dir, 'engine.db'), 'another-key');
    store = new ApprovalStore(engine);
    const e = store.get(id)!;
    expect(e.filing).toBeNull();
    expect(e.executable).toBe(false);
    expect(store.checksumMatches(id)).toBe(false);
  });

  it('a result is stored encrypted and read back', () => {
    const id = fileOk(replyFiling());
    approveAndClaim(id);
    store.finish(id, 'failed', { error: '550 <anna@example.com> unknown' }, T0 + H);
    const stored = raw().prepare('SELECT result_json FROM approval_entries WHERE id = ?').get(id) as { result_json: string };
    expect(stored.result_json).toMatch(/^enc:/);
    expect(stored.result_json).not.toContain('anna');
    expect(store.get(id)!.resultJson).toBe('{"error":"550 <anna@example.com> unknown"}');
  });
});

describe('ApprovalStore.decide', () => {
  it('a payload changed after filing fails the checksum and is not approved', () => {
    const id = fileOk(replyFiling());
    const shown = store.get(id)!.checksum;
    tamper('UPDATE approval_entries SET payload_json = ? WHERE id = ?', engine.enc(JSON.stringify(reply({ to: [{ address: 'mallory@example.net' }] }))), id);
    expect(store.checksumMatches(id)).toBe(false);
    expect(store.decide(id, { action: 'approve', checksum: shown }, 'owner', T0 + H)).toEqual({ ok: false, reason: 'checksum' });
    expect(store.get(id)!.status).toBe('pending');
  });

  it('the checksum binds the origin too: an origin changed after filing fails it', () => {
    const id = fileOk(replyFiling());
    const shown = store.get(id)!.checksum;
    tamper('UPDATE approval_entries SET origin_json = ? WHERE id = ?', JSON.stringify(origin({ runId: 'run-other' })), id);
    expect(store.checksumMatches(id)).toBe(false);
    expect(store.decide(id, { action: 'approve', checksum: shown }, 'owner', T0 + H)).toEqual({ ok: false, reason: 'checksum' });
  });

  it('an approval with a checksum other than the stored one is refused', () => {
    const id = fileOk(replyFiling());
    expect(store.decide(id, { action: 'approve', checksum: '0'.repeat(64) }, 'owner', T0 + H)).toEqual({ ok: false, reason: 'checksum' });
  });

  it('approves until the expiry, compared as numbers, and not from it on', () => {
    const a = fileOk(replyFiling());
    const b = fileOk(replyFiling({ originalMessageId: '<m3@example.com>' }));
    const ca = store.get(a)!.checksum;
    const cb = store.get(b)!.checksum;
    expect(store.decide(a, { action: 'approve', checksum: ca }, 'owner', T0 + APPROVAL_TTL_MS - 1)).toEqual({ ok: true });
    expect(store.decide(b, { action: 'approve', checksum: cb }, 'owner', T0 + APPROVAL_TTL_MS)).toEqual({ ok: false, reason: 'expired' });
    expect(store.get(a)).toMatchObject({ status: 'approved', decidedBy: 'owner', decidedAt: new Date(T0 + APPROVAL_TTL_MS - 1).toISOString() });
  });

  it('an expiry that does not parse counts as reached', () => {
    const id = fileOk(replyFiling());
    tamper("UPDATE approval_entries SET expires_at = 'not a time' WHERE id = ?", id);
    expect(store.decide(id, { action: 'approve', checksum: store.get(id)!.checksum }, 'owner', T0 + H)).toEqual({ ok: false, reason: 'expired' });
    expect(store.sweep({ now: T0 + H, engineStartedAt: T0, flagOn: true }).expired).toBe(1);
  });

  it('decides a pending entry once; a rejection is stamped for the purge', () => {
    const id = fileOk(replyFiling());
    expect(store.decide(id, { action: 'reject', reason: 'moved_to_chat' }, 'owner', T0 + H)).toEqual({ ok: true });
    expect(store.get(id)).toMatchObject({ status: 'rejected', decidedReason: 'moved_to_chat', purgeAfter: new Date(T0 + H + APPROVAL_PURGE_AFTER_MS).toISOString() });
    expect(store.decide(id, { action: 'approve', checksum: store.get(id)!.checksum }, 'owner', T0 + H)).toEqual({ ok: false, reason: 'not_pending' });
    expect(store.decide(id, { action: 'clear_unknown' }, 'owner', T0 + H)).toEqual({ ok: false, reason: 'not_unknown' });
    expect(store.decide('nope', { action: 'reject', reason: 'owner' }, 'owner')).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('claim and finish', () => {
  it('only one claim wins, and it counts the attempt', () => {
    const id = fileOk(replyFiling());
    expect(store.claim(id, T0)).toEqual({ ok: false, reason: 'not_claimable' });
    approve(id);
    const first = store.claim(id, T0 + 2 * H);
    expect(first.ok && first.entry).toMatchObject({ status: 'executing', attempts: 1, claimedAt: new Date(T0 + 2 * H).toISOString() });
    expect(store.claim(id, T0 + 2 * H)).toEqual({ ok: false, reason: 'not_claimable' });
  });

  it('an approved entry is not claimed at its expiry, even before the sweep ran', () => {
    const id = fileOk(replyFiling());
    approve(id, T0 + H);
    store.hold(id, 'send_limit', T0 + H);
    expect(store.claim(id, T0 + APPROVAL_TTL_MS)).toEqual({ ok: false, reason: 'expired' });
    expect(store.get(id)!.status).toBe('approved');
    expect(store.claim(id, T0 + APPROVAL_TTL_MS - 1).ok).toBe(true);
  });

  it('three attempts in all: a provably-not-sent failure goes back to approved twice, then ends failed', () => {
    const id = fileOk(replyFiling());
    approve(id);
    for (let i = 1; i <= 2; i++) {
      expect(store.claim(id, T0 + H).ok).toBe(true);
      expect(store.finish(id, 'retry', { reason: 'dedup_window' }, T0 + H)).toBe('approved');
      expect(store.get(id)).toMatchObject({ status: 'approved', attempts: i, claimedAt: null, heldReason: 'retry' });
    }
    expect(store.claim(id, T0 + H).ok).toBe(true);
    expect(store.finish(id, 'retry', { reason: 'dedup_window' }, T0 + H)).toBe('failed');
    expect(store.get(id)).toMatchObject({ status: 'failed', attempts: 3, purgeAfter: new Date(T0 + H + APPROVAL_PURGE_AFTER_MS).toISOString() });
  });

  it('a retried entry outlives the claim window and is claimed again', () => {
    const id = fileOk(replyFiling());
    approve(id, T0 + H);
    store.hold(id, 'send_limit', T0 + H);
    // Held for three hours, then claimed, then refused by the 60-second recipient window.
    expect(store.claim(id, T0 + 4 * H).ok).toBe(true);
    expect(store.finish(id, 'retry', { reason: 'dedup_window' }, T0 + 4 * H)).toBe('approved');
    expect(store.sweep({ now: T0 + 4 * H + 60_000, engineStartedAt: T0, flagOn: true }).expired).toBe(0);
    expect(store.claim(id, T0 + 4 * H + 60_000)).toMatchObject({ ok: true });
  });

  it('an unknown outcome is final, is never retried and is stamped for the purge', () => {
    const id = fileOk(replyFiling());
    endUnknown(id);
    expect(store.claim(id, T0 + 2 * H)).toEqual({ ok: false, reason: 'not_claimable' });
    expect(store.finish(id, 'done', null, T0 + 2 * H)).toBeNull();
    expect(store.get(id)).toMatchObject({ status: 'unknown', purgeAfter: new Date(T0 + H + APPROVAL_PURGE_AFTER_MS).toISOString() });
  });

  it('done records when it was sent and what came back', () => {
    const id = fileOk(replyFiling());
    approveAndClaim(id);
    expect(store.finish(id, 'done', { messageId: '<s@x>' }, T0 + 2 * H)).toBe('done');
    expect(store.get(id)).toMatchObject({ status: 'done', executedAt: new Date(T0 + 2 * H).toISOString(), resultJson: '{"messageId":"<s@x>"}' });
  });

  it('a hold stamps an approved entry and nothing else', () => {
    const id = fileOk(replyFiling());
    expect(store.hold(id, 'send_limit', T0)).toBe(false);
    approve(id);
    expect(store.hold(id, 'send_limit', T0 + 2 * H)).toBe(true);
    expect(store.get(id)).toMatchObject({ status: 'approved', heldReason: 'send_limit', heldAt: new Date(T0 + 2 * H).toISOString() });
  });
});

describe('ApprovalStore.sweep', () => {
  it('expires a pending entry at its expiry, not before, and stamps it for the purge', () => {
    const id = fileOk(replyFiling());
    expect(store.sweep({ now: T0 + APPROVAL_TTL_MS - 1, engineStartedAt: T0, flagOn: true }).expired).toBe(0);
    expect(store.sweep({ now: T0 + APPROVAL_TTL_MS, engineStartedAt: T0, flagOn: true }).expired).toBe(1);
    expect(store.get(id)).toMatchObject({
      status: 'expired', resultJson: '{"reason":"ttl"}', purgeAfter: new Date(T0 + APPROVAL_TTL_MS + APPROVAL_PURGE_AFTER_MS).toISOString(),
    });
    expect((raw().prepare('SELECT result_json FROM approval_entries WHERE id = ?').get(id) as { result_json: string }).result_json).toMatch(/^enc:/);
  });

  it('an approved entry nobody claimed expires after the claim window, counted from the later of decision and engine start', () => {
    const id = fileOk(replyFiling());
    approve(id, T0 + H);
    // The engine restarted two hours after the decision: the window counts from the restart.
    const started = T0 + 3 * H;
    expect(store.sweep({ now: started + APPROVAL_CLAIM_WINDOW_MS - 1, engineStartedAt: started, flagOn: true }).expired).toBe(0);
    expect(store.get(id)!.status).toBe('approved');
    expect(store.sweep({ now: started + APPROVAL_CLAIM_WINDOW_MS, engineStartedAt: started, flagOn: true }).expired).toBe(1);
    expect(store.get(id)).toMatchObject({ status: 'expired', resultJson: '{"reason":"claim_window"}' });
  });

  it('counts the window from the decision when the engine started before it', () => {
    const id = fileOk(replyFiling());
    approve(id, T0 + 5 * H);
    expect(store.sweep({ now: T0 + 5 * H + APPROVAL_CLAIM_WINDOW_MS - 1, engineStartedAt: T0, flagOn: true }).expired).toBe(0);
    expect(store.sweep({ now: T0 + 5 * H + APPROVAL_CLAIM_WINDOW_MS, engineStartedAt: T0, flagOn: true }).expired).toBe(1);
    expect(store.get(id)!.status).toBe('expired');
  });

  it('an approved entry expires at its expiry even when a restart moved the claim window past it', () => {
    const id = fileOk(replyFiling());
    approve(id, T0 + APPROVAL_TTL_MS - H);
    const started = T0 + APPROVAL_TTL_MS - H / 2;
    expect(store.sweep({ now: T0 + APPROVAL_TTL_MS - 1, engineStartedAt: started, flagOn: true }).expired).toBe(0);
    expect(store.sweep({ now: T0 + APPROVAL_TTL_MS, engineStartedAt: started, flagOn: true }).expired).toBe(1);
    expect(store.get(id)!.status).toBe('expired');
  });

  it('an approved entry that expires while the queue is off says so', () => {
    const id = fileOk(replyFiling());
    approve(id, T0 + H);
    store.sweep({ now: T0 + H + APPROVAL_CLAIM_WINDOW_MS, engineStartedAt: T0, flagOn: false });
    expect(store.get(id)).toMatchObject({ status: 'expired', resultJson: '{"reason":"flag_off"}' });
  });

  it('a held entry outlives the claim window and expires at its expiry with the hold reason', () => {
    const id = fileOk(replyFiling());
    approve(id, T0 + H);
    store.hold(id, 'send_limit', T0 + H);
    expect(store.sweep({ now: T0 + APPROVAL_TTL_MS - 1, engineStartedAt: T0, flagOn: true }).expired).toBe(0);
    expect(store.get(id)!.status).toBe('approved');
    expect(store.sweep({ now: T0 + APPROVAL_TTL_MS, engineStartedAt: T0, flagOn: true }).expired).toBe(1);
    expect(store.get(id)).toMatchObject({ status: 'expired', resultJson: '{"reason":"send_limit"}' });
  });

  it('a stale claim becomes unknown, is stamped for the purge, and the same mail is then refused as unknown', () => {
    const id = fileOk(replyFiling());
    approveAndClaim(id);
    expect(store.sweep({ now: T0 + H + APPROVAL_CLAIM_STALE_MS - 1, engineStartedAt: T0, flagOn: true }).unknown).toBe(0);
    const at = T0 + H + APPROVAL_CLAIM_STALE_MS;
    expect(store.sweep({ now: at, engineStartedAt: T0, flagOn: true }).unknown).toBe(1);
    expect(store.get(id)).toMatchObject({
      status: 'unknown', resultJson: '{"reason":"stale_claim"}', purgeAfter: new Date(at + APPROVAL_PURGE_AFTER_MS).toISOString(),
    });
    expect(store.file(replyFiling({}, T0 + 2 * H))).toEqual({ ok: false, reason: 'unknown', existingId: id });
  });

  it('a decision or claim time that does not parse ends the entry instead of stopping the sweep', () => {
    const decided = fileOk(replyFiling());
    approve(decided);
    raw().prepare("UPDATE approval_entries SET decided_at = 'garbage' WHERE id = ?").run(decided);
    const claimed = fileOk(replyFiling({ originalMessageId: '<m8@example.com>' }));
    approveAndClaim(claimed);
    raw().prepare('UPDATE approval_entries SET claimed_at = NULL WHERE id = ?').run(claimed);
    expect(store.sweep({ now: T0 + H, engineStartedAt: T0, flagOn: true })).toMatchObject({ expired: 1, unknown: 1 });
    expect(store.get(decided)!.status).toBe('expired');
    expect(store.get(claimed)!.status).toBe('unknown');
  });

  it('deletes an ended entry at its purge date, not before', () => {
    const ended = fileOk(replyFiling());
    store.decide(ended, { action: 'reject', reason: 'owner' }, 'owner', T0);
    expect(store.sweep({ now: T0 + APPROVAL_PURGE_AFTER_MS - 1, engineStartedAt: T0, flagOn: true }).purged).toBe(0);
    expect(store.get(ended)).not.toBeNull();
    expect(store.sweep({ now: T0 + APPROVAL_PURGE_AFTER_MS, engineStartedAt: T0, flagOn: true }).purged).toBe(1);
    expect(store.get(ended)).toBeNull();
  });

  it('an unknown entry becomes a tombstone at its purge date: no content, still refusing the same mail', () => {
    const id = fileOk(sendFiling());
    endUnknown(id);
    const at = T0 + H + APPROVAL_PURGE_AFTER_MS;
    expect(store.sweep({ now: at - 1, engineStartedAt: T0, flagOn: true }).tombstoned).toBe(0);
    expect(store.sweep({ now: at, engineStartedAt: T0, flagOn: true })).toMatchObject({ tombstoned: 1, purged: 0 });
    const row = raw().prepare('SELECT * FROM approval_entries WHERE id = ?').get(id) as Record<string, unknown>;
    expect(row).toMatchObject({ status: 'unknown', payload_json: '', result_json: null, purge_after: null, tombstoned_at: new Date(at).toISOString() });
    expect(row['dedup_key']).toMatch(/^[0-9a-f]{64}$/);
    expect(row['family_key']).toMatch(/^[0-9a-f]{64}$/);
    expect(store.get(id)).toMatchObject({ status: 'unknown', filing: null, executable: false, resultJson: null });
    expect(store.checksumMatches(id)).toBe(false);
    // Nothing acts on it but clearing.
    expect(store.decide(id, { action: 'approve', checksum: row['checksum'] as string }, 'owner', at)).toEqual({ ok: false, reason: 'not_pending' });
    expect(store.decide(id, { action: 'reject', reason: 'owner' }, 'owner', at)).toEqual({ ok: false, reason: 'not_pending' });
    expect(store.claim(id, at)).toEqual({ ok: false, reason: 'not_claimable' });
    expect(store.finish(id, 'done', null, at)).toBeNull();
    expect(store.hold(id, 'send_limit', at)).toBe(false);
    // A later sweep leaves it, and it still blocks the same mail and its family.
    expect(store.sweep({ now: at + 365 * D, engineStartedAt: T0, flagOn: true })).toMatchObject({ tombstoned: 0, purged: 0 });
    expect(store.file(sendFiling({}, at + 365 * D))).toEqual({ ok: false, reason: 'unknown', existingId: id });
    expect(store.file(sendFiling({ bodyText: 'neu' }, at + 365 * D, { runId: 'run-9' }))).toEqual({ ok: false, reason: 'unknown', existingId: id });
  });

  it('clearing takes only an unknown row, even one a writer outside the store marked as a tombstone', () => {
    const id = fileOk(replyFiling());
    store.decide(id, { action: 'reject', reason: 'owner' }, 'owner', T0 + H);
    raw().prepare("UPDATE approval_entries SET tombstoned_at = ? WHERE id = ?").run(new Date(T0 + H).toISOString(), id);
    expect(store.decide(id, { action: 'clear_unknown' }, 'owner', T0 + 2 * H)).toEqual({ ok: false, reason: 'not_unknown' });
    expect(store.get(id)!.status).toBe('rejected');
  });

  it('clearing a tombstone deletes the row, and the mail may be filed again', () => {
    const id = fileOk(replyFiling());
    endUnknown(id);
    store.sweep({ now: T0 + H + APPROVAL_PURGE_AFTER_MS, engineStartedAt: T0, flagOn: true });
    expect(store.decide(id, { action: 'clear_unknown' }, 'owner', T0 + 40 * D)).toEqual({ ok: true });
    expect(raw().prepare('SELECT COUNT(*) AS c FROM approval_entries WHERE id = ?').get(id)).toEqual({ c: 0 });
    expect(store.file(replyFiling({}, T0 + 40 * D)).ok).toBe(true);
  });

  it('without a vault key an unknown entry is no tombstone: it is deleted at its purge date', () => {
    const plain = new EngineDb(join(dir, 'plain.db'), '');
    const s = new ApprovalStore(plain);
    const id = fileOk(replyFiling(), s);
    const e = s.get(id)!;
    expect(s.decide(id, { action: 'approve', checksum: e.checksum }, 'owner', T0 + H)).toEqual({ ok: true });
    expect(s.claim(id, T0 + H).ok).toBe(true);
    s.finish(id, 'unknown', null, T0 + H);
    expect(s.sweep({ now: T0 + H + APPROVAL_PURGE_AFTER_MS, engineStartedAt: T0, flagOn: true })).toMatchObject({ tombstoned: 0, purged: 1 });
    expect(s.get(id)).toBeNull();
    plain.close();
  });
});

describe('approvalQueueEnabled', () => {
  const prev = process.env['LYNOX_FEATURE_APPROVAL_QUEUE'];
  afterEach(() => {
    if (prev === undefined) delete process.env['LYNOX_FEATURE_APPROVAL_QUEUE'];
    else process.env['LYNOX_FEATURE_APPROVAL_QUEUE'] = prev;
  });

  it('is off by default and on when the instance turns it on', () => {
    delete process.env['LYNOX_FEATURE_APPROVAL_QUEUE'];
    expect(approvalQueueEnabled()).toBe(false);
    process.env['LYNOX_FEATURE_APPROVAL_QUEUE'] = '1';
    expect(approvalQueueEnabled()).toBe(true);
  });
});
