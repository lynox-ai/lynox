import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import { MANDATE_TOOL_SURFACE, MANDATE_WITHHELD_TOOLS, toolLockFor } from './mandate-tool-lock.js';
import { OWNER_PRINCIPAL } from './request-principal.js';
import type { LynoxConfig } from '../types/index.js';

describe('toolLockFor', () => {
  it('locks a mandate to the surface and leaves the owner unlocked', () => {
    expect(toolLockFor({ kind: 'mandate', email: 'setup@example.org' })).toBe(MANDATE_TOOL_SURFACE);
    expect(toolLockFor(OWNER_PRINCIPAL)).toBeNull();
  });

  it('withholds what D1 names: the shell and every tool that reads or writes the process filesystem', () => {
    for (const name of ['bash', 'read_file', 'write_file', 'edit_file', 'batch_files']) {
      expect(MANDATE_TOOL_SURFACE.has(name), name).toBe(false);
      expect(MANDATE_WITHHELD_TOOLS[name], name).toBeDefined();
    }
  });

  it('places no tool on both lists', () => {
    for (const name of Object.keys(MANDATE_WITHHELD_TOOLS)) expect(MANDATE_TOOL_SURFACE.has(name), name).toBe(false);
  });
});

/**
 * Measured against the REAL registry of a booted engine (the shape of
 * read-only-role-surface-boot.test.ts): every tool the engine registers is either on the
 * surface or withheld with a reason. A tool the engine starts registering tomorrow fails
 * here until someone places it — the allowlist keeps it from mandates meanwhile, and this
 * makes that a decision rather than an accident.
 */
describe('Engine boot — every registered tool is classified for mandates', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
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
    reloadConfig();
  });

  it('classifies the whole registry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-mandate-lock-'));
    dirs.push(dir);
    for (const k of ['LYNOX_VAULT_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_SERVICE_ACCOUNT_KEY', 'LYNOX_MANAGED_INSTANCE_ID']) setEnv(k, undefined);
    setEnv('LYNOX_DATA_DIR', dir);
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();
    const names = engine.getRegistry().getEntries().map(e => e.definition.name);
    // A real registry: the check is only worth its line if the set is large.
    expect(names.length).toBeGreaterThan(20);
    const unplaced = names.filter(n => !MANDATE_TOOL_SURFACE.has(n) && MANDATE_WITHHELD_TOOLS[n] === undefined);
    expect(unplaced, 'place each new tool on MANDATE_TOOL_SURFACE or MANDATE_WITHHELD_TOOLS').toEqual([]);
    // And the withheld ones are really there to withhold, so the list is not stale.
    for (const name of ['bash', 'read_file', 'write_file', 'edit_file', 'batch_files']) expect(names, name).toContain(name);
  });
});
