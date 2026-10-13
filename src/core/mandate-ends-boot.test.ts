import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LynoxConfig } from '../types/index.js';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import { OWNER_PRINCIPAL, type RequestPrincipal } from './request-principal.js';
import { MandateEnds } from './mandate-ends.js';
import { BulkLedger } from './bulk-ledger.js';

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

  async function boot(dir: string, before?: (e: Engine) => void): Promise<Engine> {
    if (!saved.has('LYNOX_DATA_DIR')) saved.set('LYNOX_DATA_DIR', process.env['LYNOX_DATA_DIR']);
    process.env['LYNOX_DATA_DIR'] = dir;
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    before?.(engine);
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

    // With no store of ends, every mandate counts as ended — a live grant included.
    ends.record({ kind: 'mandate', email: 'helper@example.invalid', mandateId: 'M-long', mandateExp: now + 3_600 }, now);
    const live = store.insertAskUser('s-2', 'q?', undefined, undefined, undefined, undefined, undefined,
      { principal: { kind: 'mandate', email: 'helper@example.invalid', mandateId: 'M-long' } });
    sweeps[0]!();
    expect(store.getById(live)!.status).toBe('pending');
    (engine as unknown as { _mandateEnds: unknown })._mandateEnds = null;
    sweeps[0]!();
    expect(store.getById(live)).toMatchObject({ status: 'expired', closed_reason: 'mandate_ended' });
  });

  it('keeps its questions working when the sweep at boot fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-mandatesweepfail-'));
    dirs.push(dir);
    const first = await boot(dir);
    const t = first.getTaskManager()!.create({ title: 'Ask once', taskType: 'scheduled', nextRunAt: '2030-01-01T00:00:00.000Z' });
    const id = first.getPromptStore()!.insertAskUser('s-1', 'q?', undefined, undefined, undefined, undefined, t.id,
      { principal: { kind: 'mandate', email: 'helper@example.invalid', mandateId: 'M-any' } });
    await first.shutdown();
    engines.length = 0;
    const broken = vi.spyOn(MandateEnds.prototype, 'isLive').mockImplementation(() => { throw new Error('engine.db busy'); });
    let second: Engine;
    try { second = await boot(dir); } finally { broken.mockRestore(); }
    const store = second.getPromptStore();
    expect(store).not.toBeNull();
    expect(store!.getById(id)!.status).toBe('pending');
    // The next sweep, with engine.db readable again, closes it.
    second.getMandateEnds()!.revoke('M-other');
    expect(store!.getById(id)).toMatchObject({ status: 'expired', closed_reason: 'mandate_ended' });
  });

  describe('bulk runs (§3.13 B7)', () => {
    const withBulk = (e: Engine): void => { e.getUserConfig().bulk_runs_enabled = true; };
    const GRANT = { kind: 'mandate' as const, email: 'helper@example.invalid', mandateId: 'M-bulk' };
    const plan = (engine: Engine, principal: RequestPrincipal, createdBy = 't'): string =>
      engine.getToolContext().bulkLedger!.recordDryRun({
        createdBy, principal, targetSystem: 'workspace', scope: 'w',
        targets: [{ key: '/ws/a.md', before: { absent: false, value: 'old' }, after: 'new' }],
      }).id;
    const phaseOf = (engine: Engine, id: string): string | undefined => engine.getToolContext().bulkLedger!.getStatus(id)?.phase;
    afterEach(() => { for (const e of engines) delete e.getUserConfig().bulk_runs_enabled; });

    it('withdraws a mandate\'s unapproved run the moment the mandate is revoked, and not the owner\'s', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'lynox-bulkrevokeboot-'));
      dirs.push(dir);
      const engine = await boot(dir, withBulk);
      engine.getMandateEnds()!.record({ ...GRANT, mandateExp: Math.floor(Date.now() / 1000) + 3_600 }, 100);
      const mine = plan(engine, GRANT);
      const owners = plan(engine, OWNER_PRINCIPAL);
      expect(phaseOf(engine, mine)).toBe('previewed');
      engine.getMandateEnds()!.revoke('M-bulk');
      expect(phaseOf(engine, mine)).toBe('aborted');
      expect(phaseOf(engine, owners)).toBe('previewed');
    });

    it('at boot, keeps a run from before v31 in the owner\'s conversation and withdraws one whose conversation it cannot place', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'lynox-bulklegacyboot-'));
      dirs.push(dir);
      const first = await boot(dir, withBulk);
      first.getThreadStore()!.createThread('owner-thread', { created_by: 'owner' });
      const kept = plan(first, OWNER_PRINCIPAL, 'owner-thread');
      const lost = plan(first, OWNER_PRINCIPAL, 'nowhere');
      // As a run from before v31 looks: no planner.
      const edb = (first as unknown as { engineDb: { getDb(): import('better-sqlite3').Database } }).engineDb.getDb();
      edb.prepare(`UPDATE bulk_runs SET principal = NULL, created_at = '2026-10-13 08:00:00'`).run();
      await first.shutdown();
      engines.length = 0;
      const second = await boot(dir, withBulk);
      expect(phaseOf(second, kept)).toBe('previewed');
      expect(phaseOf(second, lost)).toBe('aborted');
    });

    it('keeps the bulk tools working when the sweep at boot fails', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'lynox-bulksweepfail-'));
      dirs.push(dir);
      const broken = vi.spyOn(BulkLedger.prototype, 'expireEndedPlanners').mockImplementation(() => { throw new Error('engine.db busy'); });
      let engine: Engine;
      try { engine = await boot(dir, withBulk); } finally { broken.mockRestore(); }
      expect(engine.getToolContext().bulkLedger).not.toBeNull();
      expect(phaseOf(engine, plan(engine, OWNER_PRINCIPAL))).toBe('previewed');
    });

    it('withdraws, on its 5-minute sweep, a run whose grant ran out', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'lynox-bulksweepboot-'));
      dirs.push(dir);
      const real = globalThis.setInterval;
      const sweeps: (() => void)[] = [];
      const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms?: number) => {
        if (ms === 5 * 60_000) sweeps.push(fn);
        return real(fn, ms);
      }) as typeof setInterval);
      let engine: Engine;
      try { engine = await boot(dir, withBulk); } finally { spy.mockRestore(); }
      // The prompt sweep and the bulk sweep.
      expect(sweeps).toHaveLength(2);
      const now = Math.floor(Date.now() / 1000);
      engine.getMandateEnds()!.record({ ...GRANT, mandateExp: now + 2 }, now);
      const id = plan(engine, GRANT);
      for (const s of sweeps) s();
      expect(phaseOf(engine, id)).toBe('previewed');
      const clock = vi.spyOn(Date, 'now').mockReturnValue((now + 3) * 1000);
      try { for (const s of sweeps) s(); } finally { clock.mockRestore(); }
      expect(phaseOf(engine, id)).toBe('aborted');
    });

    it('stops its 5-minute sweep at shutdown', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'lynox-bulksweepstop-'));
      dirs.push(dir);
      const real = globalThis.setInterval;
      const handles: ReturnType<typeof setInterval>[] = [];
      const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms?: number) => {
        const h = real(fn, ms);
        if (ms === 5 * 60_000) handles.push(h);
        return h;
      }) as typeof setInterval);
      let engine: Engine;
      try { engine = await boot(dir, withBulk); } finally { spy.mockRestore(); }
      expect(handles).toHaveLength(2);
      const clear = vi.spyOn(globalThis, 'clearInterval');
      try {
        await engine.shutdown();
        engines.length = 0;
        for (const h of handles) expect(clear).toHaveBeenCalledWith(h);
      } finally { clear.mockRestore(); }
    });
  });
});
