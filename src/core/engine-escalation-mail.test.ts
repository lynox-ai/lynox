import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine, type LynoxHooks } from './engine.js';
import { reloadConfig } from './config.js';
import type { DeliverySummary, NotificationChannel } from './notification-router.js';
import type { LynoxConfig, LynoxUserConfig } from '../types/index.js';

/**
 * An escalation that reached nobody is handed to the engine's hooks, so the managed hook can ask
 * the control plane to mail the owner.
 *
 * Two halves. The BOOT half proves the wiring end to end on a real `init()`: with the control
 * plane's `LYNOX_BILLING_TIER` set, an undelivered escalation leaves as one POST to
 * `/escalation`; without it (self-host), nothing leaves. A unit test that handed the hook in
 * itself would stay green with the registration line deleted. The WRAPPER half pins the
 * isolation and the owner's switch on `Engine.escalateToUser`.
 */

/** A channel that never reaches anyone: the escalation summarizes as `not_delivered`. */
const deadChannel: NotificationChannel = { name: 'dead', send: async () => 'failed' };

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('Engine boot — an undelivered escalation reaches the control plane', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  const ENV_KEYS = [
    'LYNOX_DATA_DIR', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE', 'LYNOX_MANAGED_INSTANCE_ID',
    'LYNOX_MANAGED_CONTROL_PLANE_URL', 'LYNOX_HTTP_SECRET', 'LYNOX_VAULT_KEY',
  ] as const;
  const saved = new Map<string, string | undefined>();

  function setEnv(key: string, value: string | undefined): void {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  afterEach(async () => {
    for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
    engines.length = 0;
    vi.unstubAllGlobals();
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    saved.clear();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    reloadConfig();
  });

  async function boot(managed: boolean): Promise<{ engine: Engine; fetchSpy: ReturnType<typeof vi.fn> }> {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-escalation-mail-'));
    dirs.push(dir);
    for (const k of ENV_KEYS) setEnv(k, undefined);
    setEnv('LYNOX_DATA_DIR', dir);
    if (managed) {
      setEnv('LYNOX_BILLING_TIER', 'hosted');
      setEnv('LYNOX_MANAGED_INSTANCE_ID', 'inst-boot');
      setEnv('LYNOX_MANAGED_CONTROL_PLANE_URL', 'https://cp.test');
      setEnv('LYNOX_HTTP_SECRET', 'boot-secret');
    }
    const fetchSpy = vi.fn().mockImplementation(() =>
      Promise.resolve({ ok: true, json: async () => ({ allowed: true, spend_gate: 'unfunded' }) }));
    vi.stubGlobal('fetch', fetchSpy);
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();
    engine.getNotificationRouter().register(deadChannel);
    return { engine, fetchSpy };
  }

  const escalationPosts = (spy: ReturnType<typeof vi.fn>) =>
    spy.mock.calls.filter(([url]) => String(url).endsWith('/escalation'));

  it('posts the class to the control plane on an instance the control plane runs', async () => {
    const { engine, fetchSpy } = await boot(true);
    engine.escalateToUser({ key: 'sched-1', title: 'Weekly report', body: 'It failed' });
    await flush(); await flush();
    const posts = escalationPosts(fetchSpy);
    expect(posts).toHaveLength(1);
    expect(String(posts[0]![0])).toBe('https://cp.test/internal/usage/inst-boot/escalation');
    expect(JSON.parse(String((posts[0]![1] as RequestInit).body))).toEqual({ kind: 'escalation' });
  });

  it('posts nothing on an instance the control plane runs once the owner switched the mail off', async () => {
    const { engine, fetchSpy } = await boot(true);
    (engine as unknown as { userConfig: LynoxUserConfig }).userConfig = { ...engine.getUserConfig(), escalation_mail: false };
    engine.escalateToUser({ key: 'sched-1', title: 'Weekly report', body: 'It failed' });
    await flush(); await flush();
    expect(escalationPosts(fetchSpy)).toHaveLength(0);
  });

  it('posts nothing on self-host, where no control plane installed the hook', async () => {
    const { engine, fetchSpy } = await boot(false);
    engine.escalateToUser({ key: 'sched-1', title: 'Weekly report', body: 'It failed' });
    await flush(); await flush();
    expect(escalationPosts(fetchSpy)).toHaveLength(0);
  });
});

describe('Engine.escalateToUser — the hooks hear of the delivery', () => {
  const engines: Engine[] = [];
  afterEach(() => { engines.length = 0; });

  /** An engine that is not booted: no thread store, so the escalation is a bare push. */
  function engineWith(config: Partial<LynoxUserConfig> = {}): { engine: Engine; heard: DeliverySummary[] } {
    const engine = new Engine({ model: 'fast' } as unknown as LynoxConfig);
    engines.push(engine);
    (engine as unknown as { userConfig: LynoxUserConfig }).userConfig = { ...engine.getUserConfig(), ...config };
    engine.getNotificationRouter().register(deadChannel);
    const heard: DeliverySummary[] = [];
    const hook: LynoxHooks = { onEscalationReported: (d) => { heard.push(d); } };
    engine.registerHooks(hook);
    return { engine, heard };
  }

  it('hands the delivery to the hook after the caller has its record', async () => {
    const { engine, heard } = engineWith();
    const order: string[] = [];
    engine.registerHooks({ onEscalationReported: () => { order.push('hook'); } });
    engine.escalateToUser({ key: 'k', title: 't', body: 'b', onReported: () => { order.push('caller'); } });
    await flush();
    expect(heard).toEqual(['not_delivered']);
    expect(order).toEqual(['caller', 'hook']);
  });

  it('still tells the hook when the caller\'s record throws', async () => {
    const { engine, heard } = engineWith();
    engine.escalateToUser({ key: 'k', title: 't', body: 'b', onReported: () => { throw new Error('record failed'); } });
    await flush();
    expect(heard).toEqual(['not_delivered']);
  });

  it('still tells the next hook, and records for the caller, when a hook throws', async () => {
    const engine = new Engine({ model: 'fast' } as unknown as LynoxConfig);
    engine.getNotificationRouter().register(deadChannel);
    const heard: DeliverySummary[] = [];
    engine.registerHooks({ onEscalationReported: () => { throw new Error('hook failed'); } });
    engine.registerHooks({ onEscalationReported: (d) => { heard.push(d); } });
    const recorded: DeliverySummary[] = [];
    engine.escalateToUser({ key: 'k', title: 't', body: 'b', onReported: (d) => { recorded.push(d); } });
    await flush();
    expect(heard).toEqual(['not_delivered']);
    expect(recorded).toEqual(['not_delivered']);
  });

  it('reads the switch when the delivery answers, not when the escalation starts', async () => {
    const { engine, heard } = engineWith({ escalation_mail: false });
    engine.escalateToUser({ key: 'k', title: 't', body: 'b' });
    // Switched on while the push is still out: the delivery that answers afterwards counts.
    (engine as unknown as { userConfig: LynoxUserConfig }).userConfig = { ...engine.getUserConfig(), escalation_mail: true };
    await flush();
    expect(heard).toEqual(['not_delivered']);
  });

  it('tells the hooks nothing while the owner has switched the mail off, and again once on', async () => {
    const { engine, heard } = engineWith({ escalation_mail: false });
    const recorded: DeliverySummary[] = [];
    engine.escalateToUser({ key: 'k', title: 't', body: 'b', onReported: (d) => { recorded.push(d); } });
    await flush();
    expect(heard).toEqual([]);
    expect(recorded).toEqual(['not_delivered']); // the switch is the mail's, never the record's

    // Read when the delivery answers, so a switch flipped at runtime takes effect at once.
    (engine as unknown as { userConfig: LynoxUserConfig }).userConfig = { ...engine.getUserConfig(), escalation_mail: true };
    engine.escalateToUser({ key: 'k', title: 't', body: 'b' });
    await flush();
    expect(heard).toEqual(['not_delivered']);
  });
});
