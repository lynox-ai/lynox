import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import type { LynoxConfig } from '../types/index.js';
import { GOOGLE_NOT_CONNECTED } from '../integrations/google/not-connected.js';
import type { IAgent } from '../types/index.js';

/**
 * Visibility is not availability (PRD Stage 1 §3.2).
 *
 * A unit test of `createGoogleTools` cannot see whether `init()` actually
 * reaches for it — that is the same blind spot `engine-client-pair-boot.test.ts`
 * exists for, one key over. This boots a REAL engine with no Google credential
 * anywhere and asserts the four tools are in the registry and refuse.
 *
 * Deliberately unmocked: the point is the wiring, and a mocked factory would
 * make the registration loop unobservable by construction.
 */
const GOOGLE_TOOLS = ['google_drive', 'google_calendar', 'google_sheets', 'google_docs'] as const;

describe('Engine boot — the Google tools are visible before a credential exists', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  const ENV_KEYS = ['LYNOX_DATA_DIR', 'LYNOX_VAULT_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
    'GOOGLE_SERVICE_ACCOUNT_KEY', 'LYNOX_MANAGED_INSTANCE_ID'] as const;
  const saved = new Map<string, string | undefined>();

  function setEnv(key: string, value: string | undefined): void {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }

  afterEach(async () => {
    for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
    engines.length = 0;
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    saved.clear();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    reloadConfig();
  });

  async function bootWithoutCredential(): Promise<Engine> {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-gvis-'));
    dirs.push(dir);
    for (const k of ENV_KEYS) setEnv(k, undefined);
    setEnv('LYNOX_DATA_DIR', dir);
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();
    return engine;
  }

  it('registers all four with no client pair anywhere', async () => {
    // MUTATION THIS KILLS: putting the registration back inside `if (googlePair)`.
    // Before 2026-09-01 this booted with ZERO Google tools.
    const engine = await bootWithoutCredential();
    expect(engine.getGoogleAuth(), 'no credential must resolve').toBeNull();
    const names = engine.getRegistry().getEntries().map(e => e.definition.name);
    for (const t of GOOGLE_TOOLS) {
      expect(names, `${t} must be registered without a credential`).toContain(t);
    }
  });

  it('and each of them refuses with the connect-path sentence', async () => {
    // Registration without the refusal would be worse than hiding them: the
    // model would see four tools and get an opaque failure.
    const engine = await bootWithoutCredential();
    const entries = engine.getRegistry().getEntries();
    for (const t of GOOGLE_TOOLS) {
      const entry = entries.find(e => e.definition.name === t);
      expect(entry, `${t} must exist`).toBeDefined();
      const handler = (entry as unknown as { handler: (i: unknown, a: IAgent) => Promise<string> }).handler;
      await expect(handler({ action: 'list' }, {} as IAgent)).resolves.toBe(GOOGLE_NOT_CONNECTED);
    }
  });

  it('reloadGoogle does not touch the registry — the loop has one home now', async () => {
    // ⚠ The first version of this test asserted `names.filter(n => n === t)` had
    // length 1. That CANNOT FAIL: `ToolRegistry.register` is `this.tools.set(name,
    // entry)` on a Map, so a duplicate is impossible for any implementation. And
    // its named mutation never ran, because `reloadGoogle()` returns at `if
    // (!pair)` and the fixture booted without one. Two independent reasons for a
    // green that meant nothing.
    //
    // The falsifiable quantity is the registry's own counter: `register()`
    // increments `_version` on every CALL, duplicate or not. So a registration
    // loop re-added to `reloadGoogle()` moves it, and this asserts it does not.
    //
    // MUTATION THIS KILLS: put the `for (const tool of tools) register(tool)` loop
    // back into `reloadGoogle()`.
    const dir = mkdtempSync(join(tmpdir(), 'lynox-gvis-reload-'));
    dirs.push(dir);
    for (const k of ENV_KEYS) setEnv(k, undefined);
    setEnv('LYNOX_DATA_DIR', dir);
    // A real pair, so `reloadGoogle()` gets PAST its early return — without one
    // the mutation above would not execute and the test would prove nothing.
    setEnv('GOOGLE_CLIENT_ID', 'reload-id');
    setEnv('GOOGLE_CLIENT_SECRET', 'reload-secret');
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();

    const before = engine.getRegistry().version;
    const ok = await engine.reloadGoogle();
    expect(ok, 'the fixture must reach the credential branch, or the mutation cannot run').toBe(true);
    expect(engine.getRegistry().version - before, 'reloadGoogle must register nothing').toBe(0);
  });
});

describe('Engine — the brokered credential is built late, on the claim', () => {
  const dirs2: string[] = [];
  const engines2: Engine[] = [];
  const saved2 = new Map<string, string | undefined>();
  function setEnv2(key: string, value: string | undefined): void {
    if (!saved2.has(key)) saved2.set(key, process.env[key]);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  afterEach(async () => {
    for (const e of engines2) { try { await e.shutdown(); } catch { /* best effort */ } }
    engines2.length = 0;
    for (const [k, v] of saved2) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    saved2.clear();
    for (const d of dirs2) rmSync(d, { recursive: true, force: true });
    dirs2.length = 0;
    reloadConfig();
  });
  async function boot(managed: boolean): Promise<Engine> {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-gbrk-'));
    dirs2.push(dir);
    for (const k of ['LYNOX_DATA_DIR', 'LYNOX_VAULT_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
      'GOOGLE_SERVICE_ACCOUNT_KEY', 'LYNOX_MANAGED_INSTANCE_ID']) setEnv2(k, undefined);
    setEnv2('LYNOX_DATA_DIR', dir);
    if (managed) setEnv2('LYNOX_MANAGED_INSTANCE_ID', 'inst-1');
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines2.push(engine);
    await engine.init();
    return engine;
  }

  it('a managed tenant with no pair gets one built on demand', async () => {
    // The claim route calls this. Before the change it asked getGoogleAuth() and
    // refused — the claim is what CREATES the credential, so the gate refused the
    // only flow that could satisfy it.
    // MUTATION THIS KILLS: point the claim route back at getGoogleAuth().
    const engine = await boot(true);
    expect(engine.getGoogleAuth(), 'nothing at boot — no pair resolves').toBeNull();
    const auth = await engine.ensureGoogleAuth();
    expect(auth, 'a managed tenant must get a brokered credential').not.toBeNull();
    expect(engine.getGoogleAuth(), 'and it must be installed, not handed out once').toBe(auth);
  });

  it('a SELF-HOST instance with no pair gets nothing — it has nothing to claim', async () => {
    // MUTATION THIS KILLS: dropping the LYNOX_MANAGED_INSTANCE_ID gate, which
    // would hand every self-host instance a credential that can do nothing and
    // silently disable its own OAuth entry points.
    const engine = await boot(false);
    await expect(engine.ensureGoogleAuth()).resolves.toBeNull();
  });
});
