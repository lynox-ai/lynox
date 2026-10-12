import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LynoxConfig } from '../types/index.js';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import { OWNER_PRINCIPAL } from './request-principal.js';

/**
 * The engine hands out a store for mandate ends, on its own engine.db.
 *
 * Every HTTP test stubs `getMandateEnds`, so none of them sees whether `Engine.init` builds the
 * store at all. Without it every request records nothing and every later reader takes every
 * mandate as ended: closed, but the feature is dead without a signal. So this boots a real Engine.
 */
describe('Engine boot — mandate ends', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  const saved = new Map<string, string | undefined>();

  afterEach(async () => {
    for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
    engines.length = 0;
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    saved.clear();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    reloadConfig();
  });

  it('records a mandate\'s end in the engine\'s own engine.db', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-mandateendsboot-'));
    dirs.push(dir);
    saved.set('LYNOX_DATA_DIR', process.env['LYNOX_DATA_DIR']);
    process.env['LYNOX_DATA_DIR'] = dir;
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await engine.init();
    } finally {
      stderr.mockRestore();
    }

    const ends = engine.getMandateEnds();
    expect(ends).not.toBeNull();
    ends!.record({ kind: 'mandate', email: 'helper@example.invalid', mandateId: 'M-1', mandateExp: 2_000 }, 100);
    const db = (engine as unknown as { engineDb: { getDb(): import('better-sqlite3').Database } }).engineDb.getDb();
    expect(db.prepare('SELECT ends_at FROM mandate_ends WHERE mandate_id = ?').get('M-1')).toEqual({ ends_at: 2_000 });
    // The tools read the same record: `api_setup` names the connections that wait for the owner
    // from it, and a tool context without it would call every mandate ended.
    expect(engine.getToolContext().mandateEnds).toBe(ends);
    expect(engine.getToolContext().mandateEnds?.isLive('M-1', 1_000)).toBe(true);
  });

  async function boot(dir: string): Promise<Engine> {
    if (!saved.has('LYNOX_DATA_DIR')) saved.set('LYNOX_DATA_DIR', process.env['LYNOX_DATA_DIR']);
    process.env['LYNOX_DATA_DIR'] = dir;
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try { await engine.init(); } finally { stderr.mockRestore(); }
    return engine;
  }

  it('closes a mandate\'s pending question the moment the mandate is revoked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-mandaterevokeboot-'));
    dirs.push(dir);
    const engine = await boot(dir);
    const ends = engine.getMandateEnds()!;
    const store = engine.getPromptStore()!;
    const farEnd = Math.floor(Date.now() / 1000) + 3_600;
    ends.record({ kind: 'mandate', email: 'helper@example.invalid', mandateId: 'M-1', mandateExp: farEnd }, 100);
    const id = store.insertAskUser('s-1', 'q?', undefined, undefined, undefined, undefined, undefined,
      { principal: { kind: 'mandate', email: 'helper@example.invalid', mandateId: 'M-1' } });
    const owner = store.insertAskUser('s-2', 'q?', undefined, undefined, undefined, undefined, undefined, { principal: OWNER_PRINCIPAL });
    expect(store.getById(id)!.status).toBe('pending');
    ends.revoke('M-1');
    expect(store.getById(id)).toMatchObject({ status: 'expired', closed_reason: 'mandate_ended' });
    expect(store.getById(owner)!.status).toBe('pending');
  });

  it('closes, when it boots, a mandate\'s question whose grant ended while it was down', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-mandateendboot-'));
    dirs.push(dir);
    const first = await boot(dir);
    // A parked question survives the restart (`expireUnparked` spares it); its grant does not.
    const tm = first.getTaskManager()!;
    const t = tm.create({ title: 'Ask once', taskType: 'scheduled', nextRunAt: '2030-01-01T00:00:00.000Z' });
    const id = first.getPromptStore()!.insertAskUser('s-1', 'q?', undefined, undefined, undefined, undefined, t.id,
      { principal: { kind: 'mandate', email: 'helper@example.invalid', mandateId: 'M-gone' } });
    await first.shutdown();
    engines.length = 0;
    const second = await boot(dir);
    expect(second.getPromptStore()!.getById(id)).toMatchObject({ status: 'expired', closed_reason: 'mandate_ended' });
  });

  it('closes, on the 5-minute prompt sweep, a mandate\'s question whose grant ran out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-mandatesweepboot-'));
    dirs.push(dir);
    // The engine's one 5-minute interval is the prompt sweep; it is caught, not waited for.
    const real = globalThis.setInterval;
    const sweeps: (() => void)[] = [];
    const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms?: number) => {
      if (ms === 5 * 60_000) sweeps.push(fn);
      return real(fn, ms);
    }) as typeof setInterval);
    let engine: Engine;
    try { engine = await boot(dir); } finally { spy.mockRestore(); }
    expect(sweeps).toHaveLength(1);
    const ends = engine.getMandateEnds()!;
    const store = engine.getPromptStore()!;
    const now = Math.floor(Date.now() / 1000);
    ends.record({ kind: 'mandate', email: 'helper@example.invalid', mandateId: 'M-short', mandateExp: now + 2 }, now);
    const id = store.insertAskUser('s-1', 'q?', undefined, undefined, undefined, undefined, undefined,
      { principal: { kind: 'mandate', email: 'helper@example.invalid', mandateId: 'M-short' } });
    sweeps[0]!();
    expect(store.getById(id)!.status).toBe('pending');
    // The grant runs out; no revoke, only the clock.
    const clock = vi.spyOn(Date, 'now').mockReturnValue((now + 3) * 1000);
    try { sweeps[0]!(); } finally { clock.mockRestore(); }
    expect(store.getById(id)).toMatchObject({ status: 'expired', closed_reason: 'mandate_ended' });
  });
});
