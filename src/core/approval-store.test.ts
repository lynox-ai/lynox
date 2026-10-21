import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

function fileOk(input: FileApprovalInput): string {
  const r = store.file(input);
  if (!r.ok) throw new Error(`filing refused: ${r.reason}`);
  return r.id;
}

/** Approve an entry the way the decide route will: with the checksum the owner was shown. */
function approve(id: string, now = T0 + H): void {
  const e = store.get(id)!;
  expect(store.decide(id, { action: 'approve', checksum: e.checksum }, 'owner', now)).toEqual({ ok: true });
}

const raw = (): Database.Database => engine.getDb();

describe('approval_entries migration (v48)', () => {
  it('a fresh database has the table, its indexes and version 48', () => {
    const indexes = raw().prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'approval_entries' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    expect(indexes).toEqual([
      { name: 'idx_approval_entries_active' }, { name: 'idx_approval_entries_dedup' }, { name: 'idx_approval_entries_family' },
      { name: 'idx_approval_entries_purge' }, { name: 'idx_approval_entries_status' },
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
    const s = new ApprovalStore(migrated);
    const id = s.file(replyFiling());
    expect(id.ok).toBe(true);
    migrated.close();

    // A restart does not migrate again, and the entry is still there.
    const again = new EngineDb(path, 'test-vault-key');
    expect(again.getDb().prepare('SELECT COUNT(*) AS c FROM schema_version WHERE version = 48').get()).toEqual({ c: 1 });
    expect(again.getDb().prepare('SELECT COUNT(*) AS c FROM approval_entries').get()).toEqual({ c: 1 });
    again.close();
  });

  it('the database itself makes two waiting entries with one key one, but lets an ended one stand beside a new one', () => {
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
});

describe('ApprovalStore.file', () => {
  it('inserts a pending entry with a checksum, a 72-hour expiry, the payload encrypted and the keys hashed', () => {
    const id = fileOk(replyFiling());
    const e = store.get(id)!;
    expect(e).toMatchObject({
      kind: 'mail_reply', status: 'pending', executable: true, binding: 'keyed', attempts: 0,
      createdAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + APPROVAL_TTL_MS).toISOString(),
      createdBy: 'owner', mandateId: null, decidedAt: null, claimedAt: null, purgeAfter: null,
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

  it('a mail_send entry carries a hashed family key', () => {
    const id = fileOk(sendFiling());
    const row = raw().prepare('SELECT family_key FROM approval_entries WHERE id = ?').get(id) as { family_key: string | null };
    expect(row.family_key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('without a vault key the checksum is unkeyed and says so', () => {
    const plain = new EngineDb(join(dir, 'plain.db'), '');
    const s = new ApprovalStore(plain);
    const r = s.file(replyFiling());
    expect(r.ok && s.get(r.id)?.binding).toBe('unkeyed');
    plain.close();
  });

  it('refuses the same reply while one waits, and says it waits', () => {
    const first = fileOk(replyFiling());
    expect(store.file(replyFiling({ bodyText: 'Eine andere Fassung.' }, T0 + H))).toEqual({ ok: false, reason: 'waiting', existingId: first });
    approve(first);
    expect(store.file(replyFiling({}, T0 + 2 * H))).toEqual({ ok: false, reason: 'waiting', existingId: first });
    store.claim(first, T0 + 2 * H);
    expect(store.file(replyFiling({}, T0 + 2 * H))).toEqual({ ok: false, reason: 'waiting', existingId: first });
  });

  it('refuses a reply whose earlier outcome is unknown, at any age, and says so', () => {
    const first = fileOk(replyFiling());
    approve(first);
    store.claim(first, T0 + H);
    expect(store.finish(first, 'unknown', { error: 'connection lost' }, T0 + H)).toBe('unknown');
    expect(store.file(replyFiling({}, T0 + 20 * D))).toEqual({ ok: false, reason: 'unknown', existingId: first });
  });

  it('a reply to another message of the same conversation is a different entry', () => {
    fileOk(replyFiling());
    expect(store.file(replyFiling({ originalMessageId: '<m2@example.com>', originalFolderUid: 'INBOX:42' })).ok).toBe(true);
  });

  it('refuses a reply sent within 14 days, and takes it after', () => {
    const first = fileOk(replyFiling());
    approve(first);
    store.claim(first, T0 + H);
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
    approve(lost);
    store.claim(lost, T0 + H);
    store.finish(lost, 'unknown', null, T0 + H);
    expect(store.decide(lost, { action: 'clear_unknown' }, 'owner', T0 + 2 * H)).toEqual({ ok: true });
    expect(store.get(lost)).toMatchObject({ status: 'rejected', decidedReason: 'cleared_unknown' });
    expect(store.file(replyFiling(other, T0 + 3 * H)).ok).toBe(true);
  });

  it('a failed or expired entry does not refuse the same mail again', () => {
    const failed = fileOk(replyFiling());
    approve(failed);
    store.claim(failed, T0 + H);
    store.finish(failed, 'failed', { reason: 'account changed' }, T0 + H);
    expect(store.file(replyFiling({}, T0 + 2 * H)).ok).toBe(true);

    const o = { originalMessageId: '<m7@example.com>' };
    fileOk(replyFiling(o));
    store.sweep({ now: T0 + APPROVAL_TTL_MS, engineStartedAt: T0, flagOn: true });
    expect(store.file(replyFiling(o, T0 + APPROVAL_TTL_MS)).ok).toBe(true);
  });

  it('mail_send: one run may file two different mails; a sent or discarded one refuses its family for 24 hours', () => {
    const a = fileOk(sendFiling());
    expect(store.file(sendFiling({ bodyText: 'Ein anderer Text.' })).ok).toBe(true);
    expect(store.file(sendFiling())).toEqual({ ok: false, reason: 'waiting', existingId: a });

    approve(a);
    store.claim(a, T0 + H);
    store.finish(a, 'done', null, T0 + H);
    // The next cron run drafts the same mail anew: new run id, new body, same recipients and subject.
    const next = sendFiling({ bodyText: 'Der Bericht, neu.', to: [{ address: 'bob@example.com ' }], subject: ' wochenbericht' }, T0 + 2 * H, { runId: 'run-2', rootRunId: 'run-2' });
    expect(store.file(next)).toEqual({ ok: false, reason: 'sent', existingId: a });
    const later = { ...next, now: T0 + H + APPROVAL_DEDUP_WINDOW_MS.mail_send };
    expect(store.file(later).ok).toBe(true);
  });

  it('mail_send: a discarded mail refuses its family, another account is another family', () => {
    const a = fileOk(sendFiling());
    store.decide(a, { action: 'reject', reason: 'moved_to_chat' }, 'owner', T0 + H);
    expect(store.file(sendFiling({ bodyText: 'neu' }, T0 + 2 * H, { runId: 'run-3' }))).toEqual({ ok: false, reason: 'discarded', existingId: a });
    expect(store.file(sendFiling({ accountId: 'acc-2' }, T0 + 2 * H, { runId: 'run-3' })).ok).toBe(true);
  });
});

describe('approvalKeys', () => {
  it('a reply is keyed by the replied-to message, else by folder and uid', () => {
    expect(approvalKeys({ kind: 'mail_reply', payload: reply() }, origin()).dedupKey).toBe('mail_reply|acc-1|<m1@example.com>');
    expect(approvalKeys({ kind: 'mail_reply', payload: reply({ originalMessageId: undefined }) }, origin()).dedupKey).toBe('mail_reply|acc-1|INBOX:41');
  });

  it('a send is keyed by its event before its run, with sorted recipients and the normalised subject', () => {
    const k = approvalKeys({ kind: 'mail_send', payload: send({ cc: [{ address: 'a@x.ch' }] }) }, origin({ eventId: 'ev-9' }));
    expect(k.dedupKey).toMatch(/^mail_send\|ev-9\|a@x\.ch,bob@example\.com\|wochenbericht\|[0-9a-f]{64}$/);
    expect(k.familyKey).toBe('mail_send|acc-1|a@x.ch,bob@example.com|wochenbericht');
    expect(approvalKeys({ kind: 'mail_send', payload: send() }, origin()).dedupKey).toMatch(/^mail_send\|run-1\|/);
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
    raw().prepare('UPDATE approval_entries SET origin_json = ? WHERE id IN (?, ?)').run(
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

  it('an origin missing a field is not executable either', () => {
    const id = fileOk(replyFiling());
    raw().prepare('UPDATE approval_entries SET origin_json = ? WHERE id = ?').run(JSON.stringify({ source: 'task', runId: 'r', rootRunId: 'r' }), id);
    expect(store.get(id)!.executable).toBe(false);
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
});

describe('ApprovalStore.decide', () => {
  it('a payload changed after filing fails the checksum and is not approved', () => {
    const id = fileOk(replyFiling());
    const shown = store.get(id)!.checksum;
    const changed = engine.enc(JSON.stringify(reply({ to: [{ address: 'mallory@example.net' }] })));
    raw().prepare('UPDATE approval_entries SET payload_json = ? WHERE id = ?').run(changed, id);
    expect(store.checksumMatches(id)).toBe(false);
    expect(store.decide(id, { action: 'approve', checksum: shown }, 'owner', T0 + H)).toEqual({ ok: false, reason: 'checksum' });
    expect(store.get(id)!.status).toBe('pending');
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

  it('a provably-not-sent failure goes back to approved, three times, then ends failed', () => {
    const id = fileOk(replyFiling());
    approve(id);
    for (let i = 1; i <= 2; i++) {
      expect(store.claim(id, T0 + H).ok).toBe(true);
      expect(store.finish(id, 'retry', { reason: 'dedup_window' }, T0 + H)).toBe('approved');
      expect(store.get(id)).toMatchObject({ status: 'approved', attempts: i, claimedAt: null });
    }
    expect(store.claim(id, T0 + H).ok).toBe(true);
    expect(store.finish(id, 'retry', { reason: 'dedup_window' }, T0 + H)).toBe('failed');
    expect(store.get(id)).toMatchObject({ status: 'failed', attempts: 3 });
  });

  it('an unknown outcome is final, is never retried and is stamped for the purge', () => {
    const id = fileOk(replyFiling());
    approve(id);
    store.claim(id, T0 + H);
    expect(store.finish(id, 'unknown', null, T0 + H)).toBe('unknown');
    expect(store.claim(id, T0 + 2 * H)).toEqual({ ok: false, reason: 'not_claimable' });
    expect(store.finish(id, 'done', null, T0 + 2 * H)).toBeNull();
    expect(store.get(id)).toMatchObject({ status: 'unknown', purgeAfter: new Date(T0 + H + APPROVAL_PURGE_AFTER_MS).toISOString() });
  });

  it('done records when it was sent and what came back', () => {
    const id = fileOk(replyFiling());
    approve(id);
    store.claim(id, T0 + H);
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
  it('expires a pending entry at its expiry, not before', () => {
    const id = fileOk(replyFiling());
    expect(store.sweep({ now: T0 + APPROVAL_TTL_MS - 1, engineStartedAt: T0, flagOn: true }).expired).toBe(0);
    expect(store.sweep({ now: T0 + APPROVAL_TTL_MS, engineStartedAt: T0, flagOn: true }).expired).toBe(1);
    expect(store.get(id)).toMatchObject({ status: 'expired', resultJson: '{"reason":"ttl"}' });
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

  it('a stale claim becomes unknown, and the same mail is then refused as unknown', () => {
    const id = fileOk(replyFiling());
    approve(id);
    store.claim(id, T0 + H);
    expect(store.sweep({ now: T0 + H + APPROVAL_CLAIM_STALE_MS - 1, engineStartedAt: T0, flagOn: true }).unknown).toBe(0);
    expect(store.sweep({ now: T0 + H + APPROVAL_CLAIM_STALE_MS + 1, engineStartedAt: T0, flagOn: true }).unknown).toBe(1);
    expect(store.get(id)).toMatchObject({ status: 'unknown', resultJson: '{"reason":"stale_claim"}' });
    expect(store.file(replyFiling({}, T0 + 2 * H))).toEqual({ ok: false, reason: 'unknown', existingId: id });
  });

  it('deletes an entry at its purge date, not before, and leaves a pending one alone', () => {
    const ended = fileOk(replyFiling());
    store.decide(ended, { action: 'reject', reason: 'owner' }, 'owner', T0);
    const waiting = fileOk(replyFiling({ originalMessageId: '<m4@example.com>' }));
    expect(store.sweep({ now: T0 + APPROVAL_PURGE_AFTER_MS - 1, engineStartedAt: T0 + APPROVAL_PURGE_AFTER_MS, flagOn: true }).purged).toBe(0);
    const counts = store.sweep({ now: T0 + APPROVAL_PURGE_AFTER_MS, engineStartedAt: T0 + APPROVAL_PURGE_AFTER_MS, flagOn: true });
    expect(counts.purged).toBe(1);
    expect(store.get(ended)).toBeNull();
    expect(store.get(waiting)!.status).toBe('expired');
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
