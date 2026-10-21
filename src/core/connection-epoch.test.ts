import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineDb } from './engine-db.js';
import { ConnectionStore, type ConnectionRow } from './connection-store.js';
import { GrantLedger } from './grant-ledger.js';
import { ApiStore } from './api-store.js';
import { coveredGrantSet } from './connection-erasure.js';

/**
 * Where a connection's epoch starts (`connections.first_grant_id`), for rows the column was not
 * there for and for rows written with a grant this ledger does not hold. The start is the
 * earliest beginning grant (`new`, `backfill`, `split`) of the id minted from the row's
 * `created_at` on, with a two-second tolerance; two beginnings inside the tolerance, or none at
 * all, leave the start empty, so the erasure covers nothing rather than another connection's rows.
 */

let dir: string;
let path: string;
let db: EngineDb;
let ledger: GrantLedger;
let conn: ConnectionStore;

const row = (id: string, firstGrantId: string | null, grantInConfig?: string): ConnectionRow => ({
  id, kind: 'api', name: id, subjectId: null, direction: 'outbound',
  configJson: JSON.stringify({
    base_url: `https://${id}.example`, description: 'd', auth: { type: 'bearer', vault_keys: [`${id.toUpperCase()}_KEY`] },
    ...(grantInConfig !== undefined ? { oauth_grant: { grant_id: grantInConfig } } : {}),
  }),
  vaultKeys: [], status: 'active', firstGrantId,
});
const mintAt = (id: string, reason: 'new' | 'backfill' | 'split' | 'consent', at: string): string => {
  const g = ledger.mint(id, 'api', reason);
  db.getDb().prepare('UPDATE connection_grants SET minted_at = ? WHERE grant_id = ?').run(at, g);
  return g;
};
const createdAt = (id: string, at: string): void => {
  db.getDb().prepare('UPDATE connections SET created_at = ? WHERE id = ?').run(at, id);
};
/** The grant the row's profile carries now, as the boot's backfill or a save leaves it in `config_json`. */
const setCurrent = (id: string, g: string): void => {
  db.getDb().prepare("UPDATE connections SET config_json = json_set(config_json, '$.oauth_grant.grant_id', ?) WHERE id = ?").run(g, id);
};
const firstOf = (handle: EngineDb, id: string): string | null =>
  (handle.getDb().prepare('SELECT first_grant_id AS g FROM connections WHERE id = ?').get(id) as { g: string | null }).g;

/** Put the column back where the release before this one left it, and reopen: the migration runs. */
const reopenAsUpgraded = (state: Record<string, string | null>): EngineDb => {
  for (const [id, g] of Object.entries(state)) db.getDb().prepare('UPDATE connections SET first_grant_id = ? WHERE id = ?').run(g, id);
  db.getDb().exec('DELETE FROM schema_version WHERE version > 49;');
  db.close();
  return new EngineDb(path);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lynox-epoch-'));
  path = join(dir, 'engine.db');
  db = new EngineDb(path);
  ledger = new GrantLedger(db.getDb());
  conn = new ConnectionStore(db);
});
afterEach(() => {
  try { db.close(); } catch { /* closed by the test */ }
  rmSync(dir, { recursive: true, force: true });
});

describe('the migration sets the epoch start by time', () => {
  it('a profile saved again before the column existed starts at the grant its row was created with', () => {
    conn.upsert(row('shop', null));
    createdAt('shop', '2026-03-01 10:00:00');
    const created = mintAt('shop', 'new', '2026-03-01 10:00:00');
    const resaved = mintAt('shop', 'new', '2026-03-05 09:00:00');
    setCurrent('shop', resaved);
    // The release before took the latest beginning grant.
    db = reopenAsUpgraded({ shop: resaved });
    expect(firstOf(db, 'shop')).toBe(created);
  });

  it('takes a grant minted a second before the row, as a save can mint it', () => {
    conn.upsert(row('shop', null));
    createdAt('shop', '2026-03-01 10:00:01');
    const created = mintAt('shop', 'new', '2026-03-01 10:00:00');
    setCurrent('shop', created);
    db = reopenAsUpgraded({ shop: null });
    expect(firstOf(db, 'shop')).toBe(created);
  });

  it('a connection removed and set up again under the same id keeps the earlier one\'s grants outside', () => {
    const earlier = mintAt('shop', 'new', '2026-02-01 10:00:00');
    conn.upsert(row('shop', null));
    createdAt('shop', '2026-03-01 10:00:00');
    const created = mintAt('shop', 'new', '2026-03-01 10:00:00');
    setCurrent('shop', created);
    db = reopenAsUpgraded({ shop: created });
    expect(firstOf(db, 'shop')).toBe(created);
    expect(firstOf(db, 'shop')).not.toBe(earlier);
  });

  it('two beginnings inside the tolerance leave the start empty', () => {
    // Removed and set up again within a second: which grant began this row cannot be told.
    mintAt('shop', 'new', '2026-03-01 10:00:00');
    conn.upsert(row('shop', null));
    createdAt('shop', '2026-03-01 10:00:01');
    const created = mintAt('shop', 'new', '2026-03-01 10:00:01');
    setCurrent('shop', created);
    db = reopenAsUpgraded({ shop: created });
    expect(firstOf(db, 'shop')).toBeNull();
  });

  it('no beginning from the row\'s creation on leaves the start empty, and never takes an earlier grant', () => {
    // A clock stepped back: every grant reads as older than the row.
    const old = mintAt('shop', 'new', '2026-02-01 10:00:00');
    conn.upsert(row('shop', null));
    createdAt('shop', '2026-03-01 10:00:00');
    setCurrent('shop', old);
    db = reopenAsUpgraded({ shop: old });
    expect(firstOf(db, 'shop')).toBeNull();
  });

  it('a grant this ledger does not hold is replaced by the row\'s own beginning', () => {
    conn.upsert(row('shop', null));
    createdAt('shop', '2026-03-01 10:00:00');
    const backfill = mintAt('shop', 'backfill', '2026-03-02 08:00:00');
    setCurrent('shop', backfill);
    db = reopenAsUpgraded({ shop: 'grant-of-another-engine' });
    expect(firstOf(db, 'shop')).toBe(backfill);
  });

  it('a later grant that is not a beginning does not start the epoch', () => {
    conn.upsert(row('shop', null));
    createdAt('shop', '2026-03-01 10:00:00');
    setCurrent('shop', mintAt('shop', 'consent', '2026-03-02 08:00:00'));
    db = reopenAsUpgraded({ shop: null });
    expect(firstOf(db, 'shop')).toBeNull();
  });

  it('leaves a row written since the column exists as it is', () => {
    // Today's save: the grant is minted in the INSERT's transaction, on the same clock.
    const g = ledger.mint('shop', 'api', 'new');
    conn.upsert(row('shop', g, g));
    expect(firstOf(db, 'shop')).toBe(g);
    db = reopenAsUpgraded({});
    expect(firstOf(db, 'shop')).toBe(g);
  });

  it('a row with no grant of its own yet takes no lone earlier grant, and the boot\'s grant starts it', () => {
    // An earlier connection under the id began a second before and was removed before removals
    // were recorded; today's row came in with a file carrying another engine's grant.
    const earlier = mintAt('shop', 'new', '2026-03-01 09:59:59');
    conn.upsert(row('shop', null, 'grant-of-another-engine'));
    createdAt('shop', '2026-03-01 10:00:00');
    db = reopenAsUpgraded({ shop: 'grant-of-another-engine' });
    expect(firstOf(db, 'shop')).toBeNull();
    ledger = new GrantLedger(db.getDb());
    conn = new ConnectionStore(db);
    const store = new ApiStore();
    store.loadFromConnections(conn);
    store.setConnectionStore(conn);
    store.setGrantLedger(ledger);
    expect(store.backfillGrants()).toBe(1);
    const backfill = store.get('shop')!.oauth_grant!.grant_id!;
    expect(firstOf(db, 'shop')).toBe(backfill);
    expect(firstOf(db, 'shop')).not.toBe(earlier);
  });

  it('a start left empty by two beginnings stays empty when a later beginning is written', () => {
    mintAt('shop', 'new', '2026-03-01 10:00:00');
    conn.upsert(row('shop', null));
    createdAt('shop', '2026-03-01 10:00:01');
    const created = mintAt('shop', 'new', '2026-03-01 10:00:01');
    setCurrent('shop', created);
    db = reopenAsUpgraded({ shop: created });
    expect(firstOf(db, 'shop')).toBeNull();
    // A held-back profile saved again mints `new` in the middle of the connection's life.
    ledger = new GrantLedger(db.getDb());
    conn = new ConnectionStore(db);
    const midlife = ledger.mint('shop', 'api', 'new');
    conn.upsert(row('shop', midlife, midlife));
    expect(firstOf(db, 'shop')).toBeNull();
  });

  it('runs again to the same result after a downgrade and upgrade', () => {
    conn.upsert(row('shop', null));
    createdAt('shop', '2026-03-01 10:00:00');
    const created = mintAt('shop', 'new', '2026-03-01 10:00:00');
    setCurrent('shop', mintAt('shop', 'new', '2026-03-05 09:00:00'));
    db = reopenAsUpgraded({});
    expect(firstOf(db, 'shop')).toBe(created);
    db = reopenAsUpgraded({});
    expect(firstOf(db, 'shop')).toBe(created);
  });
});

describe('a write keeps only a beginning grant this ledger holds for the id', () => {
  it('does not write a grant of another engine', () => {
    conn.upsert(row('shop', 'grant-of-another-engine', 'grant-of-another-engine'));
    expect(firstOf(db, 'shop')).toBeNull();
  });

  it('a later beginning replaces a foreign grant, and a held start stays when later grants come', () => {
    db.getDb().prepare("INSERT INTO connections (id, kind, name, direction, config_json, vault_keys, status, first_grant_id) VALUES ('shop', 'api', 'shop', 'outbound', '{}', '[]', 'active', 'grant-of-another-engine')").run();
    const backfill = ledger.mint('shop', 'api', 'backfill');
    conn.upsert(row('shop', backfill, backfill));
    expect(firstOf(db, 'shop')).toBe(backfill);
    const later = ledger.mint('shop', 'api', 'new');
    conn.upsert(row('shop', later, later));
    expect(firstOf(db, 'shop')).toBe(backfill);
  });

  it('does not write a grant of the id that is not a beginning', () => {
    const consent = ledger.mint('shop', 'api', 'consent');
    conn.upsert(row('shop', consent, consent));
    expect(firstOf(db, 'shop')).toBeNull();
  });

  it('does not keep a held start of the id that is not a beginning', () => {
    db.getDb().prepare("INSERT INTO connections (id, kind, name, direction, config_json, vault_keys, status) VALUES ('shop', 'api', 'shop', 'outbound', '{}', '[]', 'active')").run();
    const consent = ledger.mint('shop', 'api', 'consent');
    db.getDb().prepare("UPDATE connections SET first_grant_id = ? WHERE id = 'shop'").run(consent);
    const backfill = ledger.mint('shop', 'api', 'backfill');
    conn.upsert(row('shop', backfill, backfill));
    expect(firstOf(db, 'shop')).toBe(backfill);
  });

  it('does not take a grant the ledger records for another connection', () => {
    const others = ledger.mint('other', 'api', 'new');
    conn.upsert(row('shop', others, others));
    expect(firstOf(db, 'shop')).toBeNull();
  });
});

describe('an imported connection that shares a grant is reached by its erasure', () => {
  it('the boot splits it off, and the split grant starts its epoch', () => {
    // Two profiles from a copied file carry one grant; the ledger records it for `a`.
    const shared = ledger.mint('a', 'api', 'new');
    // A grant is in the erasure's scope once its hosts are recorded (R8-2), as a save records them.
    ledger.recordHosts(shared, ['a.example']);
    conn.upsert(row('a', shared, shared));
    conn.upsert(row('b', shared, shared));
    expect(firstOf(db, 'b')).toBeNull();

    const store = new ApiStore();
    store.loadFromConnections(conn);
    store.setConnectionStore(conn);
    store.setGrantLedger(ledger);
    expect(store.backfillGrants()).toBe(1);
    const split = store.get('b')!.oauth_grant!.grant_id!;
    expect(ledger.get(split)?.reason).toBe('split');
    expect(firstOf(db, 'b')).toBe(split);
    expect(coveredGrantSet(db.getDb(), 'b')).toEqual([split]);
    // `a` keeps the shared grant and its own epoch.
    expect(coveredGrantSet(db.getDb(), 'a')).toEqual([shared]);
  });
});
