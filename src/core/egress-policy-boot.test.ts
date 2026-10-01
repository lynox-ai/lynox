import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LynoxConfig } from '../types/index.js';
import type { ToolContext } from './tool-context.js';

/**
 * The egress policy is applied at boot whether or not RunHistory opened.
 *
 * RunHistory is optional at boot: when it fails to open, the engine logs it and
 * keeps running without history, threads and tasks. The egress settings do not
 * depend on it, so they must reach the ToolContext either way. This is an
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

interface EngineInternals { _toolContext: ToolContext; runHistory: unknown }

describe('Engine boot — the egress policy does not depend on run history', () => {
  const dirs: string[] = [];
  const engines: InstanceType<typeof Engine>[] = [];
  const ENV_KEYS = ['LYNOX_DATA_DIR', 'LYNOX_NETWORK_POLICY', 'LYNOX_NETWORK_ALLOWED_HOSTS'] as const;
  const saved = new Map<string, string | undefined>();

  function setEnv(key: string, value: string | undefined): void {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }

  afterEach(async () => {
    runHistoryOpen.fail = false;
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
    setEnv('LYNOX_NETWORK_POLICY', 'deny-all');
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

  it('applies the configured policy when run history opened', async () => {
    const engine = await boot(true);
    expect(engine.runHistory).not.toBeNull();
    expect(engine._toolContext.networkPolicy).toBe('deny-all');
  });

  it('applies the configured policy when run history is unavailable', async () => {
    const engine = await boot(false);
    // The case under test is real: the engine booted without its history.
    expect(engine.runHistory).toBeNull();
    expect(engine._toolContext.networkPolicy).toBe('deny-all');
  });
});
