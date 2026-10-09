import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import type { LynoxConfig } from '../types/index.js';

/**
 * The actor trail is wired at engine boot: the tool context every agent and the HTTP routes
 * read carries a log over the engine's own engine.db. A unit test that hands the log in
 * itself cannot see this, so it is measured on a booted engine (shape of
 * mandate-tool-lock.test.ts).
 */
describe('Engine boot — the actor trail is wired', () => {
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

  it('gives the tool context a log that writes into the engine\'s engine.db', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-audit-boot-'));
    dirs.push(dir);
    for (const k of ['LYNOX_VAULT_KEY', 'LYNOX_MANAGED_INSTANCE_ID']) setEnv(k, undefined);
    setEnv('LYNOX_DATA_DIR', dir);
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();
    const log = engine.getAuditLog();
    expect(log).not.toBeNull();
    log!.record({ principal: { kind: 'mandate', email: 'recipient@example.invalid' }, action: 'boot check', phase: 'attempt', correlationId: 'c-boot' });
    const rows = engine.getEngineDb()!.getDb().prepare('SELECT correlation_id FROM audit_log').all() as Array<{ correlation_id: string }>;
    expect(rows.map(r => r.correlation_id)).toEqual(['c-boot']);
  });

  it('finds every tool of the booted registry that writes outside classified', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-audit-boot-'));
    dirs.push(dir);
    for (const k of ['LYNOX_VAULT_KEY', 'LYNOX_MANAGED_INSTANCE_ID']) setEnv(k, undefined);
    setEnv('LYNOX_DATA_DIR', dir);
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();
    const entries = engine.getRegistry().getEntries();
    expect(entries.length).toBeGreaterThan(20);
    const unclassified = entries
      .filter(e => e.destructive?.mode === 'external' && typeof e.outwardWrite !== 'function')
      .map(e => e.definition.name);
    expect(unclassified, 'declare outwardWrite on each tool that changes data outside').toEqual([]);
    // The filter is not empty by accident: the http writer is in the registry and declares it.
    expect(entries.find(e => e.definition.name === 'http_request')?.outwardWrite).toBeTypeOf('function');
  });
});
