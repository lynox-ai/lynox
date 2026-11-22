import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MailStateDb } from './state.js';
import type { MailAddress } from './provider.js';

/**
 * Whether a sent mail went only to recipients the owner had named (`origin_owner_known`, v22),
 * and the read that answers "was this address such a recipient?" over to, cc and bcc.
 */

const ACCOUNT = {
  id: 'acct', displayName: 'Me', address: 'me@x.example', preset: 'custom' as const,
  imap: { host: 'imap', port: 993, secure: true }, smtp: { host: 'smtp', port: 465, secure: true },
  authType: 'imap' as const, type: 'personal' as const, isDefault: true,
};

let db: MailStateDb;

function send(recipients: { to?: MailAddress[]; cc?: MailAddress[]; bcc?: MailAddress[] }, originOwnerKnown?: boolean): void {
  db.recordSentMail({
    accountId: 'acct',
    messageId: `<${String(Math.random())}@x>`,
    to: recipients.to ?? [],
    cc: recipients.cc,
    bcc: recipients.bcc,
    subject: 's',
    bodyChars: 1,
    ...(originOwnerKnown === undefined ? {} : { originOwnerKnown }),
  });
}

beforeEach(() => {
  db = new MailStateDb({ path: ':memory:' });
  db.upsertAccount(ACCOUNT);
});

afterEach(() => {
  db.close();
});

describe('mail_sent_log.origin_owner_known', () => {
  const flags = (): number[] =>
    ((db as unknown as { db: BetterSqlite3.Database }).db
      .prepare('SELECT origin_owner_known AS f FROM mail_sent_log ORDER BY rowid').all() as Array<{ f: number }>).map((r) => r.f);

  it('is written as given, and 0 when the caller says nothing', () => {
    send({ to: [{ address: 'a@firma.ch' }] }, true);
    send({ to: [{ address: 'b@firma.ch' }] }, false);
    send({ to: [{ address: 'c@firma.ch' }] });
    expect(flags()).toEqual([1, 0, 0]);
  });
});

describe('isOwnerKnownRecipient', () => {
  it('finds a recipient of an owner-known send in to, cc and bcc', () => {
    send({ to: [{ address: 'to@firma.ch' }], cc: [{ address: 'cc@firma.ch' }], bcc: [{ address: 'bcc@firma.ch' }] }, true);
    expect(db.isOwnerKnownRecipient('to@firma.ch')).toBe(true);
    expect(db.isOwnerKnownRecipient('cc@firma.ch')).toBe(true);
    expect(db.isOwnerKnownRecipient('bcc@firma.ch')).toBe(true);
  });

  it('does not count a send the owner did not name every recipient of', () => {
    send({ to: [{ address: 'anna@firma.ch' }] }, false);
    send({ bcc: [{ address: 'bob@firma.ch' }] });
    expect(db.isOwnerKnownRecipient('anna@firma.ch')).toBe(false);
    expect(db.isOwnerKnownRecipient('bob@firma.ch')).toBe(false);
  });

  it('compares whole addresses, never substrings', () => {
    send({ to: [{ address: 'max@firma.ch' }] }, true);
    expect(db.isOwnerKnownRecipient('x@firma.ch')).toBe(false);
    expect(db.isOwnerKnownRecipient('max@firma.c')).toBe(false);
    expect(db.isOwnerKnownRecipient('ax@firma.ch')).toBe(false);
    expect(db.isOwnerKnownRecipient('max@firma.ch')).toBe(true);
  });

  it('normalizes case and an international domain on both sides', () => {
    send({ to: [{ address: 'Anna@Müller.CH', name: 'Anna' }] }, true);
    expect(db.isOwnerKnownRecipient('anna@xn--mller-kva.ch')).toBe(true);
    expect(db.isOwnerKnownRecipient('ANNA@müller.ch')).toBe(true);
  });

  it('never knows an address that does not read as one', () => {
    send({ to: [{ address: 'anna@firma.ch' }] }, true);
    expect(db.isOwnerKnownRecipient('')).toBe(false);
    expect(db.isOwnerKnownRecipient('firma.ch')).toBe(false);
  });

  it('answers from the recipient table with one probe, not from the log rows', () => {
    send({ to: [{ address: 'anna@firma.ch' }] }, true);
    const conn = (db as unknown as { db: BetterSqlite3.Database }).db;
    expect(conn.prepare('SELECT tenant_id, address FROM mail_sent_owner_known').all()).toEqual([{ tenant_id: 'default', address: 'anna@firma.ch' }]);
    // The log row alone does not answer: without its recipient row the address is not known.
    conn.exec('DELETE FROM mail_sent_owner_known');
    expect(db.isOwnerKnownRecipient('anna@firma.ch')).toBe(false);
    // And the plan names the index, so the probe does not scan.
    const plan = conn.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM mail_sent_owner_known r JOIN mail_sent_log l ON l.id = r.sent_id
      WHERE r.tenant_id = ? AND r.address = ? AND l.origin_owner_known = 1 LIMIT 1`).all('default', 'anna@firma.ch') as Array<{ detail: string }>;
    expect(plan.map((r) => r.detail).join(' | ')).toMatch(/idx_mail_sent_owner_known_address/);
  });

  it('writes no recipient row for a send that is not flagged, and needs the log row flagged', () => {
    send({ to: [{ address: 'anna@firma.ch' }] }, false);
    const conn = (db as unknown as { db: BetterSqlite3.Database }).db;
    expect(conn.prepare('SELECT COUNT(*) AS n FROM mail_sent_owner_known').get()).toEqual({ n: 0 });
    send({ to: [{ address: 'bob@firma.ch' }] }, true);
    conn.exec('UPDATE mail_sent_log SET origin_owner_known = 0');
    expect(db.isOwnerKnownRecipient('bob@firma.ch')).toBe(false);
  });

  it('is scoped to the tenant', () => {
    send({ to: [{ address: 'anna@firma.ch' }] }, true);
    expect(db.isOwnerKnownRecipient('anna@firma.ch', { tenantId: 'other' })).toBe(false);
  });
});

describe('migration v22', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lynox-mail-v22-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('adds the column with 0 on every row sent before it', () => {
    const path = join(dir, 'mail-state.db');
    const fresh = new MailStateDb({ path });
    fresh.upsertAccount(ACCOUNT);
    fresh.recordSentMail({ accountId: 'acct', messageId: '<old@x>', to: [{ address: 'anna@firma.ch' }], subject: 's', bodyChars: 1, originOwnerKnown: true });
    fresh.close();
    const raw = new BetterSqlite3(path);
    raw.exec('DROP TABLE mail_sent_owner_known; DELETE FROM schema_version WHERE version = 23; ALTER TABLE mail_sent_log DROP COLUMN origin_owner_known; DELETE FROM schema_version WHERE version = 22;');
    raw.close();

    const migrated = new MailStateDb({ path });
    try {
      const conn = (migrated as unknown as { db: BetterSqlite3.Database }).db;
      expect((conn.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(23);
      expect(conn.prepare('SELECT origin_owner_known AS f FROM mail_sent_log').all()).toEqual([{ f: 0 }]);
      expect(migrated.isOwnerKnownRecipient('anna@firma.ch')).toBe(false);
    } finally {
      migrated.close();
    }
  });
});

describe('the log row and its owner-known recipients are written together', () => {
  const raw = (): BetterSqlite3.Database => (db as unknown as { db: BetterSqlite3.Database }).db;
  it('a recipient row that cannot be written takes the log row with it', () => {
    raw().exec("CREATE TRIGGER fail_recipient BEFORE INSERT ON mail_sent_owner_known BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    expect(() => send({ to: [{ address: 'a@firma.ch' }] }, true)).toThrow('disk full');
    expect(raw().prepare('SELECT COUNT(*) AS n FROM mail_sent_log').get()).toEqual({ n: 0 });
  });

  it('CONTROL: a send that is not flagged writes no recipient row, so the same failure does not touch it', () => {
    raw().exec("CREATE TRIGGER fail_recipient BEFORE INSERT ON mail_sent_owner_known BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    send({ to: [{ address: 'a@firma.ch' }] }, false);
    expect(raw().prepare('SELECT COUNT(*) AS n FROM mail_sent_log').get()).toEqual({ n: 1 });
  });
});
