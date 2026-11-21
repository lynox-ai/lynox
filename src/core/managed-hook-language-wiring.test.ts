import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import type { LynoxConfig } from '../types/index.js';

/**
 * The managed hook words its refusals in the instance's language, but only if the engine hands
 * it that language: `managed-hook.test.ts` proves the hook reads a getter, and cannot see whether
 * `init()` passes one. This boots a real engine with the billing tier set and reads what it
 * handed to the hook's factory.
 */
const captured = vi.hoisted(() => ({ opts: [] as Array<{ language?: (() => string) | undefined }> }));
vi.mock('./managed-hook.js', () => ({
  createManagedHook: (opts: { language?: (() => string) | undefined } = {}) => {
    captured.opts.push(opts);
    return {};
  },
}));

describe('Engine boot — the managed hook gets the instance\'s language', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  const ENV_KEYS = ['LYNOX_DATA_DIR', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE', 'LYNOX_MANAGED_INSTANCE_ID',
    'LYNOX_LANGUAGE', 'ANTHROPIC_API_KEY', 'LYNOX_EMBEDDING_PROVIDER'] as const;
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
    captured.opts.length = 0;
    reloadConfig();
  });

  async function boot(language: string): Promise<Engine> {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-hook-lang-'));
    dirs.push(dir);
    for (const k of ENV_KEYS) setEnv(k, undefined);
    setEnv('LYNOX_DATA_DIR', dir);
    setEnv('LYNOX_BILLING_TIER', 'managed');
    setEnv('ANTHROPIC_API_KEY', 'test-key-not-real');
    setEnv('LYNOX_EMBEDDING_PROVIDER', 'local');
    reloadConfig();
    const engine = new Engine({ language } as LynoxConfig);
    engines.push(engine);
    await engine.init();
    return engine;
  }

  for (const language of ['de', 'en'] as const) {
    it(`${language}: the hook reads the configured language`, async () => {
      await boot(language);
      expect(captured.opts).toHaveLength(1);
      expect(captured.opts[0]!.language?.()).toBe(language);
    });
  }
});
