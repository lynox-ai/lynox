import { describe, it, expect, afterEach, vi } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from './engine.js';
import { EngineDb } from './engine-db.js';
import { reloadConfig } from './config.js';
import { _resetSdkLogQuieting } from './llm-wire-rules.js';
import { _resetWireCaptureClosed } from './wire-capture.js';
import { isErrorReportingEnabled, isErrorReportingRefused, shutdownErrorReporting, _resetForTesting as _resetErrorReporting } from './error-reporting.js';
import type { LynoxConfig } from '../types/index.js';

/**
 * The BOOT proof for S3's debug refusal (PRD-SHOPIFY-CONTAINMENT-ERASURE E4): a real Engine,
 * booted against a data dir whose engine.db already holds the exact marker, comes up with the
 * debug variables gone. Without the marker they stay. A unit test of `refuseDebug` cannot see
 * whether `init()` reaches it, which is the property this file is about.
 */
// A real boot takes 3-5 s here; the default 10 s leaves little room on a loaded runner.
describe('Engine boot — an instance that holds the exact marker boots with its debug paths off', { timeout: 30_000 }, () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  const ENV_KEYS = ['LYNOX_DATA_DIR', 'ANTHROPIC_LOG', 'LYNOX_DEBUG_WIRE_ALLOW_PROVISIONED', 'LYNOX_MANAGED_INSTANCE_ID', 'LYNOX_MANAGED_CONTROL_PLANE_URL', 'LYNOX_HTTP_SECRET', 'LYNOX_BUGSINK_DSN'] as const;
  const saved = new Map<string, string | undefined>();
  const setEnv = (key: string, value: string | undefined): void => {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  };

  afterEach(async () => {
    for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
    engines.length = 0;
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    saved.clear();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    _resetSdkLogQuieting();
    _resetWireCaptureClosed();
    await shutdownErrorReporting();
    _resetErrorReporting();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    reloadConfig();
  });

  function freshDataDir(label: string): string {
    const dir = mkdtempSync(join(tmpdir(), `lynox-${label}-`));
    dirs.push(dir);
    for (const k of ENV_KEYS) setEnv(k, undefined);
    setEnv('LYNOX_DATA_DIR', dir);
    return dir;
  }

  async function boot(): Promise<Engine> {
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();
    return engine;
  }

  it('marker set before boot: the debug variables are gone after init()', async () => {
    freshDataDir('exact-held');
    const db = new EngineDb();
    db.setExactMarker();
    db.close();
    setEnv('ANTHROPIC_LOG', 'debug');
    setEnv('LYNOX_DEBUG_WIRE_ALLOW_PROVISIONED', '1');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await boot();
    expect(process.env['ANTHROPIC_LOG']).toBeUndefined();
    expect(process.env['LYNOX_DEBUG_WIRE_ALLOW_PROVISIONED']).toBeUndefined();
  });

  it('engine.db does not open: the boot fails closed and the variables are gone', async () => {
    const dir = freshDataDir('exact-nodb');
    mkdirSync(join(dir, 'engine.db'));
    setEnv('ANTHROPIC_LOG', 'debug');
    setEnv('LYNOX_DEBUG_WIRE_ALLOW_PROVISIONED', '1');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const engine = await boot();
    expect(engine.getToolContext().exactClearance).toBeNull();
    expect(process.env['ANTHROPIC_LOG']).toBeUndefined();
    expect(process.env['LYNOX_DEBUG_WIRE_ALLOW_PROVISIONED']).toBeUndefined();
  });

  it('the first clearance of a booted engine closes the debug paths (the hook is wired)', async () => {
    freshDataDir('exact-first');
    setEnv('LYNOX_MANAGED_CONTROL_PLANE_URL', 'http://cp.invalid');
    setEnv('LYNOX_MANAGED_INSTANCE_ID', 'i-boot');
    setEnv('LYNOX_HTTP_SECRET', 's');
    setEnv('ANTHROPIC_LOG', 'debug');
    setEnv('LYNOX_DEBUG_WIRE_ALLOW_PROVISIONED', '1');

    const engine = await boot();
    expect(process.env['ANTHROPIC_LOG']).toBe('debug');
    vi.stubGlobal('fetch', (async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await engine.getToolContext().exactClearance!.ensure()).toEqual({ ok: true });
    expect(process.env['ANTHROPIC_LOG']).toBeUndefined();
    expect(process.env['LYNOX_DEBUG_WIRE_ALLOW_PROVISIONED']).toBeUndefined();
  });

  it('a data dir rolled back to before the marker: closed again before the next clearance resolves', async () => {
    const dir = freshDataDir('exact-rollback');
    const db = new EngineDb();
    db.close();
    copyFileSync(join(dir, 'engine.db'), join(dir, 'engine.db.before'));
    const held = new EngineDb();
    held.setExactMarker();
    held.close();
    copyFileSync(join(dir, 'engine.db.before'), join(dir, 'engine.db'));
    setEnv('LYNOX_MANAGED_CONTROL_PLANE_URL', 'http://cp.invalid');
    setEnv('LYNOX_MANAGED_INSTANCE_ID', 'i-boot');
    setEnv('LYNOX_HTTP_SECRET', 's');
    setEnv('ANTHROPIC_LOG', 'debug');

    const engine = await boot();
    // The rolled-back file holds no marker, so the boot leaves the variable alone ...
    expect(process.env['ANTHROPIC_LOG']).toBe('debug');
    vi.stubGlobal('fetch', (async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const clearance = engine.getToolContext().exactClearance!;
    // ... and a store pass is minted only after `ensure()` resolves ok: by then it is gone.
    const result = await clearance.ensure();
    expect(result).toEqual({ ok: true });
    expect(process.env['ANTHROPIC_LOG']).toBeUndefined();
    expect(clearance.blockedNow()).toBe(false);
  });

  it('error reporting: on without the marker, off and refused with it', async () => {
    const dsn = 'https://key@bugs.example.invalid/1';
    freshDataDir('exact-bugsink-free');
    setEnv('LYNOX_BUGSINK_DSN', dsn);
    await boot();
    expect(isErrorReportingEnabled()).toBe(true);
    expect(process.env['LYNOX_BUGSINK_DSN']).toBe(dsn);
    for (const e of engines.splice(0)) await e.shutdown();
    await shutdownErrorReporting();
    _resetErrorReporting();

    freshDataDir('exact-bugsink-held');
    const db = new EngineDb();
    db.setExactMarker();
    db.close();
    setEnv('LYNOX_BUGSINK_DSN', dsn);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await boot();
    expect(isErrorReportingEnabled()).toBe(false);
    expect(isErrorReportingRefused()).toBe(true);
    expect(process.env['LYNOX_BUGSINK_DSN']).toBeUndefined();
  });

  it('no marker: the variables stay (the refusal keys on the marker, not on the boot)', async () => {
    freshDataDir('exact-free');
    setEnv('ANTHROPIC_LOG', 'debug');
    setEnv('LYNOX_DEBUG_WIRE_ALLOW_PROVISIONED', '1');

    await boot();
    expect(process.env['ANTHROPIC_LOG']).toBe('debug');
    expect(process.env['LYNOX_DEBUG_WIRE_ALLOW_PROVISIONED']).toBe('1');
  });
});
