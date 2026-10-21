import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import { filingContextFor } from './approval-filing.js';
import type { LynoxConfig } from '../types/config.js';

/**
 * What a trigger's run files with reaches its agent through a real Engine and Session, and stays
 * there across a rebuild of the agent (PRD unattended-approval-queue §4.2: set after
 * `_recreateAgent`, or a rebuilt agent loses it). The worker's own tests use a session double, so
 * the session's half of the wiring is pinned here.
 */
describe('a session hands its filing context to its agent, across rebuilds', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  const ENV_KEYS = ['LYNOX_DATA_DIR', 'LYNOX_VAULT_KEY', 'LYNOX_FEATURE_APPROVAL_QUEUE', 'LYNOX_MANAGED_INSTANCE_ID'] as const;
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

  async function boot(): Promise<Engine> {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-approval-boot-'));
    dirs.push(dir);
    for (const k of ENV_KEYS) setEnv(k, undefined);
    setEnv('LYNOX_DATA_DIR', dir);
    setEnv('LYNOX_FEATURE_APPROVAL_QUEUE', '1');
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();
    return engine;
  }

  it('the engine has one store over engine.db, and the session\'s agent gets the context and keeps it', async () => {
    const engine = await boot();
    const store = engine.getApprovalStore();
    expect(store, 'a booted engine has engine.db').not.toBeNull();
    expect(engine.getApprovalStore()).toBe(store);

    const session = engine.createSession({ autonomy: 'autonomous' });
    session._recreateAgent({ autonomy: 'autonomous' });
    const filing = filingContextFor(() => engine.getApprovalStore(), { source: 'task', triggerId: 'trg-1' });
    expect(filing).toBeDefined();
    session.approvalFiling = filing!;
    expect(session.getAgent()!.approvalFiling).toBe(filing);

    // A rebuild of the agent keeps it.
    session.setEffort('high');
    expect(session.getAgent()!.approvalFiling).toBe(filing);
    session._recreateAgent({ autonomy: 'autonomous' });
    expect(session.getAgent()!.approvalFiling).toBe(filing);
  });

  it('a session nobody gave one has none', async () => {
    const engine = await boot();
    const session = engine.createSession();
    expect(session.getAgent()!.approvalFiling).toBeUndefined();
  });
});
