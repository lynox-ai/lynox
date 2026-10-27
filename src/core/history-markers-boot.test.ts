import { describe, it, expect, afterEach, vi } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Engine } from './engine.js';
import { EngineDb } from './engine-db.js';
import { RunHistory } from './run-history.js';
import { ContainmentMirror as ContainmentMirrorImpl, ExactMirror } from './history-markers.js';
import type { ContainmentMirror } from './history-markers.js';
import { reloadConfig } from './config.js';
import { _resetSdkLogQuieting } from './llm-wire-rules.js';
import { _resetWireCaptureClosed } from './wire-capture.js';
import { shutdownErrorReporting, _resetForTesting as _resetErrorReporting } from './error-reporting.js';
import type { LynoxConfig } from '../types/index.js';

/**
 * The BOOT proof for cut S3-E (`history-markers.ts`): a real Engine, booted against a data dir
 * whose engine.db was set aside on corruption or rolled back, keeps the threads it had contained
 * and its debug paths off, from history.db's copies. A foreign copy holds the debug paths on a
 * provisioned instance and is written nowhere; without a control plane it is not read at all.
 */
describe('Engine boot — the markers outlive engine.db', { timeout: 60_000 }, () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  const ENV_KEYS = ['LYNOX_DATA_DIR', 'ANTHROPIC_LOG', 'LYNOX_DEBUG_WIRE_ALLOW_PROVISIONED', 'LYNOX_MANAGED_INSTANCE_ID', 'LYNOX_MANAGED_CONTROL_PLANE_URL', 'LYNOX_HTTP_SECRET', 'LYNOX_BUGSINK_DSN', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE'] as const;
  const saved = new Map<string, string | undefined>();
  const setEnv = (key: string, value: string | undefined): void => {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  };

  afterEach(async () => {
    for (const e of engines.splice(0)) { try { await e.shutdown(); } catch { /* best effort */ } }
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    saved.clear();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    _resetSdkLogQuieting();
    _resetWireCaptureClosed();
    await shutdownErrorReporting();
    _resetErrorReporting();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    reloadConfig();
  });

  function freshDataDir(label: string, managed: boolean): string {
    const dir = mkdtempSync(join(tmpdir(), `lynox-s3e-${label}-`));
    dirs.push(dir);
    for (const k of ENV_KEYS) setEnv(k, undefined);
    setEnv('LYNOX_DATA_DIR', dir);
    if (managed) {
      setEnv('LYNOX_MANAGED_CONTROL_PLANE_URL', 'http://cp.invalid');
      setEnv('LYNOX_MANAGED_INSTANCE_ID', 'i-boot');
      setEnv('LYNOX_HTTP_SECRET', 's');
    }
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    return dir;
  }

  async function boot(): Promise<Engine> {
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();
    return engine;
  }

  async function stop(): Promise<void> {
    for (const e of engines.splice(0)) await e.shutdown();
  }

  /** A first boot that clears exact through the control plane and contains thread `t1`. */
  async function holdAndContain(): Promise<void> {
    const engine = await boot();
    vi.stubGlobal('fetch', (async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch);
    expect(await engine.getToolContext().exactClearance!.ensure()).toEqual({ ok: true });
    engine.getToolContext().containment!.contain({ kind: 'thread', id: 't1' }, { kind: 'api', connectionId: 'shop-acme' });
    vi.unstubAllGlobals();
    await stop();
  }

  const engineMarkerSet = (dir: string): boolean => {
    const raw = new Database(join(dir, 'engine.db'), { readonly: true });
    try { return raw.prepare('SELECT 1 FROM exact_marker WHERE id = 1').get() !== undefined; } finally { raw.close(); }
  };

  it('engine.db set aside on corruption: the thread stays contained, debug stays off, the marker is written back', async () => {
    const dir = freshDataDir('recreate', true);
    await holdAndContain();
    writeFileSync(join(dir, 'engine.db'), 'this is not a sqlite database, it is garbage bytes');
    for (const s of ['-wal', '-shm']) rmSync(join(dir, `engine.db${s}`), { force: true });
    setEnv('ANTHROPIC_LOG', 'debug');

    const engine = await boot();
    expect(readdirSync(dir).some((f) => f.startsWith('engine.db.corrupt-'))).toBe(true);
    expect(process.env['ANTHROPIC_LOG']).toBeUndefined();
    expect(engine.getToolContext().containment!.isContained({ threadId: 't1' })).toBe(true);
    expect(engine.getToolContext().containment!.isContained({ threadId: 't2' })).toBe(false);
    expect(engine.getEngineDb()!.exactMarkerSet()).toBe(true);
  });

  it('engine.db rolled back to before the marker the boot recorded: debug is off at boot', async () => {
    const dir = freshDataDir('rollback', true);
    new EngineDb().close();
    copyFileSync(join(dir, 'engine.db'), join(dir, 'engine.db.before'));
    await holdAndContain();
    copyFileSync(join(dir, 'engine.db.before'), join(dir, 'engine.db'));
    for (const s of ['-wal', '-shm']) rmSync(join(dir, `engine.db${s}`), { force: true });
    setEnv('ANTHROPIC_LOG', 'debug');

    const engine = await boot();
    expect(process.env['ANTHROPIC_LOG']).toBeUndefined();
    expect(engine.getToolContext().containment!.isContained({ threadId: 't1' })).toBe(true);
  });

  it('provisioned, history.db with another instance\'s copy: debug is off and nothing is written', async () => {
    const dir = freshDataDir('foreign-managed', true);
    const h = new RunHistory();
    new ExactMirror(h.getDb(), 'someone-else').set();
    h.close();
    setEnv('ANTHROPIC_LOG', 'debug');

    const engine = await boot();
    expect(process.env['ANTHROPIC_LOG']).toBeUndefined();
    await stop();
    expect(engineMarkerSet(dir)).toBe(false);
    void engine;
  });

  it('self-host, history.db with another instance\'s copy: debug stays on and nothing is written', async () => {
    const dir = freshDataDir('foreign-selfhost', false);
    const h = new RunHistory();
    new ExactMirror(h.getDb(), 'someone-else').set();
    h.close();
    setEnv('ANTHROPIC_LOG', 'debug');

    await boot();
    expect(process.env['ANTHROPIC_LOG']).toBe('debug');
    await stop();
    expect(engineMarkerSet(dir)).toBe(false);
  });

  it('S2 tripwire: the copy sits on the thread store\'s handle, which is not engine.db\'s', async () => {
    freshDataDir('s2', false);
    const engine = await boot();
    const mirror = (engine as unknown as { _containmentMirror: ContainmentMirror | null })._containmentMirror;
    const threadStoreDb = (engine.getThreadStore() as unknown as { db: Database.Database }).db;
    expect(mirror).not.toBeNull();
    expect(threadStoreDb).toBeDefined();
    expect(mirror!.handle).toBe(threadStoreDb);
    expect(mirror!.handle).not.toBe(engine.getEngineDb()!.getDb());
  });
  it('a thread contained before the copy existed is copied by the boot and survives the next recreate', async () => {
    const dir = freshDataDir('backfill', false);
    // engine.db as an instance left it before v70: the row, and no copy anywhere.
    const e = new EngineDb();
    e.getDb().prepare("INSERT INTO contained VALUES ('thread', 'old-1', 'api', 'shop-acme', datetime('now'))").run();
    e.close();
    await boot();
    await stop();
    writeFileSync(join(dir, 'engine.db'), 'this is not a sqlite database, it is garbage bytes');
    for (const s of ['-wal', '-shm']) rmSync(join(dir, `engine.db${s}`), { force: true });

    const engine = await boot();
    expect(engine.getToolContext().containment!.isContained({ threadId: 'old-1' })).toBe(true);
    expect(engine.getToolContext().containment!.isContained({ threadId: 'other' })).toBe(false);
  });

  it('engine.db does not open: reads answer from the copy, nothing can be contained', async () => {
    const dir = freshDataDir('no-engine', false);
    const h = new RunHistory();
    new ContainmentMirrorImpl(h.getDb()).write('t1', { kind: 'api', connectionId: 'shop-acme' });
    h.close();
    mkdirSync(join(dir, 'engine.db'));

    const engine = await boot();
    const containment = engine.getToolContext().containment!;
    expect(containment.canContain).toBe(false);
    expect(containment.isContained({ threadId: 't1' })).toBe(true);
    expect(containment.isContained({ threadId: 't2' })).toBe(false);
    expect(() => containment.contain({ kind: 'thread', id: 't2' }, { kind: 'api', connectionId: 'shop-acme' })).toThrow();
    expect(engine.getToolContext().exactClearance).toBeNull();
  });

  it('provisioned, control-plane env incomplete: a copy holds debug off and nothing is written', async () => {
    const dir = freshDataDir('incomplete-cp', false);
    // The instance id without the rest, as a boot whose secret is missing has it.
    setEnv('LYNOX_MANAGED_INSTANCE_ID', 'i-boot');
    const h = new RunHistory();
    new ExactMirror(h.getDb(), 'i-boot').set();
    h.close();
    setEnv('ANTHROPIC_LOG', 'debug');

    await boot();
    expect(process.env['ANTHROPIC_LOG']).toBeUndefined();
    await stop();
    expect(engineMarkerSet(dir)).toBe(false);
  });
});
