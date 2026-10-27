import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import type { LynoxConfig, IAgent } from '../types/index.js';
import type { Session } from './session.js';

/**
 * Bulk runs follow the switch LIVE, without a restart: a real
 * Engine against a tmp data dir, the config file rewritten and `reloadUserConfig` called, as
 * PUT /api/config does. What is asserted is what the MODEL sees — the tool list of an open
 * session after its rebuild — and the ledger the bulk routes and the worker read, not a flag.
 */

const BULK_TOOLS = ['bulk_plan', 'bulk_status'] as const;

type AgentLike = IAgent & { getAvailableTools(): Array<{ definition: { name: string } }> };

function toolNames(session: Session): string[] {
  const agent = (session as unknown as { agent: AgentLike | null }).agent;
  if (!agent || typeof agent.getAvailableTools !== 'function') {
    throw new Error('no agent on the session — the probe broke, this is not a pass');
  }
  return agent.getAvailableTools().map((t) => t.definition.name);
}

/** What `Session.run` checks before each turn to rebuild its agent (session.ts, the registry
 *  hot-reload): the registry's version against the one the agent was built from. */
function sessionIsStale(engine: Engine, session: Session): boolean {
  return engine.getRegistry().version !== (session as unknown as { _registryVersion: number })._registryVersion;
}

function rebuild(session: Session): void {
  (session as unknown as { _recreateAgent(): void })._recreateAgent();
}

describe('Engine — bulk runs switched live', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  const ENV_KEYS = ['LYNOX_DATA_DIR', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE', 'LYNOX_FEATURE_BULK_RUNS',
    'LYNOX_MANAGED_CONTROL_PLANE_URL', 'LYNOX_MANAGED_INSTANCE_ID', 'LYNOX_HTTP_SECRET'] as const;
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

  function dataDir(config: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-bulkswitch-'));
    dirs.push(dir);
    for (const k of ENV_KEYS) setEnv(k, undefined);
    setEnv('LYNOX_DATA_DIR', dir);
    writeConfig(dir, config);
    return dir;
  }

  function writeConfig(dir: string, config: Record<string, unknown>): void {
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
    reloadConfig();
  }

  /** A managed pool tier: the managed hook refuses to boot without its three settings. The
   *  control plane URL points at a closed local port; nothing here needs it to answer. */
  function managedTier(): void {
    setEnv('LYNOX_BILLING_TIER', 'managed');
    setEnv('LYNOX_MANAGED_CONTROL_PLANE_URL', 'http://127.0.0.1:9');
    setEnv('LYNOX_MANAGED_INSTANCE_ID', 'inst-test');
    setEnv('LYNOX_HTTP_SECRET', 'x'.repeat(32));
  }

  async function boot(): Promise<Engine> {
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try { await engine.init(); } finally { stderr.mockRestore(); }
    return engine;
  }

  it('turning bulk runs off removes the tools from an open session and the ledger, and turning them on brings both back', async () => {
    const dir = dataDir({ bulk_runs_enabled: true });
    const engine = await boot();
    const session = engine.createSession();
    expect(toolNames(session)).toEqual(expect.arrayContaining([...BULK_TOOLS]));
    const ledger = engine.getBulkLedger();
    expect(ledger).not.toBeNull();
    expect(engine.getBulkLedgerSwitchedOff(), 'nothing switched off while on').toBeNull();

    writeConfig(dir, { bulk_runs_enabled: false });
    await engine.reloadUserConfig();
    expect(engine.getBulkLedger(), 'the routes and the tools find no ledger').toBeNull();
    // …but the worker does, to end a waiting run as a stop instead of skipping it.
    expect(engine.getBulkLedgerSwitchedOff()).toBe(ledger);
    expect(sessionIsStale(engine, session), 'the open session rebuilds before its next turn').toBe(true);
    rebuild(session);
    for (const name of BULK_TOOLS) expect(toolNames(session)).not.toContain(name);

    writeConfig(dir, { bulk_runs_enabled: true });
    await engine.reloadUserConfig();
    expect(engine.getBulkLedger()).not.toBeNull();
    expect(sessionIsStale(engine, session)).toBe(true);
    rebuild(session);
    expect(toolNames(session)).toEqual(expect.arrayContaining([...BULK_TOOLS]));
  });

  it('a credentials reload installs the fresh config, and the switch follows it there too', async () => {
    const dir = dataDir({ bulk_runs_enabled: true });
    const engine = await boot();
    expect(engine.getBulkLedger()).not.toBeNull();
    writeConfig(dir, { bulk_runs_enabled: false });
    await engine.reloadCredentials();
    expect(engine.getBulkLedger()).toBeNull();
  });

  it('turning them off stops the bulk tasks under way, as their owner would', async () => {
    const dir = dataDir({ bulk_runs_enabled: true });
    const engine = await boot();
    engine.startWorkerLoop();
    const loop = engine.getWorkerLoop();
    expect(loop).not.toBeNull();
    const stop = vi.spyOn(loop!, 'stopBulkTasks');

    // A reload that changes nothing for bulk runs stops nothing.
    writeConfig(dir, { bulk_runs_enabled: true, display_name: 'x' });
    await engine.reloadUserConfig();
    expect(stop).not.toHaveBeenCalled();

    writeConfig(dir, { bulk_runs_enabled: false });
    await engine.reloadUserConfig();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('on a managed pool tier the control plane\'s flag opens them, and the owner can only turn them off', async () => {
    const dir = dataDir({});
    managedTier();
    setEnv('LYNOX_FEATURE_BULK_RUNS', '1');
    const engine = await boot();
    expect(engine.getBulkLedger(), 'open with the field left out').not.toBeNull();

    writeConfig(dir, { bulk_runs_enabled: false });
    await engine.reloadUserConfig();
    expect(engine.getBulkLedger(), 'the owner turned them off').toBeNull();

    writeConfig(dir, { bulk_runs_enabled: true });
    await engine.reloadUserConfig();
    expect(engine.getBulkLedger(), 'and back on').not.toBeNull();
  });

  it('on a managed pool tier without the flag the owner\'s true opens nothing', async () => {
    dataDir({ bulk_runs_enabled: true });
    managedTier();
    const engine = await boot();
    expect(engine.getBulkLedger()).toBeNull();
    const session = engine.createSession();
    for (const name of BULK_TOOLS) expect(toolNames(session)).not.toContain(name);
  });
});
