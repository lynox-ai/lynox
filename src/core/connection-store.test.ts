import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { ConnectionStore, type ConnectionRow } from './connection-store.js';

describe('ConnectionStore (Foundation Rework v2 — S4b)', () => {
  const tmpDirs: string[] = [];
  const engines: EngineDb[] = [];

  function make(): { store: ConnectionStore; engine: EngineDb } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-conn-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    engines.push(engine);
    return { store: new ConnectionStore(engine), engine };
  }

  function baseRow(over: Partial<ConnectionRow> = {}): ConnectionRow {
    return {
      id: 'cn1',
      kind: 'api',
      name: 'Stripe',
      subjectId: null,
      direction: 'outbound',
      configJson: '{"base_url":"https://api.stripe.com"}',
      vaultKeys: ['STRIPE_KEY'],
      status: 'active',
      ...over,
    };
  }

  afterEach(() => {
    for (const e of engines.splice(0)) { try { e.close(); } catch { /* ignore */ } }
    for (const d of tmpDirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  it('upsert inserts a row that get() reads back with parsed vault_keys + timestamps', () => {
    const { store } = make();
    store.upsert(baseRow());
    const row = store.get('cn1');
    expect(row).toBeDefined();
    expect(row?.kind).toBe('api');
    expect(row?.name).toBe('Stripe');
    expect(row?.subjectId).toBeNull();
    expect(row?.direction).toBe('outbound');
    expect(row?.configJson).toBe('{"base_url":"https://api.stripe.com"}');
    expect(row?.vaultKeys).toEqual(['STRIPE_KEY']); // JSON array round-trips
    expect(row?.status).toBe('active');
    expect(row?.createdAt).toBeTruthy();
    expect(row?.updatedAt).toBeTruthy();
  });

  it('upsert on conflict UPDATES mutable fields but preserves created_at', () => {
    const { store, engine } = make();
    // Seed an explicit PAST created_at directly so the preservation assertion is
    // not fooled by same-second datetime('now') — a regression that added
    // `created_at = excluded.created_at` to the ON CONFLICT SET would now fail.
    engine.getDb().prepare(
      "INSERT INTO connections (id, kind, name, config_json, created_at) VALUES ('cn1','api','Stripe','{}', '2000-01-01 00:00:00')",
    ).run();
    expect(store.get('cn1')?.createdAt).toBe('2000-01-01 00:00:00');

    store.upsert(baseRow({ name: 'Stripe (renamed)', vaultKeys: ['STRIPE_KEY', 'STRIPE_WEBHOOK'], status: 'disabled' }));

    const row = store.get('cn1');
    expect(row?.name).toBe('Stripe (renamed)');
    expect(row?.vaultKeys).toEqual(['STRIPE_KEY', 'STRIPE_WEBHOOK']);
    expect(row?.status).toBe('disabled');
    // created_at is never in the DO UPDATE SET → the seeded past value survives.
    expect(row?.createdAt).toBe('2000-01-01 00:00:00');
    // updated_at was bumped to now (≠ the frozen created_at).
    expect(row?.updatedAt).not.toBe('2000-01-01 00:00:00');
    // still exactly one row (upsert, not insert+insert).
    expect(store.count('api')).toBe(1);
  });

  it('upsertMany is atomic — a mid-batch failure rolls the whole batch back', () => {
    const { store } = make();
    // The 2nd row points subject_id at a non-existent subject → FK violation
    // (engine.db runs foreign_keys=ON) → the transaction throws and rolls back,
    // so NEITHER row lands (no silent partial import).
    expect(() => store.upsertMany([
      baseRow({ id: 'ok' }),
      baseRow({ id: 'bad', subjectId: 'ghost-subject' }),
    ])).toThrow();
    expect(store.count('api')).toBe(0);
    expect(store.get('ok')).toBeUndefined();
  });

  it('upsertMany commits every row when all are valid', () => {
    const { store } = make();
    store.upsertMany([baseRow({ id: 'a' }), baseRow({ id: 'b' }), baseRow({ id: 'c' })]);
    expect(store.count('api')).toBe(3);
  });

  it('remove(id, kind) is kind-scoped — never deletes a same-id row of another kind', () => {
    const { store } = make();
    store.upsert(baseRow({ id: 'shared', kind: 'mail', name: 'Mailbox' }));
    // A kind-scoped api delete must NOT touch the mail row that happens to share the id.
    expect(store.remove('shared', 'api')).toBe(false);
    expect(store.get('shared')?.kind).toBe('mail');
    // The correctly-scoped delete works.
    expect(store.remove('shared', 'mail')).toBe(true);
    expect(store.get('shared')).toBeUndefined();
  });

  it('getByKind filters by kind and orders oldest-first', () => {
    const { store } = make();
    store.upsert(baseRow({ id: 'a', kind: 'api', name: 'A' }));
    store.upsert(baseRow({ id: 'b', kind: 'api', name: 'B' }));
    store.upsert(baseRow({ id: 'm', kind: 'mail', name: 'Mail' }));
    const apis = store.getByKind('api').map(r => r.id);
    expect(apis).toEqual(['a', 'b']);
    expect(store.getByKind('mail').map(r => r.id)).toEqual(['m']);
    expect(store.getByKind('push')).toEqual([]);
  });

  it('count(kind) reflects inserts and deletes', () => {
    const { store } = make();
    expect(store.count('api')).toBe(0);
    store.upsert(baseRow({ id: 'a' }));
    store.upsert(baseRow({ id: 'b' }));
    expect(store.count('api')).toBe(2);
    store.remove('a');
    expect(store.count('api')).toBe(1);
  });

  it('remove returns true when a row existed, false otherwise', () => {
    const { store } = make();
    store.upsert(baseRow());
    expect(store.remove('cn1')).toBe(true);
    expect(store.get('cn1')).toBeUndefined();
    expect(store.remove('cn1')).toBe(false);
    expect(store.remove('never')).toBe(false);
  });

  it('list returns all kinds oldest-first', () => {
    const { store } = make();
    store.upsert(baseRow({ id: 'a' }));
    store.upsert(baseRow({ id: 'b', kind: 'mail' }));
    expect(store.list().map(r => r.id)).toEqual(['a', 'b']);
  });

  it('malformed stored vault_keys degrades to [] on read (never throws)', () => {
    const { store, engine } = make();
    // Bypass upsert to inject a corrupt value directly.
    engine.getDb().prepare(
      "INSERT INTO connections (id, kind, name, config_json, vault_keys) VALUES ('bad','api','X','{}', 'not-json')",
    ).run();
    expect(store.get('bad')?.vaultKeys).toEqual([]);
    // a JSON object (non-array) also degrades to [].
    engine.getDb().prepare(
      "INSERT INTO connections (id, kind, name, config_json, vault_keys) VALUES ('obj','api','Y','{}', '{\"a\":1}')",
    ).run();
    expect(store.get('obj')?.vaultKeys).toEqual([]);
  });

  it('parseVaultKeys keeps only the string elements of a mixed array', () => {
    const { store, engine } = make();
    engine.getDb().prepare(
      "INSERT INTO connections (id, kind, name, config_json, vault_keys) VALUES ('mix','api','Z','{}', '[\"ok\", 123, null, \"two\"]')",
    ).run();
    expect(store.get('mix')?.vaultKeys).toEqual(['ok', 'two']);
  });

  it('subject_id FK nulls out when the referenced subject is deleted (ON DELETE SET NULL)', () => {
    const { store, engine } = make();
    engine.getDb().prepare("INSERT INTO subjects (id, kind, name) VALUES ('s1','organization','Acme')").run();
    store.upsert(baseRow({ id: 'cn-sub', subjectId: 's1' }));
    expect(store.get('cn-sub')?.subjectId).toBe('s1');
    engine.getDb().prepare("DELETE FROM subjects WHERE id = 's1'").run();
    expect(store.get('cn-sub')?.subjectId).toBeNull();
  });

  it('deleting a connection nulls the inbound triggers.source_connection_id FK (P3 plug-point)', () => {
    const { store, engine } = make();
    store.upsert(baseRow({ id: 'cn-src' }));
    engine.getDb().prepare(
      "INSERT INTO triggers (id, title, source_connection_id) VALUES ('tr1','Webhook','cn-src')",
    ).run();
    expect((engine.getDb().prepare("SELECT source_connection_id AS s FROM triggers WHERE id='tr1'").get() as { s: string | null }).s).toBe('cn-src');
    store.remove('cn-src');
    expect((engine.getDb().prepare("SELECT source_connection_id AS s FROM triggers WHERE id='tr1'").get() as { s: string | null }).s).toBeNull();
  });

  // 660a-1c S-2: a mandate's row in the instance trail names an API profile by this opaque id,
  // never by its slug. The id is the row's own: a save never changes it, a row without one gets one.
  describe('the opaque id of an API profile', () => {
    const APF = /^apf_[0-9a-f]{16}$/;
    const raw = (engine: EngineDb, id: string): string | null =>
      (engine.getDb().prepare('SELECT trail_id AS t FROM connections WHERE id = ?').get(id) as { t: string | null }).t;

    it('an API row gets one on insert and keeps it across saves, whatever a later save passes', () => {
      const { store, engine } = make();
      store.upsert(baseRow());
      const first = store.trailIdOf('cn1');
      expect(first).toMatch(APF);
      store.upsert(baseRow({ name: 'Stripe EU' }));
      store.upsert(baseRow({ trailId: 'apf_00000000000000aa' }));
      expect(store.trailIdOf('cn1')).toBe(first);
      expect(raw(engine, 'cn1')).toBe(first);
    });

    it('takes the id the caller made for a new row', () => {
      const { store } = make();
      store.upsert(baseRow({ trailId: 'apf_00000000000000aa' }));
      expect(store.trailIdOf('cn1')).toBe('apf_00000000000000aa');
    });

    it('a row without one gets one on its next save, and from the boot\'s fill', () => {
      const { store, engine } = make();
      store.upsert(baseRow());
      store.upsert(baseRow({ id: 'cn2' }));
      engine.getDb().exec('UPDATE connections SET trail_id = NULL');
      store.upsert(baseRow({ trailId: 'apf_00000000000000bb' }));
      expect(store.trailIdOf('cn1'), 'the save heals it, with the id it was given').toBe('apf_00000000000000bb');
      expect(raw(engine, 'cn2'), 'precondition: the other row is still without').toBeNull();
      expect(store.fillApiTrailIds()).toBe(1);
      expect(store.trailIdOf('cn2')).toMatch(APF);
      expect(store.fillApiTrailIds(), 'a second fill changes nothing').toBe(0);
    });

    it('another kind gets none, from a save or from the fill', () => {
      const { store, engine } = make();
      store.upsert(baseRow({ id: 'mail-1', kind: 'mail', trailId: 'apf_00000000000000cc' }));
      expect(raw(engine, 'mail-1')).toBeNull();
      expect(store.fillApiTrailIds()).toBe(0);
      expect(raw(engine, 'mail-1')).toBeNull();
    });

    it('reads only an API row: another kind under the same slug is never named as the profile', () => {
      const { store, engine } = make();
      store.upsert(baseRow({ id: 'mueller-crm', kind: 'mail' }));
      engine.getDb().exec("UPDATE connections SET trail_id = 'apf_00000000000000dd' WHERE id = 'mueller-crm'");
      expect(store.trailIdOf('mueller-crm')).toBeUndefined();
      expect(store.slugOfTrailId('apf_00000000000000dd')).toBeUndefined();
      // The control: the same slug as an API row is read.
      store.upsert(baseRow({ id: 'shop', trailId: 'apf_00000000000000ee' }));
      expect(store.trailIdOf('shop')).toBe('apf_00000000000000ee');
      expect(store.slugOfTrailId('apf_00000000000000ee')).toBe('shop');
    });

    it('the migration gives every existing API row its own id and no other kind one, and holds them unique', () => {
      const dir = mkdtempSync(join(tmpdir(), 'lynox-conn-mig-'));
      tmpDirs.push(dir);
      const path = join(dir, 'engine.db');
      const before = new EngineDb(path, '');
      const conn = new ConnectionStore(before);
      conn.upsert(baseRow({ id: 'a1' }));
      conn.upsert(baseRow({ id: 'a2' }));
      conn.upsert(baseRow({ id: 'm1', kind: 'mail' }));
      // A database from before v63: the column, its index and its version taken back out.
      before.getDb().exec('ALTER TABLE bulk_targets DROP COLUMN shop_added_markup; DROP INDEX idx_connections_trail_id; ALTER TABLE connections DROP COLUMN trail_id; DELETE FROM schema_version WHERE version >= 63;');
      before.close();
      const after = new EngineDb(path, '');
      engines.push(after);
      const rows = after.getDb().prepare('SELECT id, trail_id AS t FROM connections ORDER BY id').all() as Array<{ id: string; t: string | null }>;
      expect(rows.map((r) => r.id)).toEqual(['a1', 'a2', 'm1']);
      expect(rows[0]!.t).toMatch(APF);
      expect(rows[1]!.t).toMatch(APF);
      expect(rows[0]!.t).not.toBe(rows[1]!.t);
      expect(rows[2]!.t).toBeNull();
      expect(() => after.getDb().prepare("UPDATE connections SET trail_id = ? WHERE id = 'a2'").run(rows[0]!.t), 'the index holds the ids unique').toThrow(/UNIQUE/);
    });
  });
});
