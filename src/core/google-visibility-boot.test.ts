import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import type { LynoxConfig } from '../types/index.js';
import { GOOGLE_NOT_CONNECTED } from '../integrations/google/not-connected.js';
import { GOOGLE_PROMPT_SUFFIX } from './prompts.js';
import type { Session } from './session.js';
import type { IAgent } from '../types/index.js';

/**
 * The system prompt a Session handed its Agent.
 *
 * Read through a cast because both hops are private, and deliberately from the
 * REAL objects rather than a mocked Agent constructor: the neighbouring suite
 * that mocks it (`session-disabled-tools-invariant.test.ts`) has to stub the
 * whole dependency tree to do so, and the thing under test here is the wiring,
 * which a stub would make unobservable — the same reason this file is unmocked.
 */
function promptOf(session: Session): string {
  const agent = (session as unknown as { agent: { systemPrompt?: string } | null }).agent;
  if (typeof agent?.systemPrompt !== 'string') {
    throw new Error('no system prompt on the session agent — the probe broke, this is not a pass');
  }
  return agent.systemPrompt;
}

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

  it('a DISCONNECT leaves the four registered and makes them refuse again', async () => {
    // The other half of the test above, and the one the register row named as
    // uncovered. That one boots WITH a pair so `reloadGoogle()` gets past its
    // early return — which means it only ever exercises the credential branch.
    // The `if (!pair)` branch, i.e. a disconnect, was asserted nowhere: that the
    // tools survive it was the design (PRD Stage 1 §3.3 — "clearing the
    // credential is the whole of disconnect; the registry is not touched") and
    // nothing held the design in place.
    //
    // MUTATION THIS KILLS: remove `this._googleAuth = null` from the `!pair`
    // branch of `reloadGoogle()`. The tools resolve the auth per call, so a
    // disconnect that leaves the instance behind keeps them answering as if
    // still connected — the refusal assertion below is what fails.
    //
    // ⚠ The `version` assertion is NOT the killing one and is not claimed to be:
    // `ToolRegistry` has no `unregister`, so "unregisters on disconnect" is not
    // constructible today. It is here to state the invariant, so that adding a
    // removal API later has something to break.
    const dir = mkdtempSync(join(tmpdir(), 'lynox-gvis-disconnect-'));
    dirs.push(dir);
    for (const k of ENV_KEYS) setEnv(k, undefined);
    setEnv('LYNOX_DATA_DIR', dir);
    setEnv('GOOGLE_CLIENT_ID', 'connected-id');
    setEnv('GOOGLE_CLIENT_SECRET', 'connected-secret');
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();
    expect(engine.getGoogleAuth(), 'the fixture must start CONNECTED, or there is nothing to disconnect').not.toBeNull();

    const before = engine.getRegistry().version;
    setEnv('GOOGLE_CLIENT_ID', undefined);
    setEnv('GOOGLE_CLIENT_SECRET', undefined);
    reloadConfig();
    const ok = await engine.reloadGoogle();
    expect(ok, 'the fixture must reach the DISCONNECT branch this time').toBe(false);

    const names = engine.getRegistry().getEntries().map(e => e.definition.name);
    for (const t of GOOGLE_TOOLS) {
      expect(names, `${t} must survive a disconnect`).toContain(t);
    }
    expect(engine.getRegistry().version - before, 'a disconnect must not touch the registry').toBe(0);

    const entries = engine.getRegistry().getEntries();
    for (const t of GOOGLE_TOOLS) {
      const entry = entries.find(e => e.definition.name === t);
      const handler = (entry as unknown as { handler: (i: unknown, a: IAgent) => Promise<string> }).handler;
      await expect(handler({ action: 'list' }, {} as IAgent), `${t} must refuse again after a disconnect`)
        .resolves.toBe(GOOGLE_NOT_CONNECTED);
    }
  });

  it('the prompt suffix keys on the GRANT, not on the registration', async () => {
    // The third key of the fork decision (PRD Stage 1 §3.2/§3.3): registration
    // hangs on nothing, construction on the first claim, and the SUFFIX on the
    // grant. The first two are pinned above; this one was not. Measured before
    // writing it: `GOOGLE_PROMPT_SUFFIX` has five occurrences repo-wide, and the
    // only two in tests are `cost-regression.test.ts`, which uses it as a
    // token-budget literal and never asserts the condition — so deleting the
    // `isAuthenticated()` guard at `session.ts` left the suite green.
    //
    // MUTATION THIS KILLS: drop the guard, i.e. append the suffix
    // unconditionally. The suffix tells the model four tools are usable and the
    // model believes it; on an unconnected tenant that is a false capability
    // claim, not a cosmetic one.
    //
    // Both directions, because either one alone is satisfied by a swap: "never
    // append" passes the negative case, "always append" passes the positive.
    const dir = mkdtempSync(join(tmpdir(), 'lynox-gvis-suffix-'));
    dirs.push(dir);
    for (const k of ENV_KEYS) setEnv(k, undefined);
    setEnv('LYNOX_DATA_DIR', dir);
    setEnv('GOOGLE_CLIENT_ID', 'suffix-id');
    setEnv('GOOGLE_CLIENT_SECRET', 'suffix-secret');
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();

    // A credential RESOLVES here, and there is still no grant. That is the case
    // the row cares about: keying the suffix on the credential instead of the
    // grant would look correct on a self-host box and be wrong on every tenant
    // that has entered a client pair but not yet consented.
    const google = engine.getGoogleAuth();
    expect(google, 'a pair must resolve, or this tests the wrong branch').not.toBeNull();
    expect(google!.isAuthenticated(), 'resolved is not connected').toBe(false);
    const before = engine.createSession();
    expect(promptOf(before), 'no grant ⇒ no suffix').not.toContain(GOOGLE_PROMPT_SUFFIX);

    // Now a grant, through the public entry point rather than a seeded vault
    // blob — `setTokens` is what the managed claim calls.
    await google!.setTokens({
      access_token: 'granted-access-token',
      refresh_token: 'granted-refresh-token',
      expires_at: Date.now() + 3_600_000,
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    });
    expect(google!.isAuthenticated(), 'the grant must land, or the positive case proves nothing').toBe(true);
    const after = engine.createSession();
    expect(promptOf(after), 'a grant ⇒ the suffix').toContain(GOOGLE_PROMPT_SUFFIX);
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
