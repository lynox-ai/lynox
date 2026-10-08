import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import { DATA_DIR_INVENTORY } from '../core/data-dir-inventory.js';
import { scopeToDir } from '../core/scope-resolver.js';
import type { Memory } from '../core/memory.js';
import type { ArtifactStore } from '../core/artifact-store.js';
import type { MailStateDb } from '../integrations/mail/state.js';
import type { WebPushNotificationChannel } from '../integrations/push/web-push-channel.js';
import type { ApiStore } from '../core/api-store.js';
import type { BatchIndex } from '../core/batch-index.js';
import type { BackupManager } from '../core/backup.js';

/**
 * `DELETE /api/data` erases what the data-dir inventory says it erases — measured on a
 * real engine, entry by entry, against what lies on disk afterwards.
 *
 * The expectation per entry comes from the inventory, and that is deliberate here: this
 * file asserts that the ROUTE honours the table. Whether the table's decisions are right
 * is pinned against a hand-written list in `data-dir-erase.test.ts`, so a decision flipped
 * in the table fails there, not silently here.
 *
 * Before this, the erasure kept its own list: `artifacts/`, `apis/`, `workspace/`,
 * `backups/`, `mail-state.db`, `push-subscriptions.db` and the engine's own recovery
 * copies all survived an answer of "All user data has been permanently deleted".
 */
describe('Art. 17 erasure follows the data-dir inventory (real engine)', () => {
  // Built at RUNTIME: a key-shaped literal in a fixture is what the commit-time secret
  // scan looks for, and this repo is public.
  const SECRET = `t-${randomBytes(12).toString('hex')}`;
  let api: LynoxHTTPApi;
  let baseUrl: string;
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE'];
  // A user scope this boot never loaded, so the read below fills the cache from disk —
  // the cache is part of what is asserted, and a scope cached earlier would answer stale.
  const USER = { type: 'user', id: `zz${randomBytes(3).toString('hex')}` } as const;

  interface EngineView {
    getMemory: () => Memory | null;
    getArtifactStore: () => ArtifactStore | null;
    getMailStateDb: () => MailStateDb | null;
    getApiStore: () => ApiStore | null;
    getBatchIndex: () => BatchIndex;
    getBackupManager: () => BackupManager | null;
  }
  const engineOf = (): EngineView => (api as unknown as { engine: EngineView }).engine;
  const pushOf = (): WebPushNotificationChannel => {
    const p = (api as unknown as { pushChannel: WebPushNotificationChannel | null }).pushChannel;
    if (p === null) throw new Error('fixture: no push channel');
    return p;
  };
  const internals = (): { erasureInProgress: boolean; erasureGeneration: number } =>
    api as unknown as { erasureInProgress: boolean; erasureGeneration: number };

  const mark = (name: string): string => `ZZMARK-${name}-${randomBytes(3).toString('hex')}`;

  async function erase(body: Record<string, unknown> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${baseUrl}/api/data`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'DELETE_ALL_DATA', ...body }),
    });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-erasure-dir-'));
    for (const k of ENV) saved[k] = process.env[k];
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
  }, 120_000);

  afterAll(async () => {
    try {
      await api?.shutdown();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
      reloadConfig();
    }
  });

  it('refuses with 409 and erases nothing while the data dir holds an entry it does not know', async () => {
    // In the scope the flat-file step empties (the current one, a context), so an
    // unchanged marker says that step did not run.
    const memory = engineOf().getMemory();
    if (memory === null) throw new Error('fixture: no flat-file memory');
    const memPath = join(dir, 'memory', scopeToDir(memory.currentScope()), 'knowledge.txt');
    const memMark = mark('memory');
    mkdirSync(join(memPath, '..'), { recursive: true });
    writeFileSync(memPath, memMark);
    writeFileSync(join(dir, 'zz-unknown.db'), mark('unknown'));
    writeFileSync(join(dir, 'secrets.json'), mark('secrets'));
    const genBefore = internals().erasureGeneration;

    const first = await erase();
    expect(first.status).toBe(409);
    expect(first.body['code']).toBe('unknown_entries');
    const unknown = first.body['unknown'] as Array<{ name: string }>;
    expect(unknown.map(u => u.name)).toEqual(['zz-unknown.db']);
    // What is removed under a known name is named too, so the agreement covers it; what is
    // kept or emptied in place is not.
    const alsoRemoved = first.body['also_removed'] as string[];
    expect(alsoRemoved).toContain('secrets.json');
    expect(alsoRemoved).not.toContain('vault.key');
    expect(alsoRemoved).not.toContain('engine.db');
    // Nothing erased: the FIRST destructive step (flat-file memory) did not run, the
    // flag is down, and the erasure counted nothing.
    expect(readFileSync(memPath, 'utf8')).toBe(memMark);
    expect(internals().erasureInProgress).toBe(false);
    expect(internals().erasureGeneration).toBe(genBefore);

    // An acknowledgement that does not match what was reported changes nothing either.
    const wrong = await erase({ remove_unknown: [{ ...unknown[0]!, name: 'other.db' }] });
    expect(wrong.status).toBe(409);
    expect(existsSync(join(dir, 'zz-unknown.db'))).toBe(true);

    // Echoed back unchanged, the entry is removed with the rest.
    const second = await erase({ remove_unknown: unknown });
    expect(second.status).toBe(200);
    expect(existsSync(join(dir, 'zz-unknown.db'))).toBe(false);
  }, 60_000);

  it('erases every entry the inventory owes, through the open stores and on disk, and keeps the rest', async () => {
    const e = engineOf();
    const before = new Map<string, string>();
    const owedMarks = new Map<string, string>();

    for (const entry of DATA_DIR_INVENTORY) {
      const path = join(dir, entry.name);
      if (entry.erase.by === 'keep') {
        if (!existsSync(path)) writeFileSync(path, mark(entry.name));
        if (statSync(path).isFile()) before.set(entry.name, readFileSync(path, 'utf8'));
        continue;
      }
      if (entry.erase.by !== 'remove') continue;
      const m = mark(entry.name);
      owedMarks.set(entry.name, m);
      if (entry.kind === 'dir') {
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, 'seeded.txt'), m);
      } else {
        writeFileSync(path, m);
      }
    }
    // The engine's own residue, and a crash-left atomic temp of the config.
    for (const name of ['engine.db.corrupt-1700000000000', 'vault.db.rotate-bak', 'config.json.1.deadbeef.tmp']) {
      writeFileSync(join(dir, name), mark(name));
    }
    // The stores held open: mail-state, push, flat-file memory (and its cache), artifacts.
    const mail = e.getMailStateDb();
    if (mail === null) throw new Error('fixture: mail-state.db never opened');
    mail.getConnection().exec('CREATE TABLE IF NOT EXISTS zz_seed (v TEXT)');
    mail.getConnection().prepare('INSERT INTO zz_seed (v) VALUES (?)').run(mark('mail-state'));
    pushOf().subscribe(`https://push.example/${randomBytes(4).toString('hex')}`, 'p256dh', 'auth');
    const memory = e.getMemory();
    if (memory === null) throw new Error('fixture: no flat-file memory');
    const userDir = join(dir, 'memory', `user-${USER.id}`);
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'knowledge.txt'), mark('memory-user'));
    expect(await memory.loadScoped('knowledge', USER)).toMatch(/^ZZMARK-memory-user/);   // now cached
    const artifacts = e.getArtifactStore();
    if (artifacts === null) throw new Error('fixture: no artifact store');
    artifacts.save({ title: mark('artifact-title'), content: 'x' });
    expect(artifacts.list().length).toBe(1);
    const apiStore = e.getApiStore();
    if (apiStore === null) throw new Error('fixture: no API store');
    apiStore.register({ id: 'zz-api', name: 'ZZ', base_url: 'https://api.example.test/v1', description: 'zz', auth: { type: 'bearer' } }, 'load');
    expect(apiStore.getAll().map(p => p.id)).toContain('zz-api');
    await e.getBatchIndex().save('zz-batch', { submitted_at: '2026-01-01T00:00:00Z', request_count: 1, label: mark('batch') });
    // The directory the backup manager writes to, which a config change can leave apart
    // from the configured `backup_dir`.
    const bm = e.getBackupManager();
    if (bm === null) throw new Error('fixture: no backup manager');
    const managerDir = mkdtempSync(join(tmpdir(), 'lynox-erasure-bk-'));
    (bm as unknown as { backupDir: string }).backupDir = managerDir;
    mkdirSync(join(managerDir, '2026-10-08T19301234Z'));
    writeFileSync(join(managerDir, '2026-10-08T19301234Z', 'engine.db'), mark('backup-copy'));

    const res = await erase();
    expect(res.body['failed'] ?? []).toEqual([]);
    expect(res.status).toBe(200);
    expect(res.body['message']).toBe('All user data has been permanently deleted');

    for (const [name, m] of owedMarks) {
      const path = join(dir, name);
      if (!existsSync(path)) continue;
      const st = statSync(path);
      if (st.isDirectory()) expect(readdirSync(path), `${name} kept content`).toEqual([]);
      else expect(readFileSync(path, 'utf8'), `${name} survived`).not.toBe(m);
    }
    for (const name of ['engine.db.corrupt-1700000000000', 'vault.db.rotate-bak', 'config.json.1.deadbeef.tmp']) {
      expect(existsSync(join(dir, name)), `${name} survived`).toBe(false);
    }
    for (const [name, bytes] of before) expect(readFileSync(join(dir, name), 'utf8'), `${name} was changed`).toBe(bytes);

    expect((mail.getConnection().prepare('SELECT COUNT(*) AS n FROM zz_seed').get() as { n: number }).n).toBe(0);
    expect(pushOf().subscriptionCount()).toBe(0);
    expect(existsSync(join(userDir, 'knowledge.txt'))).toBe(false);
    expect(await memory.loadScoped('knowledge', USER)).toBeNull();
    expect(artifacts.list()).toEqual([]);
    expect(apiStore.getAll()).toEqual([]);
    expect(await e.getBatchIndex().get('zz-batch')).toBeNull();
    expect(readdirSync(managerDir)).toEqual([]);
    rmSync(managerDir, { recursive: true, force: true });
  }, 60_000);

  it('refuses with 409 and erases nothing while an entry it owes is a link it would have to follow', async () => {
    const memory = engineOf().getMemory();
    if (memory === null) throw new Error('fixture: no flat-file memory');
    const memPath = join(dir, 'memory', scopeToDir(memory.currentScope()), 'knowledge.txt');
    const memMark = mark('memory');
    mkdirSync(join(memPath, '..'), { recursive: true });
    writeFileSync(memPath, memMark);
    const target = mkdtempSync(join(tmpdir(), 'lynox-erasure-link-'));
    writeFileSync(join(target, 'copy.txt'), mark('target'));
    rmSync(join(dir, 'backups'), { recursive: true, force: true });
    symlinkSync(target, join(dir, 'backups'));
    const genBefore = internals().erasureGeneration;
    try {
      const res = await erase();
      expect(res.status).toBe(409);
      expect(res.body['code']).toBe('linked_entries');
      expect((res.body['linked'] as Array<{ name: string }>).map(l => l.name)).toEqual(['backups']);
      expect(readFileSync(memPath, 'utf8')).toBe(memMark);
      expect(readdirSync(target)).toEqual(['copy.txt']);
      expect(internals().erasureInProgress).toBe(false);
      expect(internals().erasureGeneration).toBe(genBefore);
    } finally {
      unlinkSync(join(dir, 'backups'));
      rmSync(target, { recursive: true, force: true });
    }
  }, 60_000);
});
