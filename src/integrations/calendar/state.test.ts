// Tests for the calendar-state DB. Runs against `:memory:` SQLite so each
// test gets a clean schema. Focuses on the invariants /pr-review flagged
// as critical (PRD §K1/§K4/§S12/§S4):
//
//   • UNIQUE-partial-index on is_default_writable holds across swaps
//   • dropAccount cascades to cache + poll-state
//   • upsertEvent / recordPollFailure are idempotent + race-safe
//   • setDefaultWritable(null) clears the flag

import { describe, expect, it, beforeEach } from 'vitest';
import { CalendarStateDb } from './state.js';

let db: CalendarStateDb;

beforeEach(() => {
  db = new CalendarStateDb(':memory:');
});

describe('createAccount + getAccount', () => {
  it('round-trips a CalDAV account with all optional fields', () => {
    const created = db.createAccount({
      provider: 'caldav',
      display_name: 'Privat',
      server_url: 'https://caldav.example.com/',
      username: 'rafael',
      preset_slug: 'icloud',
      enabled_calendars: ['Home', 'Work'],
      default_calendar: 'Home',
      timezone: 'Europe/Zurich',
    });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    const fetched = db.getAccount(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.display_name).toBe('Privat');
    expect(fetched?.enabled_calendars).toEqual(['Home', 'Work']);
    expect(fetched?.preset_slug).toBe('icloud');
  });

  it('accepts a caller-supplied UUID (PRD §S12 — vault-first ordering)', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const created = db.createAccount({
      id,
      provider: 'ics-feed',
      display_name: 'Google work',
    });
    expect(created.id).toBe(id);
  });

  it('returns null on getAccount for unknown id', () => {
    expect(db.getAccount('00000000-0000-4000-8000-000000000099')).toBeNull();
  });
});

describe('setDefaultWritable — UNIQUE partial index (PRD §K1)', () => {
  it('only one account can hold the flag at a time', () => {
    const a = db.createAccount({ provider: 'caldav', display_name: 'A' });
    const b = db.createAccount({ provider: 'caldav', display_name: 'B' });

    db.setDefaultWritable(a.id);
    expect(db.getAccount(a.id)?.is_default_writable).toBe(true);
    expect(db.getAccount(b.id)?.is_default_writable).toBeUndefined();

    // Swap — must clear A and set B in one transaction.
    db.setDefaultWritable(b.id);
    expect(db.getAccount(a.id)?.is_default_writable).toBeUndefined();
    expect(db.getAccount(b.id)?.is_default_writable).toBe(true);
  });

  it('setDefaultWritable(null) clears the flag entirely', () => {
    const a = db.createAccount({ provider: 'caldav', display_name: 'A' });
    db.setDefaultWritable(a.id);
    db.setDefaultWritable(null);
    expect(db.getAccount(a.id)?.is_default_writable).toBeUndefined();
  });
});

describe('dropAccount — FK cascade + atomicity (PRD §S12)', () => {
  it('deletes cache + poll-state rows when account is dropped', () => {
    const a = db.createAccount({ provider: 'ics-feed', display_name: 'A' });
    db.upsertEvent(a.id, 'event-1', null, '{"summary":"x"}');
    db.upsertEvent(a.id, 'event-2', 'etag-xyz', '{"summary":"y"}');
    db.recordPollSuccess(a.id, 'etag-abc', 'Wed, 13 Mar 2026 12:00:00 GMT');

    db.dropAccount(a.id);

    expect(db.getAccount(a.id)).toBeNull();
    // Re-query the raw DB through internalGetDb to verify cascade fully ran.
    const raw = db.internalGetDb();
    const cacheRows = raw.prepare('SELECT COUNT(*) as n FROM calendar_event_cache').get() as { n: number };
    const pollRows = raw.prepare('SELECT COUNT(*) as n FROM calendar_poll_state').get() as { n: number };
    expect(cacheRows.n).toBe(0);
    expect(pollRows.n).toBe(0);
  });

  it('dropAccount on unknown id is a no-op (idempotent)', () => {
    db.dropAccount('00000000-0000-4000-8000-000000000099');
    // Should not throw.
    expect(db.listAccounts()).toEqual([]);
  });
});

describe('upsertEvent + removeEvent', () => {
  it('upsert replaces existing rows by (account_id, event_uid)', () => {
    const a = db.createAccount({ provider: 'ics-feed', display_name: 'A' });
    db.upsertEvent(a.id, 'uid-1', 'etag-1', '{"v":1}');
    db.upsertEvent(a.id, 'uid-1', 'etag-2', '{"v":2}');

    const row = db.internalGetDb()
      .prepare('SELECT etag, payload FROM calendar_event_cache WHERE account_id = ? AND event_uid = ?')
      .get(a.id, 'uid-1') as { etag: string; payload: string };
    expect(row.etag).toBe('etag-2');
    expect(row.payload).toBe('{"v":2}');
  });

  it('removeEvent deletes only the targeted row', () => {
    const a = db.createAccount({ provider: 'ics-feed', display_name: 'A' });
    db.upsertEvent(a.id, 'uid-1', null, '{}');
    db.upsertEvent(a.id, 'uid-2', null, '{}');
    db.removeEvent(a.id, 'uid-1');

    const rows = db.internalGetDb()
      .prepare('SELECT event_uid FROM calendar_event_cache WHERE account_id = ?')
      .all(a.id) as Array<{ event_uid: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_uid).toBe('uid-2');
  });
});

describe('recordPollFailure — race-safe UPSERT (PRD §K6)', () => {
  it('first failure inserts with consecutive_failures=1 and NULL circuit', () => {
    const a = db.createAccount({ provider: 'ics-feed', display_name: 'A' });
    db.recordPollFailure(a.id, { threshold: 3, pauseMs: 60_000 });
    const row = db.internalGetDb()
      .prepare('SELECT consecutive_failures, circuit_open_until FROM calendar_poll_state WHERE account_id = ?')
      .get(a.id) as { consecutive_failures: number; circuit_open_until: string | null };
    expect(row.consecutive_failures).toBe(1);
    expect(row.circuit_open_until).toBeNull();
  });

  it('trips circuit on the Nth failure (threshold=3)', () => {
    const a = db.createAccount({ provider: 'ics-feed', display_name: 'A' });
    db.recordPollFailure(a.id, { threshold: 3, pauseMs: 60_000 });
    db.recordPollFailure(a.id, { threshold: 3, pauseMs: 60_000 });
    let row = db.internalGetDb()
      .prepare('SELECT consecutive_failures, circuit_open_until FROM calendar_poll_state WHERE account_id = ?')
      .get(a.id) as { consecutive_failures: number; circuit_open_until: string | null };
    expect(row.consecutive_failures).toBe(2);
    expect(row.circuit_open_until).toBeNull();

    db.recordPollFailure(a.id, { threshold: 3, pauseMs: 60_000 });
    row = db.internalGetDb()
      .prepare('SELECT consecutive_failures, circuit_open_until FROM calendar_poll_state WHERE account_id = ?')
      .get(a.id) as { consecutive_failures: number; circuit_open_until: string | null };
    expect(row.consecutive_failures).toBe(3);
    expect(row.circuit_open_until).not.toBeNull();
  });

  it('recordPollSuccess resets failure counter + clears circuit', () => {
    const a = db.createAccount({ provider: 'ics-feed', display_name: 'A' });
    db.recordPollFailure(a.id, { threshold: 3, pauseMs: 60_000 });
    db.recordPollFailure(a.id, { threshold: 3, pauseMs: 60_000 });
    db.recordPollFailure(a.id, { threshold: 3, pauseMs: 60_000 });

    db.recordPollSuccess(a.id, 'fresh-etag', null);
    const row = db.internalGetDb()
      .prepare('SELECT consecutive_failures, circuit_open_until, etag FROM calendar_poll_state WHERE account_id = ?')
      .get(a.id) as { consecutive_failures: number; circuit_open_until: string | null; etag: string };
    expect(row.consecutive_failures).toBe(0);
    expect(row.circuit_open_until).toBeNull();
    expect(row.etag).toBe('fresh-etag');
  });
});
