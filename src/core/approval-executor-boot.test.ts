import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import { APPROVAL_TTL_MS, type ApprovalFiling } from './approval-store.js';
import type { TickResult } from './approval-executor.js';
import type { LynoxConfig } from '../types/config.js';

/**
 * The approval queue's loops on a real Engine (PRD unattended-approval-queue §4.8, §4.11): the
 * sweep runs at boot whether the queue is on or not, and the executor is wired to the engine's
 * own mail, trail and threads and sends only while the queue is on.
 */
describe('the engine runs the approval queue\'s sweep and executor', () => {
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

  async function boot(dir: string, queueOn: boolean): Promise<Engine> {
    for (const k of ENV_KEYS) setEnv(k, undefined);
    setEnv('LYNOX_DATA_DIR', dir);
    setEnv('LYNOX_FEATURE_APPROVAL_QUEUE', queueOn ? '1' : undefined);
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();
    return engine;
  }
  const newDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-approval-exec-boot-'));
    dirs.push(dir);
    return dir;
  };
  const filing: ApprovalFiling = {
    kind: 'mail_send',
    payload: {
      accountId: 'acc-1', fromAddress: 'me@example.com', to: [{ address: 'bob@example.com' }], cc: [], bcc: [],
      subject: 'Wochenbericht', bodyText: 'Hier der Bericht.', trackFollowup: null,
    },
  };
  const origin = { source: 'task' as const, triggerId: 'trg-1', runId: 'run-1', rootRunId: 'run-1' };
  const tick = (engine: Engine): Promise<TickResult> => (engine as unknown as { _approvalTick(): Promise<TickResult> })._approvalTick();

  it('sweeps at boot with the queue off: an entry past its expiry is expired by the next start', async () => {
    const dir = newDir();
    const first = await boot(dir, false);
    const filed = first.getApprovalStore()!.file({ filing, origin, createdBy: 'owner', mandateId: null, now: Date.now() - APPROVAL_TTL_MS - 60_000 });
    if (!filed.ok) throw new Error(filed.reason);
    expect(first.getApprovalStore()!.get(filed.id)!.status).toBe('pending');
    await first.shutdown();
    engines.length = 0;

    const second = await boot(dir, false);
    expect(second.getApprovalStore()!.get(filed.id)!.status).toBe('expired');
    expect(JSON.parse(second.getApprovalStore()!.get(filed.id)!.resultJson!)).toEqual({ reason: 'ttl' });
  });

  it('with the queue on, a tick takes an approved entry to the engine\'s executor', async () => {
    const engine = await boot(newDir(), true);
    const store = engine.getApprovalStore()!;
    const filed = store.file({ filing, origin, createdBy: 'owner', mandateId: null });
    if (!filed.ok) throw new Error(filed.reason);
    expect(store.decide(filed.id, { action: 'approve', checksum: store.get(filed.id)!.checksum }, 'owner').ok).toBe(true);
    expect(engine.getApprovalExecutor()).toBe(engine.getApprovalExecutor());
    // This engine has no mail account: the executor read the engine's own mail context, found
    // no account under the filed id, and sent nothing.
    expect(await tick(engine)).toEqual({ id: filed.id, status: 'failed' });
    expect(JSON.parse(store.get(filed.id)!.resultJson!)).toEqual({ reason: 'account_not_configured' });
  });

  it('with the queue off, a tick does nothing', async () => {
    const dir = newDir();
    const engine = await boot(dir, true);
    const store = engine.getApprovalStore()!;
    const filed = store.file({ filing, origin, createdBy: 'owner', mandateId: null });
    if (!filed.ok) throw new Error(filed.reason);
    expect(store.decide(filed.id, { action: 'approve', checksum: store.get(filed.id)!.checksum }, 'owner').ok).toBe(true);
    setEnv('LYNOX_FEATURE_APPROVAL_QUEUE', undefined);
    expect(await tick(engine)).toBeNull();
    expect(store.get(filed.id)!.attempts).toBe(0);
  });
});
