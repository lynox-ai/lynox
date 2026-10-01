import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LynoxConfig } from '../types/index.js';
import type { ToolContext } from './tool-context.js';

/**
 * The egress policy and the session cost cap are applied at boot whether or not
 * RunHistory opened.
 *
 * RunHistory is optional at boot: when it fails to open, the engine logs it and
 * keeps running without history, threads and tasks. The egress settings and the
 * session cap do not depend on it, so they must take effect either way. This is an
 * init-ORDER property — a unit test that calls the wiring function directly
 * cannot see where `Engine.init` calls it from — so it boots a real Engine.
 */
const runHistoryOpen = vi.hoisted(() => ({ fail: false }));

vi.mock('./run-history.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./run-history.js')>();
  class RunHistoryThatMayNotOpen extends actual.RunHistory {
    constructor(...args: ConstructorParameters<typeof actual.RunHistory>) {
      if (runHistoryOpen.fail) throw new Error('run history unavailable');
      super(...args);
    }
  }
  return { ...actual, RunHistory: RunHistoryThatMayNotOpen };
});

const { Engine } = await import('./engine.js');
const { reloadConfig } = await import('./config.js');
const { getSessionCostCeiling, resetPersistentBudget } = await import('./session-budget.js');

interface EngineInternals { _toolContext: ToolContext; runHistory: unknown }

describe('Engine boot — egress policy and session cap do not depend on run history', () => {
  const dirs: string[] = [];
  const engines: InstanceType<typeof Engine>[] = [];
  const ENV_KEYS = ['LYNOX_DATA_DIR', 'LYNOX_NETWORK_POLICY', 'LYNOX_NETWORK_ALLOWED_HOSTS', 'LYNOX_MAX_SESSION_COST_USD'] as const;
  const saved = new Map<string, string | undefined>();

  function setEnv(key: string, value: string | undefined): void {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }

  afterEach(async () => {
    runHistoryOpen.fail = false;
    resetPersistentBudget();
    for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
    engines.length = 0;
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    saved.clear();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    reloadConfig();
  });

  async function boot(historyOpens: boolean): Promise<EngineInternals> {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-egressboot-'));
    dirs.push(dir);
    for (const k of ENV_KEYS) setEnv(k, undefined);
    setEnv('LYNOX_DATA_DIR', dir);
    setEnv('LYNOX_NETWORK_POLICY', 'allow-list');
    setEnv('LYNOX_NETWORK_ALLOWED_HOSTS', 'ops.example.com');
    setEnv('LYNOX_MAX_SESSION_COST_USD', '7');
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ enforce_https: true }));
    reloadConfig();
    runHistoryOpen.fail = !historyOpens;
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await engine.init();
    } finally {
      stderr.mockRestore();
    }
    return engine as unknown as EngineInternals;
  }

  function expectConfiguredLimits(engine: EngineInternals): void {
    expect(engine._toolContext.networkPolicy).toBe('allow-list');
    expect(engine._toolContext.allowedHosts).toEqual(new Set(['ops.example.com']));
    expect(engine._toolContext.enforceHttps).toBe(true);
    expect(getSessionCostCeiling()).toBe(7);
  }

  it('applies the configured egress policy and session cap when run history opened', async () => {
    const engine = await boot(true);
    expect(engine.runHistory).not.toBeNull();
    expectConfiguredLimits(engine);
  });

  it('applies the configured egress policy and session cap when run history is unavailable', async () => {
    const engine = await boot(false);
    // The case under test is real: the engine booted without its history.
    expect(engine.runHistory).toBeNull();
    expectConfiguredLimits(engine);
  });
});
