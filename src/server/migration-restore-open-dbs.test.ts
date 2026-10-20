import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Server } from 'node:http';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import { EngineDb } from '../core/engine-db.js';
import { ConnectionStore } from '../core/connection-store.js';
import { ApiStore, type ApiProfile } from '../core/api-store.js';
import { MigrationExporter } from '../core/migration-export.js';
import type { MigrationImporter } from '../core/migration-import.js';
import { generateEphemeralKeypair, serializePublicKey, deserializePublicKey, deriveTransferKey } from '../core/migration-crypto.js';

/**
 * `POST /api/migration/restore` on a running engine. The restore renames new database files
 * over the ones the engine holds open, and a database's `-wal`/`-shm` belong to the path, not
 * to the file: with the old connection still open, the old database was replayed into the new
 * file, and the next boot read the old data with the migrated data gone. Measured on a real
 * engine boot, read back by a second process as the next boot reads it.
 */
describe('a migration restore on a running engine', () => {
  // Built at RUNTIME: a key-shaped literal in a fixture is what the commit-time secret
  // scan looks for, and this repo is public.
  const SECRET = `t-${randomBytes(12).toString('hex')}`;
  const SRC_KEY = `s-${randomBytes(12).toString('hex')}`;
  let api: LynoxHTTPApi;
  let baseUrl: string;
  let dir: string;
  let src: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE'];

  const profile = (id: string): ApiProfile => ({
    id, name: id, base_url: 'https://api.anthropic.com', description: id,
    auth: { type: 'bearer', vault_keys: ['X_TOKEN'] }, provenance: { source: 'manual', schema_version: 2 },
  });

  /** The api connection ids in `<dir>/engine.db`, read by a separate process: the next boot. */
  const nextBootIds = (): string[] => {
    const script = "const D=require('better-sqlite3');const d=new D(process.argv[1]);console.log(JSON.stringify(d.prepare(\"SELECT id FROM connections WHERE kind='api' ORDER BY id\").all().map(r=>r.id)));d.close();";
    return JSON.parse(execFileSync(process.execPath, ['-e', script, join(dir, 'engine.db')], { encoding: 'utf-8', cwd: process.cwd() })) as string[];
  };

  /** The marker the bundle's history/datastore/agent-memory carry, read by a separate process: the next boot. */
  const nextBootMark = (db: string): string => {
    const script = "const D=require('better-sqlite3');const d=new D(process.argv[1]);console.log(JSON.stringify(d.prepare('SELECT v FROM zz_mark').get()?.v ?? null));d.close();";
    return JSON.parse(execFileSync(process.execPath, ['-e', script, join(dir, db)], { encoding: 'utf-8', cwd: process.cwd() })) as string;
  };
  const OTHER_DBS = ['history.db', 'datastore.db', 'agent-memory.db'] as const;

  /** A migration session holding the source's bundle, set up as the handshake/manifest/chunk routes do. */
  async function session(): Promise<MigrationImporter> {
    const importer = await (api as unknown as { _getOrCreateMigrationImporter: () => Promise<MigrationImporter | null> })._getOrCreateMigrationImporter();
    if (importer === null) throw new Error('fixture: no importer');
    const sh = importer.startHandshake('e'.repeat(64));
    const kp = generateEphemeralKeypair();
    const key = deriveTransferKey(kp.privateKey, deserializePublicKey(sh.serverPubKey), Buffer.from(sh.challengeNonce, 'hex'));
    importer.completeHandshake(serializePublicKey(kp.publicKey));
    const { manifest, chunks } = new MigrationExporter({ lynoxDir: src, vaultKey: SRC_KEY }).export(key);
    importer.setManifest(manifest);
    for (const c of chunks) importer.receiveChunk(c);
    return importer;
  }

  /** The running engine writes to its engine.db; with the default checkpointing this stays in the WAL. */
  function writeLive(): void {
    const live = (api as unknown as { engine: { getApiStore: () => ApiStore | null } }).engine.getApiStore();
    if (live === null) throw new Error('fixture: no API store');
    expect(live.save(profile('liveonly')).ok).toBe(true);
    expect(nextBootIds()).toContain('liveonly'); // the reader sees what the engine wrote
  }

  /** The restore, with a request sent while it runs. */
  async function restoreWithRequestDuring(): Promise<{ restore: Response; during: Response }> {
    const restore = fetch(`${baseUrl}/api/migration/restore`, { method: 'POST', headers: { Authorization: `Bearer ${SECRET}` } });
    await new Promise((r) => setTimeout(r, 5));
    const during = await fetch(`${baseUrl}/api/health`, { headers: { Authorization: `Bearer ${SECRET}` } });
    return { restore: await restore, during };
  }

  beforeAll(() => {
    for (const k of ENV) saved[k] = process.env[k];
    src = mkdtempSync(join(tmpdir(), 'lynox-restore-src-'));
    // The source instance's engine.db carries the profile the migration brings.
    const se = new EngineDb(join(src, 'engine.db'), SRC_KEY);
    try {
      const store = new ApiStore();
      store.setConnectionStore(new ConnectionStore(se));
      store.save(profile('frombundle'));
    } finally {
      se.close();
    }
    // The other three databases travel too, each with a marker: the restore replaces all four.
    for (const db of OTHER_DBS) {
      const d = new Database(join(src, db));
      try {
        d.exec('CREATE TABLE zz_mark (v TEXT)');
        d.prepare('INSERT INTO zz_mark (v) VALUES (?)').run('frombundle');
      } finally {
        d.close();
      }
    }
  });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-restore-open-'));
    process.env['LYNOX_DATA_DIR'] = dir;
    process.env['LYNOX_HTTP_SECRET'] = SECRET;
    process.env['LYNOX_ALLOW_PLAIN_HTTP'] = 'true';
    process.env['LYNOX_VAULT_KEY'] = `v-${randomBytes(12).toString('hex')}`;
    delete process.env['LYNOX_BILLING_TIER'];
    delete process.env['LYNOX_MANAGED_MODE'];
    reloadConfig();
    api = new LynoxHTTPApi();
    await api.init();
    await api.start(0);
    const addr = (api as unknown as { server: Server | null }).server?.address();
    if (addr === null || addr === undefined || typeof addr === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${String(addr.port)}`;
    // The route answers on a managed instance only and reads the tier per request. Set after the
    // boot, which would otherwise want a control plane to talk to.
    process.env['LYNOX_BILLING_TIER'] = 'starter';
  }, 120_000);

  afterEach(async () => {
    // The restore closed the engine already; a second shutdown meets closed stores, as a
    // SIGTERM in the second before the restart does (best-effort there too, `index.ts`), and
    // throws before it closes the server: closed here.
    await api?.shutdown().catch(() => undefined);
    await new Promise<void>((r) => { const s = (api as unknown as { server: Server | null }).server; if (s === null) r(); else s.close(() => r()); });
    rmSync(dir, { recursive: true, force: true });
  });

  /** A shutdown hook that awaits first, as the managed hook does before the engine closes its stores. */
  function awaitingHook(settled: Promise<void>): void {
    (api as unknown as { engine: { registerHooks: (h: { onShutdown: () => Promise<void> }) => void } }).engine.registerHooks({ onShutdown: () => settled });
  }

  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(src, { recursive: true, force: true });
    reloadConfig();
  });

  it('the next boot reads the migrated databases, not the ones the engine had open; meanwhile other requests get 503', async () => {
    // The engine holds all four databases open, history.db twice (run history and the security audit).
    const e = (api as unknown as { engine: { getRunHistory: () => unknown; getSecurityAudit: () => unknown; getDataStore: () => unknown; getKnowledgeLayer: () => unknown } }).engine;
    expect([e.getRunHistory(), e.getSecurityAudit(), e.getDataStore(), e.getKnowledgeLayer()].map((s) => s !== null), 'fixture: every store open').toEqual([true, true, true, true]);
    writeLive();
    await session();
    awaitingHook(new Promise((r) => setTimeout(r, 50)));

    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      const { restore, during } = await restoreWithRequestDuring();
      expect(restore.status).toBe(200);
      expect(during.status).toBe(503);

      expect(nextBootIds()).toEqual(['frombundle']);
      // Nothing the shutdown left open holds a database: all four were swapped in.
      expect(Object.fromEntries(OTHER_DBS.map((db) => [db, nextBootMark(db)]))).toEqual({ 'history.db': 'frombundle', 'datastore.db': 'frombundle', 'agent-memory.db': 'frombundle' });

      await new Promise((r) => setTimeout(r, 1100));
      expect(exit).toHaveBeenCalledWith(0); // the restart the container's policy turns into a boot
    } finally {
      exit.mockRestore();
    }
  }, 120_000);

  it('a restore that throws after the engine closed answers 500 and restarts too', async () => {
    writeLive();
    const importer = await session();
    vi.spyOn(importer, 'restore').mockImplementation(() => { throw new Error('restore boom'); });

    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      const { restore, during } = await restoreWithRequestDuring();
      expect(restore.status).toBe(500);
      expect(((await restore.json()) as { error?: string }).error).toMatch(/restore boom/);
      expect(during.status).toBe(503);

      await new Promise((r) => setTimeout(r, 1100));
      expect(exit).toHaveBeenCalledWith(1); // a closed engine does not keep serving
    } finally {
      exit.mockRestore();
    }
  }, 120_000);

  it('a restore without every chunk answers 400 and closes nothing', async () => {
    const importer = await (api as unknown as { _getOrCreateMigrationImporter: () => Promise<MigrationImporter | null> })._getOrCreateMigrationImporter();
    if (importer === null) throw new Error('fixture: no importer');
    const sh = importer.startHandshake('e'.repeat(64));
    const kp = generateEphemeralKeypair();
    const key = deriveTransferKey(kp.privateKey, deserializePublicKey(sh.serverPubKey), Buffer.from(sh.challengeNonce, 'hex'));
    importer.completeHandshake(serializePublicKey(kp.publicKey));
    importer.setManifest(new MigrationExporter({ lynoxDir: src, vaultKey: SRC_KEY }).export(key).manifest); // no chunk sent

    const res = await fetch(`${baseUrl}/api/migration/restore`, { method: 'POST', headers: { Authorization: `Bearer ${SECRET}` } });
    expect(res.status).toBe(400);
    // Nothing was closed: the instance still serves, and the engine still writes.
    expect((await fetch(`${baseUrl}/api/health`, { headers: { Authorization: `Bearer ${SECRET}` } })).status).toBe(200);
    writeLive();
  }, 120_000);
});
