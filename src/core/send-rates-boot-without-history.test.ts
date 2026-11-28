import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LynoxConfig } from '../types/index.js';
import type { ToolContext } from './tool-context.js';

/**
 * An engine that boots without its run history refuses the send paths whose rate it
 * cannot count, instead of sending uncounted.
 *
 * The HTTP and mail send-rate limits count tool calls in the run history. When it fails
 * to open, the engine keeps running without history; before this, the limits were then
 * never set up, and nothing counted the sends. The wiring is an init-ORDER property, so
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
const { checkMailRateLimit, MAIL_RATE_UNCOUNTED, resetMailRateLimits } = await import('../integrations/mail/tools/rate-limit.js');

describe('Engine boot — the send-rate limits without run history', () => {
  const dirs: string[] = [];
  const engines: InstanceType<typeof Engine>[] = [];
  const ENV_KEYS = ['LYNOX_DATA_DIR', 'LYNOX_MAX_HTTP_REQUESTS_PER_HOUR', 'LYNOX_MANAGED_INSTANCE_ID'] as const;
  const saved = new Map<string, string | undefined>();

  function setEnv(key: string, value: string | undefined): void {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }

  afterEach(async () => {
    runHistoryOpen.fail = false;
    resetMailRateLimits();
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
    const dir = mkdtempSync(join(tmpdir(), 'lynox-rateboot-'));
    dirs.push(dir);
    for (const k of ENV_KEYS) setEnv(k, undefined);
    setEnv('LYNOX_DATA_DIR', dir);
    // An HTTP limit, as the control plane sets one per tier.
    setEnv('LYNOX_MAX_HTTP_REQUESTS_PER_HOUR', '20');
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

  const toolContextOf = (engine: InstanceType<typeof Engine>): ToolContext =>
    (engine as unknown as { _toolContext: ToolContext })._toolContext;

  it('with run history the limits count against it, and the boot says nothing about them (the control)', async () => {
    const engine = await boot(true);
    const ctx = toolContextOf(engine);
    expect(ctx.rateLimitProvider).not.toBeNull();
    expect(ctx.hourlyRateLimit).toBe(20);
    expect(checkMailRateLimit('mail_send')).toBeNull();
    expect(bootLog).not.toContain('send limits cannot be counted');
  });

  it('without run history the HTTP limit is set with nothing to count it, and mail is refused', async () => {
    const engine = await boot(false);
    expect((engine as unknown as { runHistory: unknown }).runHistory).toBeNull();
    const ctx = toolContextOf(engine);
    expect(ctx.rateLimitProvider).toBeNull();
    expect(ctx.hourlyRateLimit).toBe(20);
    expect(checkMailRateLimit('mail_send')).toBe(MAIL_RATE_UNCOUNTED);
  });

  it('says so in the startup log, next to the line that says why the history did not open', async () => {
    await boot(false);
    expect(bootLog).toContain('RunHistory init failed');
    expect(bootLog).toContain('[lynox] The history database did not open, so send limits cannot be counted: no mail goes out, approved mails included, and no request through the http_request tool while an HTTP limit is set. This lasts until lynox restarts and can open the history database; approved mails go out then unless they expired, 72 hours after they were submitted.');
  });
});
