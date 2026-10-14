import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { ConnectionStore, type ConnectionRow } from './connection-store.js';
import { GrantLedger } from './grant-ledger.js';
import { ApiStore, type ApiProfile } from './api-store.js';

// `connections.id` is one key across every kind. These pin that no api write turns another
// kind's row into an api row: a save refuses and the engine's own writes fail into their logs.
// The one-shot flat-file import is the exception, pinned below.
describe('an api write under another kind\'s id', () => {
  let dir: string;
  let db: EngineDb;
  let conn: ConnectionStore;
  let ledger: GrantLedger;

  const googleRow: ConnectionRow = {
    id: 'google', kind: 'google', name: 'Google', subjectId: null, direction: 'outbound',
    configJson: JSON.stringify({ scopes: ['openid'], client_source: 'managed' }), vaultKeys: [], status: 'active',
  };
  const bearer = (id: string): ApiProfile => ({
    id, name: id, base_url: `https://${id}.example`, description: 'd',
    auth: { type: 'bearer', vault_keys: [`${id.toUpperCase()}_KEY`] },
  });
  const row = (id: string): Pick<ConnectionRow, 'kind' | 'configJson'> | undefined => {
    const r = conn.get(id);
    return r === undefined ? undefined : { kind: r.kind, configJson: r.configJson };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-otherkind-'));
    db = new EngineDb(join(dir, 'engine.db'), '');
    conn = new ConnectionStore(db);
    ledger = new GrantLedger(db.getDb());
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a save refuses, names the kind, and leaves the row and the ledger as they were', () => {
    conn.upsert(googleRow);
    const store = new ApiStore();
    store.setConnectionStore(conn);
    store.setGrantLedger(ledger);

    const result = store.save(bearer('google'));

    expect(result).toEqual({ ok: false, reason: expect.stringContaining('A google connection already uses the id "google"') });
    expect(row('google')).toEqual({ kind: 'google', configJson: googleRow.configJson });
    expect(store.get('google')).toBeUndefined();
    expect(ledger.forConnection('google')).toEqual([]);
  });

  it('a save under a free id still lands beside the other kind\'s row', () => {
    conn.upsert(googleRow);
    const store = new ApiStore();
    store.setConnectionStore(conn);
    store.setGrantLedger(ledger);

    expect(store.save(bearer('shop'))).toEqual({ ok: true, isNew: true });
    expect(row('shop')?.kind).toBe('api');
    expect(row('google')?.kind).toBe('google');
  });

  it('a grant the engine mints outside a save fails instead of overwriting, and mints nothing', () => {
    const store = new ApiStore();
    store.setConnectionStore(conn);
    store.setGrantLedger(ledger);
    expect(store.save(bearer('shop')).ok).toBe(true);
    const before = ledger.forConnection('shop').length;
    // The profile is held in memory while another kind's row now sits under its id — the
    // state the write has to survive, however it came about.
    db.getDb().prepare("UPDATE connections SET kind = 'google', config_json = ? WHERE id = 'shop'").run(googleRow.configJson);

    expect(store.secretWritten('SHOP_KEY')).toBe(0);

    expect(row('shop')).toEqual({ kind: 'google', configJson: googleRow.configJson });
    expect(ledger.forConnection('shop')).toHaveLength(before);
  });

  it('the flat-file import keeps a user\'s API over the Google row, which nothing reads yet', () => {
    conn.upsert(googleRow);
    const apis = join(dir, 'apis');
    mkdirSync(apis);
    writeFileSync(join(apis, 'google.json'), JSON.stringify(bearer('google')));
    writeFileSync(join(apis, 'shop.json'), JSON.stringify(bearer('shop')));

    // The import runs once; a file it skipped would never be read again.
    expect(new ApiStore().importFromDirectoryIfNeeded(apis, conn)).toBe(2);

    expect(row('google')?.kind).toBe('api');
    expect(row('shop')?.kind).toBe('api');
  });
});
