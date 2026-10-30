import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import type { ThreadStore } from '../core/thread-store.js';
import type { RunHistory } from '../core/run-history.js';
import type { ToolContext } from '../core/tool-context.js';
import { Containment } from '../core/containment.js';

/**
 * The workflow-run routes mark a run started from a contained chat, from that chat's record
 * (`origin_thread_id`): its outputs carry what the chat read. A failed read is marked as one. On a
 * booted engine, because the record and the run history have to be wired where the routes look.
 */
describe('GET /api/workflows and /api/workflows/:id mark a run from a contained chat (real engine)', () => {
  // Built at runtime, never a literal: a key-shaped fixture string is what the commit-time
  // secret scan looks for, and this repo is public.
  const SECRET = `t-${randomBytes(12).toString('hex')}`;
  const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE', 'LYNOX_MANAGED_CONTROL_PLANE_URL', 'LYNOX_MANAGED_INSTANCE_ID'];
  const saved: Record<string, string | undefined> = {};
  let api: LynoxHTTPApi | undefined;
  let baseUrl: string;
  let dir: string | undefined;

  function engine(): { getThreadStore: () => ThreadStore | null; getToolContext: () => ToolContext; getRunHistory: () => RunHistory | null } {
    return (api as unknown as { engine: ReturnType<typeof engine> }).engine;
  }

  async function get(path: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${SECRET}` } });
    expect(res.status).toBe(200);
    return await res.json() as Record<string, unknown>;
  }
  /** The mark fields of a run, in the detail and in the list; `absent` where a field is left out. */
  const field = (o: Record<string, unknown>, k: string): unknown => (k in o ? o[k] : 'absent');
  /** The mark of a run in the detail, the list and the step outputs; `absent` where a field is left out. */
  async function marks(runId: string): Promise<{ detail: [unknown, unknown]; list: [unknown, unknown] }> {
    const d = await get(`/api/workflows/${runId}`);
    const l = ((await get('/api/workflows?limit=500'))['runs'] as Array<Record<string, unknown>>).find((r) => r['id'] === runId)!;
    const s = await get(`/api/workflows/${runId}/steps`);
    // The step outputs carry the same mark as the detail.
    expect([field(s, 'contained'), field(s, 'contained_unknown')]).toEqual([field(d, 'contained'), field(d, 'contained_unknown')]);
    return { detail: [field(d, 'contained'), field(d, 'contained_unknown')], list: [field(l, 'contained'), field(l, 'contained_unknown')] };
  }
  function addRun(id: string, originThreadId?: string, parentRunId?: string): void {
    engine().getRunHistory()!.insertPipelineRun({
      id, manifestName: `wf-${id}`, status: 'completed', manifestJson: '{}',
      ...(originThreadId !== undefined ? { originThreadId } : {}), ...(parentRunId !== undefined ? { parentRunId } : {}),
    });
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-contained-get-'));
    for (const k of ENV) saved[k] = process.env[k];
    process.env['LYNOX_DATA_DIR'] = dir;
    process.env['LYNOX_HTTP_SECRET'] = SECRET;
    process.env['LYNOX_ALLOW_PLAIN_HTTP'] = 'true';
    process.env['LYNOX_VAULT_KEY'] = `v-${randomBytes(12).toString('hex')}`;
    // A self-hosted instance unless a test says otherwise (`contained_unknown` follows it).
    for (const k of ['LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE', 'LYNOX_MANAGED_CONTROL_PLANE_URL', 'LYNOX_MANAGED_INSTANCE_ID']) delete process.env[k];
    reloadConfig();
    api = new LynoxHTTPApi();
    await api.init();
    await api.start(0);
    const addr = (api as unknown as { server: Server | null }).server?.address();
    if (addr === null || addr === undefined || typeof addr === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }, 120_000);

  afterAll(async () => {
    try {
      await api?.shutdown();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
      reloadConfig();
    }
  });

  it('a run from a contained chat is marked, one from another chat or from no chat is not', async () => {
    const ts = engine().getThreadStore()!;
    const containment = engine().getToolContext().containment!;
    ts.createThread('w-shop', { title: 'shop' });
    ts.createThread('w-free', { title: 'free' });
    containment.contain({ kind: 'thread', id: 'w-shop' }, { kind: 'api', connectionId: 'shop-acme' });
    addRun('run-shop-0001', 'w-shop');
    addRun('run-free-0001', 'w-free');
    addRun('run-none-0001');
    expect(await marks('run-shop-0001')).toEqual({ detail: [true, 'absent'], list: [true, 'absent'] });
    expect(await marks('run-free-0001')).toEqual({ detail: ['absent', 'absent'], list: ['absent', 'absent'] });
    expect(await marks('run-none-0001')).toEqual({ detail: ['absent', 'absent'], list: ['absent', 'absent'] });
  });

  it('a nested run carries its own origin and is marked in its detail; an empty origin is no chat', async () => {
    const ts = engine().getThreadStore()!;
    ts.createThread('w-nest', { title: 'nest' });
    engine().getToolContext().containment!.contain({ kind: 'thread', id: 'w-nest' }, { kind: 'api', connectionId: 'shop-acme' });
    addRun('run-parent-01', 'w-nest');
    addRun('run-child-001', 'w-nest', 'run-parent-01');
    const d = await get('/api/workflows/run-child-001');
    expect([field(d, 'contained'), field(d, 'contained_unknown')]).toEqual([true, 'absent']);
    // An empty origin is not a chat, even though an empty container counts as contained.
    addRun('run-empty-001', '');
    expect(await marks('run-empty-001')).toEqual({ detail: ['absent', 'absent'], list: ['absent', 'absent'] });
  });

  it('the detail found by a prefix of the id is marked by the run it found', async () => {
    const ts = engine().getThreadStore()!;
    ts.createThread('w-pref', { title: 'pref' });
    engine().getToolContext().containment!.contain({ kind: 'thread', id: 'w-pref' }, { kind: 'api', connectionId: 'shop-acme' });
    addRun('run-prefix-full-0001', 'w-pref');
    const d = await get('/api/workflows/run-prefix-full');
    expect(d['id']).toBe('run-prefix-full-0001');
    expect(field(d, 'contained')).toBe(true);
  });

  it('a record that cannot be read marks the run as a failed check, by instance; a run from no chat stays unmarked', async () => {
    const ctx = engine().getToolContext();
    engine().getThreadStore()!.createThread('w-unread', { title: 'x' });
    addRun('run-unread-01', 'w-unread');
    addRun('run-none-0002');
    const real = ctx.containment;
    ctx.containment = new Containment({ prepare: () => { throw new Error('disk I/O error'); } } as never, null);
    try {
      expect(await marks('run-unread-01')).toEqual({ detail: [true, 'self-hosted'], list: [true, 'self-hosted'] });
      expect(await marks('run-none-0002')).toEqual({ detail: ['absent', 'absent'], list: ['absent', 'absent'] });
      process.env['LYNOX_BILLING_TIER'] = 'managed';
      try {
        expect(await marks('run-unread-01')).toEqual({ detail: [true, 'provisioned'], list: [true, 'provisioned'] });
      } finally {
        delete process.env['LYNOX_BILLING_TIER'];
      }
    } finally {
      ctx.containment = real;
    }
    expect(await marks('run-unread-01')).toEqual({ detail: ['absent', 'absent'], list: ['absent', 'absent'] });
  });
});
