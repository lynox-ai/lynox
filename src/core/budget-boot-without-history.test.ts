import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LynoxConfig } from '../types/index.js';

/**
 * An engine that boots without its run history refuses runs while a daily or monthly
 * cap is set, instead of running them unchecked.
 *
 * The caps count recorded spend from the run history. When it fails to open, the engine
 * keeps running without history; before this, the caps then read as "nothing spent"
 * and every run passed. Managed hosting sets the caps per tier through the env, so
 * this was a paying tenant's spending limit. The wiring is an init-ORDER property, so
 * this boots a real Engine, as egress-policy-boot.test.ts does.
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
const { checkPersistentBudget, resetPersistentBudget } = await import('./session-budget.js');

describe('Engine boot — the spending caps without run history', () => {
  const dirs: string[] = [];
  const engines: InstanceType<typeof Engine>[] = [];
  const ENV_KEYS = ['LYNOX_DATA_DIR', 'LYNOX_MAX_DAILY_COST_USD', 'LYNOX_MAX_MONTHLY_COST_USD', 'LYNOX_MANAGED_INSTANCE_ID'] as const;
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

  let bootLog = '';
  async function boot(historyOpens: boolean): Promise<InstanceType<typeof Engine>> {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-budgetboot-'));
    dirs.push(dir);
    for (const k of ENV_KEYS) setEnv(k, undefined);
    setEnv('LYNOX_DATA_DIR', dir);
    setEnv('LYNOX_MANAGED_INSTANCE_ID', undefined);
    // The managed tier's caps, as the control plane sets them.
    setEnv('LYNOX_MAX_DAILY_COST_USD', '15');
    setEnv('LYNOX_MAX_MONTHLY_COST_USD', '150');
    reloadConfig();
    runHistoryOpen.fail = !historyOpens;
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await engine.init();
    } finally {
      bootLog = stderr.mock.calls.map((c) => String(c[0])).join('');
      stderr.mockRestore();
    }
    return engine;
  }

  it('the budget check allows when run history opened, and the boot says nothing about the caps (the control)', async () => {
    const engine = await boot(true);
    expect((engine as unknown as { runHistory: unknown }).runHistory).not.toBeNull();
    expect(checkPersistentBudget().allowed).toBe(true);
    expect(bootLog).not.toContain('cannot be checked');
  });

  it('refuses every run when run history did not open, naming the caps', async () => {
    const engine = await boot(false);
    // The case under test is real: the engine booted without its history.
    expect((engine as unknown as { runHistory: unknown }).runHistory).toBeNull();
    const check = checkPersistentBudget();
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('Spending cap (daily $15, monthly $150) cannot be checked');
  });

  it('says so in the startup log, next to the line that says why the history did not open', async () => {
    await boot(false);
    expect(bootLog).toContain('RunHistory init failed');
    expect(bootLog).toContain('[lynox] Spending caps (daily $15, monthly $150) cannot be checked without the history database: the agent does not run, not even for a chat, until lynox restarts with it open.');
  });
});
