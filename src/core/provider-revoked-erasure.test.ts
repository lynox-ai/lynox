import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineDb } from './engine-db.js';
import { ConnectionStore } from './connection-store.js';
import { GrantLedger } from './grant-ledger.js';
import { ApiStore, type ApiProfile } from './api-store.js';
import { RunHistory } from './run-history.js';
import * as erasure from './connection-erasure.js';

/**
 * A provider's own removal of an `api` grant (a token exchange answered `grant-revoked`): the
 * record it writes, its hold, its cancel, and what it must leave alone. Written before the logic.
 *
 * The record is an erasure only while `providerErasureEnabled()` is on, a switch of its own that
 * stays off until the owner is told on the record's start; off, a revocation writes `closing`.
 * A held record is not swept before `hold_until`; a reconnect or a lifted revocation inside the
 * hold cancels it; an owner's delete inside the hold supersedes it.
 */

// Read through the module object, so a missing export fails the test that needs it, not the file.
interface ProviderRecordView extends erasure.StoredConnectionRecord {
  readonly cause?: string;
  readonly holdUntil?: string | null;
  readonly revokedGrant?: string | null;
}
type RevokeResult = 'erasure' | 'closing' | 'none';
const api = erasure as unknown as {
  setProviderErasureForTests(on: boolean): () => void;
  providerErasureEnabled(): boolean;
  PROVIDER_HOLD_MS: number;
  cancelProviderRecord(db: unknown, recordId: number, now: Date): 'cancelled' | 'not_held' | 'not_found';
};
const markRevoked = (store: ApiStore, id: string, at: Date, stamped = true): RevokeResult =>
  (store as unknown as { markRevokedWithRecord(id: string, fp: string, at: Date, stamped: boolean): RevokeResult }).markRevokedWithRecord(id, 'fp-refused', at, stamped);

const DAY = 24 * 3600 * 1000;
// The refusal happened a day ago: the save and the delete read the real clock, so "inside the
// hold" must hold for them too, whatever today's date is.
const T0 = new Date(Date.now() - DAY);
const profile = (): ApiProfile => ({ id: 'shop', name: 'shop', base_url: 'https://shop.example', description: 'd', auth: { type: 'bearer', vault_keys: ['SHOP_KEY'] } });

let dir: string;
let db: EngineDb;
let conn: ConnectionStore;
let store: ApiStore;
let history: RunHistory;
let restoreSwitches: Array<() => void>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lynox-provider-revoked-'));
  db = new EngineDb(join(dir, 'engine.db'));
  conn = new ConnectionStore(db);
  store = new ApiStore();
  store.loadFromConnections(conn);
  store.setConnectionStore(conn);
  store.setGrantLedger(new GrantLedger(db.getDb()));
  history = new RunHistory(join(dir, 'history.db'));
  restoreSwitches = [];
});
afterEach(() => {
  for (const restore of restoreSwitches.reverse()) restore();
  history.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const providerOn = (on = true): void => { restoreSwitches.push(api.setProviderErasureForTests(on)); };
const e5On = (on = true): void => { restoreSwitches.push(erasure.setErasureOnDeleteForTests(on)); };
const grantOf = (): string => store.get('shop')!.oauth_grant!.grant_id!;
const rowsOf = (grantId: string): number =>
  (history.getDb().prepare('SELECT COUNT(*) AS n FROM run_tool_calls WHERE grant_id = ?').get(grantId) as { n: number }).n;
const call = (grantId: string, seq: number, running = false): void => {
  const run = history.insertRun({ taskText: 't', modelTier: 'sonnet', modelId: 'm' });
  history.insertToolCall({ runId: run, toolName: 'http_request', inputJson: `{"seq":${seq}}`, outputJson: '', durationMs: 1, sequenceOrder: seq, connectionId: 'shop', grantId });
  if (!running) history.updateRun(run, { status: 'completed' });
};
/** A call of a run created at `createdAt`: a provider's erasure reaches only runs up to day X. */
const callAt = (grantId: string, seq: number, createdAt: Date, running = false): void => {
  const run = history.insertRun({ taskText: 't', modelTier: 'sonnet', modelId: 'm' });
  history.getDb().prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(createdAt.toISOString().replace('T', ' ').slice(0, 19), run);
  history.insertToolCall({ runId: run, toolName: 'http_request', inputJson: `{"seq":${seq}}`, outputJson: '', durationMs: 1, sequenceOrder: seq, connectionId: 'shop', grantId });
  if (!running) history.updateRun(run, { status: 'completed' });
};
const keptAfterHold = (): number | null =>
  (db.getDb().prepare("SELECT kept_after_hold AS n FROM connection_records WHERE cause = 'provider_revoked'").get() as { n: number | null }).n;
const records = (): readonly ProviderRecordView[] => erasure.erasureRecords(db.getDb(), 'shop') as readonly ProviderRecordView[];
const providerRecords = (): readonly ProviderRecordView[] => records().filter((r) => r.cause === 'provider_revoked');
const sweep = (at: Date): void => { erasure.runConnectionErasureSweeps(db.getDb(), history.getDb(), at); };
const at = (ms: number): Date => new Date(T0.getTime() + ms);
const lift = (): void => {
  // What `fetch_token`'s success path saves after a revocation it no longer stands by: the same
  // grant, its revocation fields deleted (api-setup.ts, the success branch).
  const current = store.get('shop')!;
  const grant = { ...current.oauth_grant };
  delete grant.state; delete grant.revoked_fp; delete grant.revoked_at;
  expect(store.save({ ...current, oauth_grant: grant }).ok).toBe(true);
};
const reconnect = (): string => {
  expect(store.save(store.get('shop')!, undefined, { newConsent: true }).ok).toBe(true);
  return grantOf();
};

describe('T1 — a held record is not swept before hold_until, and erased at it without turning late', () => {
  it('leaves every row pending until hold_until, erases at it, and is done', () => {
    providerOn();
    store.save(profile());
    const g = grantOf();
    call(g, 0);
    expect(markRevoked(store, 'shop', T0)).toBe('erasure');
    const [rec] = providerRecords();
    expect(rec?.holdUntil).toBe(at(api.PROVIDER_HOLD_MS).toISOString());
    expect(rec?.deadline).toBe(at(erasure.ERASURE_DEADLINE_MS).toISOString());
    expect(api.PROVIDER_HOLD_MS).toBeLessThan(erasure.ERASURE_DEADLINE_MS);

    sweep(at(api.PROVIDER_HOLD_MS - 1));
    expect(rowsOf(g)).toBe(1);
    expect(providerRecords()[0]?.historyState).toBe('pending');

    sweep(at(api.PROVIDER_HOLD_MS));
    expect(rowsOf(g)).toBe(0);
    expect(providerRecords()[0]?.historyState).toBe('done');
  });

  it('turns late past revoked_at + 30 days, not past hold_until + 30 days, while a run active at its first pass runs', () => {
    providerOn();
    store.save(profile());
    const g = grantOf();
    call(g, 0, true);
    markRevoked(store, 'shop', T0);
    sweep(at(api.PROVIDER_HOLD_MS));
    expect(providerRecords()[0]?.historyState).toBe('pending');
    sweep(at(erasure.ERASURE_DEADLINE_MS + 1));
    expect(providerRecords()[0]?.historyState).toBe('late');
    // Every pass erases what the active run wrote so far; what it writes until it ends goes with
    // the next pass after it, and the state stays `late`.
    const running = (history.getDb().prepare("SELECT id FROM runs WHERE status = 'running'").get() as { id: string }).id;
    history.insertToolCall({ runId: running, toolName: 'http_request', inputJson: '{"seq":1}', outputJson: '', durationMs: 1, sequenceOrder: 1, connectionId: 'shop', grantId: g });
    history.updateRun(running, { status: 'completed' });
    expect(rowsOf(g)).toBe(1);
    sweep(at(erasure.ERASURE_DEADLINE_MS + 2));
    expect(rowsOf(g)).toBe(0);
    expect(providerRecords()[0]?.historyState).toBe('late');
  });
});

describe('T1b — an empty covered set is no erasure', () => {
  it('writes closing when the epoch cannot be told (an empty covered set)', () => {
    providerOn();
    store.save(profile());
    // A row whose start is unknown covers nothing; the save inside the starter keeps it unknown.
    db.getDb().prepare("UPDATE connections SET first_grant_id = NULL WHERE id = 'shop'").run();
    expect(markRevoked(store, 'shop', T0)).toBe('closing');
    expect(providerRecords()[0]?.kind).toBe('closing');
  });
});

describe('T2 — a provider record ends no grant, so a later owner delete still covers the epoch', () => {
  it('a cancelled provider record does not make a later owner delete cover nothing', () => {
    providerOn(); e5On();
    store.save(profile());
    markRevoked(store, 'shop', T0);
    expect(api.cancelProviderRecord(db.getDb(), providerRecords()[0]!.id, at(DAY))).toBe('cancelled');
    expect(store.remove('shop', undefined, { record: 'erasure' })).toBe(true);
    const owner = records().find((r) => r.cause !== 'provider_revoked');
    expect(owner?.coveredGrants.length).toBeGreaterThan(0);
  });

  it('a closing provider record (switch off) does not make a later owner delete cover nothing', () => {
    e5On();
    store.save(profile());
    expect(markRevoked(store, 'shop', T0)).toBe('closing');
    reconnect();
    store.remove('shop', undefined, { record: 'erasure' });
    const owner = records().find((r) => r.cause !== 'provider_revoked');
    expect(owner?.coveredGrants.length).toBeGreaterThan(0);
  });

  it('an owner delete inside the hold supersedes the held record and covers the epoch', () => {
    providerOn(); e5On();
    store.save(profile());
    markRevoked(store, 'shop', T0);
    store.remove('shop', undefined, { record: 'erasure' });
    expect(providerRecords()[0]?.historyState).toBe('cancelled');
    const owner = records().find((r) => r.cause !== 'provider_revoked');
    expect(owner?.coveredGrants.length).toBeGreaterThan(0);
  });
});

describe('T3 — the starter writes the verdict and the record together', () => {
  it('a throw in the record rolls back the revoked grant, in the row and in memory', () => {
    providerOn();
    store.save(profile());
    db.getDb().exec('DROP TABLE connection_records');
    expect(() => markRevoked(store, 'shop', T0)).toThrow();
    expect(store.get('shop')!.oauth_grant?.state).toBeUndefined();
    const row = db.getDb().prepare("SELECT config_json FROM connections WHERE id = 'shop'").get() as { config_json: string };
    expect(row.config_json).not.toContain('"revoked"');
  });

  it('a store without engine.db saves the revocation and writes no record', () => {
    const flat = new ApiStore();
    expect(flat.save(profile()).ok).toBe(true);
    expect(markRevoked(flat, 'shop', T0)).toBe('none');
    expect(flat.get('shop')!.oauth_grant?.state).toBe('revoked');
  });
});

describe('T4/T13 — with the provider switch off, a revocation writes closing, E5 on or off', () => {
  it('E5 on, provider switch off → closing, never erasure', () => {
    e5On(); providerOn(false);
    store.save(profile());
    expect(markRevoked(store, 'shop', T0)).toBe('closing');
    expect(providerRecords().map((r) => r.kind)).toEqual(['closing']);
  });

  it('the same machinery with the provider switch on → erasure', () => {
    e5On(); providerOn(true);
    store.save(profile());
    expect(markRevoked(store, 'shop', T0)).toBe('erasure');
    expect(providerRecords().map((r) => r.kind)).toEqual(['erasure']);
  });
});

describe('T5 — a Shopify grant\'s erasure is not a provider record\'s', () => {
  it('writes closing with no hold', () => {
    providerOn();
    store.save(profile());
    db.getDb().prepare('DELETE FROM connection_grant_hosts').run();
    db.getDb().prepare('INSERT INTO connection_grant_hosts (grant_id, hosts_json) VALUES (?, ?)').run(grantOf(), JSON.stringify(['demo.myshopify.com']));
    expect(markRevoked(store, 'shop', T0)).toBe('closing');
    expect(providerRecords()[0]?.holdUntil ?? null).toBeNull();
  });
});

describe('T6 — one live erasure per refusal', () => {
  it('a second refusal of the same grant writes nothing; after a cancel it writes again', () => {
    providerOn();
    store.save(profile());
    markRevoked(store, 'shop', T0);
    markRevoked(store, 'shop', at(1000));
    expect(providerRecords()).toHaveLength(1);
    api.cancelProviderRecord(db.getDb(), providerRecords()[0]!.id, at(DAY));
    expect(markRevoked(store, 'shop', at(2 * DAY))).toBe('erasure');
    expect(providerRecords().filter((r) => r.historyState !== 'cancelled')).toHaveLength(1);
  });
});

describe('T7 — a revoked current grant does not hold its own record', () => {
  it('the profile stays, and the sweep after the hold erases its rows all the same', () => {
    providerOn();
    store.save(profile());
    const g = grantOf();
    call(g, 0);
    markRevoked(store, 'shop', T0);
    expect(store.get('shop')).toBeDefined();
    sweep(at(api.PROVIDER_HOLD_MS));
    expect(rowsOf(g)).toBe(0);
  });
});

describe('T8 — a reconnect cancels inside the hold, not after it', () => {
  it('inside the hold: cancelled, the rows stay', () => {
    providerOn();
    store.save(profile());
    const g = grantOf();
    call(g, 0);
    markRevoked(store, 'shop', T0);
    reconnect();
    expect(providerRecords()[0]?.historyState).toBe('cancelled');
    sweep(at(api.PROVIDER_HOLD_MS));
    expect(rowsOf(g)).toBe(1);
  });

  it('after the hold: not cancelled; the old grant is erased, the new one stays', () => {
    providerOn();
    store.save(profile());
    const g = grantOf();
    call(g, 0);
    markRevoked(store, 'shop', T0);
    sweep(at(api.PROVIDER_HOLD_MS)); // erased, done
    const fresh = reconnect();
    call(fresh, 1);
    sweep(at(api.PROVIDER_HOLD_MS + DAY));
    expect(providerRecords()[0]?.historyState).toBe('done');
    expect(rowsOf(g)).toBe(0);
    expect(rowsOf(fresh)).toBe(1);
  });
});

describe('T8b/T14 — a lifted revocation on the same grant cancels inside the hold', () => {
  it('the save that clears the revocation cancels the record, and the working connection keeps its rows', () => {
    providerOn();
    store.save(profile());
    const g = grantOf();
    call(g, 0);
    markRevoked(store, 'shop', T0);
    lift();
    expect(providerRecords()[0]?.historyState).toBe('cancelled');
    call(g, 1);
    for (const ms of [api.PROVIDER_HOLD_MS, api.PROVIDER_HOLD_MS + DAY, erasure.ERASURE_DEADLINE_MS - 1]) sweep(at(ms));
    expect(rowsOf(g)).toBe(2);
  });

  it('a throw in that save leaves the grant revoked, the record held and memory as it was', () => {
    providerOn();
    store.save(profile());
    markRevoked(store, 'shop', T0);
    db.getDb().exec('CREATE TRIGGER no_cancel BEFORE UPDATE ON connection_records BEGIN SELECT RAISE(ABORT, \'blocked\'); END');
    expect(() => lift()).toThrow();
    expect(store.get('shop')!.oauth_grant?.state).toBe('revoked');
    expect(providerRecords()[0]?.historyState).toBe('pending');
  });
});

describe('T9/T15 — after the hold the erasure is bounded by day X, and the owner\'s delete covers the whole epoch', () => {
  it('a lift after the hold changes nothing; the lifted grant\'s rows from later runs stay; an owner delete covers every grant', () => {
    providerOn(); e5On();
    store.save(profile());
    const g = grantOf();
    const past = new Date(Date.now() - 20 * DAY);
    callAt(g, 0, new Date(past.getTime() + 3600_000));
    markRevoked(store, 'shop', past);
    sweep(new Date(past.getTime() + api.PROVIDER_HOLD_MS));
    expect(rowsOf(g)).toBe(0);
    expect(providerRecords()[0]?.historyState).toBe('done');
    lift(); // the hold is over by the real clock: nothing is cancelled
    expect(providerRecords()[0]?.historyState).toBe('done');
    call(g, 1); // a run of today, after day X
    sweep(new Date(past.getTime() + api.PROVIDER_HOLD_MS + DAY));
    expect(rowsOf(g)).toBe(1);
    expect(keptAfterHold()).toBe(1);
    const fresh = reconnect();
    store.remove('shop', undefined, { record: 'erasure' });
    const owner = records().find((r) => r.cause !== 'provider_revoked');
    expect(owner?.coveredGrants).toContain(g);
    expect(owner?.coveredGrants).toContain(fresh);
    // The owner's erasure reaches the rows the provider's left: the later run's call goes.
    sweep(new Date());
    expect(rowsOf(g)).toBe(0);
  });

  it('a removal with a closing record (the settings route) leaves the rows after day X', () => {
    providerOn(); e5On();
    store.save(profile());
    const g = grantOf();
    const past = new Date(Date.now() - 20 * DAY);
    callAt(g, 0, new Date(past.getTime() + 3600_000));
    markRevoked(store, 'shop', past);
    call(g, 1);
    sweep(new Date(past.getTime() + api.PROVIDER_HOLD_MS));
    expect(rowsOf(g)).toBe(1);
    store.remove('shop', undefined, { record: 'closing' });
    sweep(new Date());
    expect(rowsOf(g)).toBe(1);
  });

  it('inside the hold a lift cancels, also while a run is active', () => {
    providerOn();
    store.save(profile());
    const g = grantOf();
    call(g, 0, true);
    markRevoked(store, 'shop', T0);
    lift();
    expect(providerRecords()[0]?.historyState).toBe('cancelled');
  });

  it('after the hold a reconnect does not cancel a record still pending, and pre-day-X rows go', () => {
    providerOn();
    store.save(profile());
    const g = grantOf();
    const past = new Date(Date.now() - 20 * DAY);
    callAt(g, 0, new Date(past.getTime() + 3600_000), true); // keeps it pending after its first pass
    markRevoked(store, 'shop', past);
    sweep(new Date(past.getTime() + api.PROVIDER_HOLD_MS));
    expect(providerRecords()[0]?.historyState).toBe('pending');
    reconnect();
    expect(providerRecords()[0]?.historyState).toBe('pending');
    expect(rowsOf(g)).toBe(0);
  });

  it('a credentials change inside the hold does not cancel (a configuration change, not a living connection)', () => {
    providerOn();
    store.save(profile());
    markRevoked(store, 'shop', T0);
    const changed = { ...store.get('shop')!, auth: { type: 'bearer' as const, vault_keys: ['SHOP_KEY_2'] } };
    expect(store.save(changed).ok).toBe(true);
    expect(providerRecords()[0]?.historyState).toBe('pending');
  });
});

describe('T10 — the record is the notice: the switch decides, both directions', () => {
  it('on → erasure with a hold; off → closing without one', () => {
    providerOn(true);
    store.save(profile());
    expect(markRevoked(store, 'shop', T0)).toBe('erasure');
    expect(providerRecords()[0]?.holdUntil).not.toBeNull();
    restoreSwitches.pop()!();
    expect(api.providerErasureEnabled()).toBe(false);
  });
});

describe('T11 — the owner\'s cancel', () => {
  it('cancels a held record; refuses one past its hold and one that is not a provider record', () => {
    providerOn(); e5On();
    store.save(profile());
    markRevoked(store, 'shop', T0);
    const id = providerRecords()[0]!.id;
    expect(api.cancelProviderRecord(db.getDb(), id, at(api.PROVIDER_HOLD_MS))).toBe('not_held');
    expect(api.cancelProviderRecord(db.getDb(), id, at(DAY))).toBe('cancelled');
    store.remove('shop', undefined, { record: 'erasure' });
    const owner = records().find((r) => r.cause !== 'provider_revoked')!;
    expect(api.cancelProviderRecord(db.getDb(), owner.id, at(DAY))).toBe('not_held');
    expect(api.cancelProviderRecord(db.getDb(), 99999, at(DAY))).toBe('not_found');
  });
});

describe('T12 — existing records keep what they were', () => {
  it('an owner delete writes cause owner_delete and no hold', () => {
    e5On();
    store.save(profile());
    store.remove('shop', undefined, { record: 'erasure' });
    expect(records()[0]?.cause).toBe('owner_delete');
    expect(records()[0]?.holdUntil ?? null).toBeNull();
  });
});

describe('T16 — an owner delete after the hold, before done', () => {
  it('erases the provider record\'s rows once no live row holds the connection', () => {
    providerOn();
    store.save(profile());
    const g = grantOf();
    // The delete reads the real clock, so the refusal lies far enough back for the hold to have
    // ended by now: the delete does not supersede it.
    const past = new Date(Date.now() - 20 * DAY);
    const beforeX = new Date(past.getTime() + 3600_000);
    callAt(g, 0, beforeX);
    callAt(g, 1, beforeX, true); // keeps the record pending past its first pass
    markRevoked(store, 'shop', past);
    sweep(new Date(past.getTime() + api.PROVIDER_HOLD_MS));
    expect(providerRecords()[0]?.historyState).toBe('pending');
    store.remove('shop', undefined, { record: 'closing' });
    expect(providerRecords()[0]?.historyState).toBe('pending');
    callAt(g, 2, beforeX); // a call of a run from before day X that lands late
    sweep(new Date(past.getTime() + api.PROVIDER_HOLD_MS + DAY));
    expect(rowsOf(g)).toBe(0);
  });
});

describe('T17 — a broken insert throws instead of vanishing', () => {
  it('the table refuses an unknown cause', () => {
    expect(() => db.getDb().prepare(
      "INSERT INTO connection_records (kind, connection_id, history_state, created_at, deadline, cause) VALUES ('erasure', 'x', 'pending', 'a', 'b', 'bogus')",
    ).run()).toThrow(/CHECK constraint failed/);
  });

  it('the record writer never uses INSERT OR IGNORE on connection_records', () => {
    const src = readFileSync(new URL('./connection-erasure.ts', import.meta.url), 'utf8');
    // The provider record's insert aims its conflict at the one index, so a CHECK or NOT NULL
    // violation still throws.
    expect(src).toMatch(/INSERT INTO connection_records[\s\S]{0,600}ON CONFLICT[\s\S]{0,200}DO NOTHING/);
    expect(src).not.toMatch(/INSERT\s+OR\s+IGNORE\s+INTO\s+connection_records/i);
  });
});

describe('T18 — a closing record written while the switch was off blocks nothing', () => {
  it('off → closing; on → the same grant\'s next refusal writes erasure', () => {
    store.save(profile());
    expect(markRevoked(store, 'shop', T0)).toBe('closing');
    providerOn();
    expect(markRevoked(store, 'shop', at(DAY))).toBe('erasure');
    expect(providerRecords().map((r) => r.kind)).toEqual(['closing', 'erasure']);
  });
});

describe('T19 — owner deletes are unchanged', () => {
  it('an owner delete whose covered set is empty stays not reached', () => {
    e5On();
    store.save(profile());
    db.getDb().prepare('DELETE FROM connection_grant_hosts').run();
    store.remove('shop', undefined, { record: 'erasure' });
    expect(records()[0]?.kind).toBe('erasure');
    expect(records()[0]?.historyState).toBe('not reached');
  });
});

describe('T20 — a provider record covers only the grants under the refusing endpoint', () => {
  it('a token_url changed after the first grant leaves the earlier grant out of the covered set', () => {
    providerOn();
    const oauth = (tokenUrl: string): ApiProfile => ({
      id: 'shop', name: 'shop', base_url: 'https://shop.example', description: 'd',
      auth: { type: 'oauth2', vault_keys: ['SHOP_CLIENT_ID', 'SHOP_CLIENT_SECRET'], oauth: { token_url: tokenUrl, grant_type: 'refresh_token', client_id_key: 'SHOP_CLIENT_ID', client_secret_key: 'SHOP_CLIENT_SECRET' } },
    });
    expect(store.save(oauth('https://shop.example/oauth/token')).ok).toBe(true);
    const before = grantOf();
    call(before, 0);
    // The endpoint moves: a credentials change, so a new grant within the same epoch.
    expect(store.save(oauth('https://elsewhere.example/oauth/token')).ok).toBe(true);
    const after = grantOf();
    expect(after).not.toBe(before);
    call(after, 1);
    expect(markRevoked(store, 'shop', T0)).toBe('erasure');
    expect(providerRecords()[0]?.coveredGrants).toEqual([after]);
    sweep(at(api.PROVIDER_HOLD_MS));
    expect(rowsOf(after)).toBe(0);
    expect(rowsOf(before)).toBe(1);
  });
});

describe('T20 counter-direction — without a credentials change the record covers the epoch from its start', () => {
  it('a reconnect (consent) does not cut: both grants are covered', () => {
    providerOn();
    store.save(profile());
    const first = grantOf();
    call(first, 0);
    const second = reconnect();
    expect(second).not.toBe(first);
    call(second, 1);
    expect(markRevoked(store, 'shop', T0)).toBe('erasure');
    expect([...(providerRecords()[0]?.coveredGrants ?? [])].sort()).toEqual([first, second].sort());
  });
});

describe('the stamp condition: a token stored since the stamp says nothing about the earlier grants', () => {
  it('a refusal of an unstamped token writes closing, with the switch on and grants covered', () => {
    providerOn();
    store.save(profile());
    reconnect();
    expect(markRevoked(store, 'shop', T0, false)).toBe('closing');
    expect(providerRecords().map((r) => r.historyState)).toEqual(['not reached']);
  });
});

describe('the Shopify condition and the open-record check carry weight of their own', () => {
  it('a connection whose current grant is Shopify writes closing even when earlier grants are in scope', () => {
    providerOn();
    store.save(profile());
    reconnect();
    const current = grantOf();
    db.getDb().prepare('INSERT INTO connection_grant_hosts (grant_id, hosts_json) VALUES (?, ?)').run(current, JSON.stringify(['demo.myshopify.com']));
    expect(markRevoked(store, 'shop', T0)).toBe('closing');
  });

  it('with the switch off, a second refusal of the same grant writes no second closing record', () => {
    store.save(profile());
    markRevoked(store, 'shop', T0);
    markRevoked(store, 'shop', at(1000));
    expect(providerRecords()).toHaveLength(1);
  });
});

describe('F7 — the v51 migration keeps every record written before it', () => {
  it('a v50 record keeps its fields and becomes an owner_delete without a hold', () => {
    const path = join(dir, 'old.db');
    const before = new EngineDb(path);
    before.getDb().exec(`DROP TABLE connection_records; DELETE FROM schema_version WHERE version > 50;
      CREATE TABLE connection_records (
        id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('erasure', 'closing')), connection_id TEXT NOT NULL, label TEXT,
        covered_grants_json TEXT NOT NULL DEFAULT '[]', ended_grants_json TEXT NOT NULL DEFAULT '[]', runs_active_json TEXT,
        history_state TEXT NOT NULL CHECK (history_state IN ('pending', 'done', 'not reached', 'failed', 'late')),
        created_at TEXT NOT NULL, deadline TEXT NOT NULL, done_at TEXT, wal_scrub_pending INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX idx_connection_records_connection ON connection_records(connection_id);
      INSERT INTO connection_records (id, kind, connection_id, label, covered_grants_json, ended_grants_json, runs_active_json, history_state, created_at, deadline, done_at, wal_scrub_pending)
        VALUES (7, 'erasure', 'crm', 'CRM', '["g1"]', '["g1","g0"]', '[]', 'late', 'c', 'd', NULL, 1);`);
    before.close();
    const after = new EngineDb(path);
    try {
      const row = after.getDb().prepare('SELECT * FROM connection_records WHERE id = 7').get() as Record<string, unknown>;
      expect(row).toMatchObject({ kind: 'erasure', connection_id: 'crm', label: 'CRM', covered_grants_json: '["g1"]', ended_grants_json: '["g1","g0"]', runs_active_json: '[]', history_state: 'late', created_at: 'c', deadline: 'd', wal_scrub_pending: 1, cause: 'owner_delete', hold_until: null, revoked_grant: null });
      expect(after.getDb().prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_connection_records_connection'").get()).toBeDefined();
    } finally { after.close(); }
  });
});
