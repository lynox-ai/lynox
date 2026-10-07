import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { ConnectionStore } from './connection-store.js';
import { ApiStore, type ApiProfile } from './api-store.js';
import { RunHistory } from './run-history.js';
import { noteCallConnection, runInCallSlot, type CallSlot } from './call-connection.js';

/**
 * The per-call connection stamp (source-connection PRD, first build cut).
 *
 * Three properties the stamp has to carry, each with its own witness below:
 *  (a) only the engine's resolver writes it — a value the model supplies does not
 *      become the stamp (here: the slot only takes what `noteCallConnection` is
 *      handed, and it is isolated per call; the http resolver half is in http.test.ts);
 *  (b) it outlives the `connections` row it names;
 *  (c) a connection deleted and set up again is told apart from the old one — and
 *      where it is NOT (a re-authorisation of the same row), the gap is pinned.
 */
describe('call-connection slot', () => {
  it('is a no-op outside a call', () => {
    // A bulk run's worker effect resolves credentials with no tool call around it.
    expect(() => noteCallConnection({ id: 'shop', createdAt: null })).not.toThrow();
  });

  it('keeps the first connection a call resolved', () => {
    const slot: CallSlot = {};
    runInCallSlot(slot, () => {
      noteCallConnection({ id: 'first', createdAt: '2026-01-01 00:00:00' });
      noteCallConnection({ id: 'second', createdAt: null });
    });
    expect(slot.connection).toEqual({ id: 'first', createdAt: '2026-01-01 00:00:00' });
  });

  it('keeps concurrent calls apart across awaits', async () => {
    const a: CallSlot = {};
    const b: CallSlot = {};
    const tick = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
    await Promise.all([
      runInCallSlot(a, async () => { await tick(20); noteCallConnection({ id: 'conn-a', createdAt: null }); }),
      runInCallSlot(b, async () => { await tick(5); noteCallConnection({ id: 'conn-b', createdAt: null }); }),
    ]);
    expect(a.connection?.id).toBe('conn-a');
    expect(b.connection?.id).toBe('conn-b');
  });

  it('stores a copy, so the noter cannot rewrite the stamp afterwards', () => {
    const slot: CallSlot = {};
    const handed = { id: 'shop', createdAt: null as string | null };
    runInCallSlot(slot, () => { noteCallConnection(handed); });
    handed.id = 'other';
    expect(slot.connection?.id).toBe('shop');
  });
});

describe('connection stamp — persistence and identity', () => {
  const tmpDirs: string[] = [];
  const closers: Array<() => void> = [];

  afterEach(() => {
    for (const c of closers.splice(0)) { try { c(); } catch { /* ignore */ } }
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function setup(): { engine: EngineDb; cs: ConnectionStore; store: ApiStore; history: RunHistory } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-callconn-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    const history = new RunHistory(join(dir, 'history.db'));
    closers.push(() => engine.close(), () => history.close());
    const cs = new ConnectionStore(engine);
    const store = new ApiStore();
    store.setConnectionStore(cs);
    return { engine, cs, store, history };
  }

  function profile(id: string, over: Partial<ApiProfile> = {}): ApiProfile {
    return { id, name: id, base_url: `https://${id}.example/v1`, description: `${id} API`, auth: { type: 'bearer', vault_keys: [`${id.toUpperCase()}_KEY`] }, ...over };
  }

  /** Move a row's created_at into the past, as elapsed time would. SQLite's
   *  datetime('now') has one-second resolution; this stands in for the wait. */
  function age(engine: EngineDb, id: string): void {
    engine.getDb().prepare(`UPDATE connections SET created_at = '2026-01-01 00:00:00' WHERE id = ?`).run(id);
  }

  it('reads created_at from the connection row, and nothing without one', () => {
    const { cs, store } = setup();
    expect(store.save(profile('shop')).ok).toBe(true);
    expect(store.connectionCreatedAt('shop')).toBe(cs.get('shop')!.createdAt);
    expect(store.connectionCreatedAt('nope')).toBeUndefined();
    // The flat-JSON fallback has no engine.db row to read.
    expect(new ApiStore().connectionCreatedAt('shop')).toBeUndefined();
  });

  it('(b) the stamp on a ledger row survives deleting the connection', () => {
    // What this pins is the write path and the column's independence: the ledger
    // (history.db) and connections (engine.db) are separate files, so no FK or
    // cascade can exist between them. A future purge of ledger rows on connection
    // delete, done in another layer, would not be caught here.
    const { store, history } = setup();
    store.save(profile('shop'));
    const createdAt = store.connectionCreatedAt('shop')!;
    const runId = history.insertRun({ taskText: 't', modelTier: 'balanced', modelId: 'm' });
    history.insertToolCall({ runId, toolName: 'http_request', inputJson: '{}', outputJson: '', durationMs: 1, sequenceOrder: 0, connectionId: 'shop', connectionCreatedAt: createdAt });

    expect(store.remove('shop')).toBeTruthy();
    expect(store.connectionCreatedAt('shop')).toBeUndefined(); // the row is gone …

    const [call] = history.getRunToolCalls(runId);
    expect(call!.connection_id).toBe('shop');               // … the stamp is not
    expect(call!.connection_created_at).toBe(createdAt);
  });

  it('writes NULL — unknown — when a call carried no stamp', () => {
    const { history } = setup();
    const runId = history.insertRun({ taskText: 't', modelTier: 'balanced', modelId: 'm' });
    history.insertToolCall({ runId, toolName: 'read_file', inputJson: '{}', outputJson: '', durationMs: 1, sequenceOrder: 0 });
    const [call] = history.getRunToolCalls(runId);
    expect(call!.connection_id).toBeNull();
    expect(call!.connection_created_at).toBeNull();
  });

  it('(c) a connection deleted and set up again under the same id gets a different stamp — once a second has passed', () => {
    // `age` stands in for elapsed time. Inside the same second the pair is
    // identical (datetime('now') resolution); that gap is named in call-connection.ts.
    const { engine, store } = setup();
    store.save(profile('shop'));
    age(engine, 'shop');
    const before = store.connectionCreatedAt('shop');
    store.remove('shop');
    store.save(profile('shop'));
    const after = store.connectionCreatedAt('shop');
    expect(before).toBe('2026-01-01 00:00:00');
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  });

  it('(c) re-authorising the same row under another account keeps the stamp', () => {
    // The upsert keeps created_at by design (connection-store.ts), so a profile
    // whose token is replaced by one for a different account — without deleting
    // the profile — carries the same (id, created_at) as before. The stamp tells
    // apart connection ROWS, not grants. This test pins that, so a change to it has
    // to be made on purpose.
    const { engine, store } = setup();
    store.save(profile('shop'));
    age(engine, 'shop');
    const before = store.connectionCreatedAt('shop');
    store.save(profile('shop', { description: 'reconnected under another account' }));
    expect(store.connectionCreatedAt('shop')).toBe(before);
  });
});
