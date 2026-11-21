import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import type { Engine } from '../core/engine.js';

/**
 * `GET /api/triggers` tells the view about a watch the instance's network_policy keeps from its
 * page (U-392), through a real engine: from the policy as it is now, for watches only.
 */

const SECRET = `t-${randomBytes(12).toString('hex')}`;
const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE', 'LYNOX_DURABLE_MEMORY_ENABLED'];
const VAULT = `v-${randomBytes(12).toString('hex')}`;

type Inner = { engine: Engine; rateCounts: Map<string, unknown>; server: Server | null };

async function up(dir: string): Promise<{ api: LynoxHTTPApi; base: string; engine: Engine }> {
  process.env['LYNOX_DATA_DIR'] = dir;
  reloadConfig();
  const api = new LynoxHTTPApi();
  await api.init();
  await api.start(0);
  const addr = (api as unknown as Inner).server?.address();
  if (addr === null || addr === undefined || typeof addr === 'string') throw new Error('fixture: no port');
  return { api, base: `http://127.0.0.1:${String(addr.port)}`, engine: (api as unknown as Inner).engine };
}

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env['LYNOX_HTTP_SECRET'] = SECRET;
  process.env['LYNOX_ALLOW_PLAIN_HTTP'] = 'true';
  process.env['LYNOX_VAULT_KEY'] = VAULT;
  // A mandate is let in only on the durable memory tools (660a-2), as on the fleet.
  process.env['LYNOX_DURABLE_MEMORY_ENABLED'] = 'true';
  delete process.env['LYNOX_BILLING_TIER'];
  delete process.env['LYNOX_MANAGED_MODE'];
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('GET /api/triggers names a watch the network policy refuses (real engine)', () => {
  let dir: string;
  let api: LynoxHTTPApi;
  let base: string;
  let engine: Engine;
  let ownerCookie: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-watch-refused-'));
    ({ api, base, engine } = await up(dir));
    const { loginSession } = await import('../../packages/web-ui/src/lib/server/auth.js');
    const o = loginSession(SECRET, null)?.token;
    if (o === undefined) throw new Error('fixture: no cookie');
    ownerCookie = o;
    const wc = (url: string): string => JSON.stringify({ url, interval_minutes: 60 });
    const history = engine.getRunHistory()!;
    history.insertTrigger({ id: 'w-out', title: 'Out', source: 'watch', effect: 'run_agent', watchConfig: wc('https://other.example/p'), confirmedAt: '2026-01-01T00:00:00.000Z', confirmedBy: 'owner' });
    history.insertTrigger({ id: 'w-in', title: 'In', source: 'watch', effect: 'run_agent', watchConfig: wc('https://listed.example/p'), confirmedAt: '2026-01-01T00:00:00.000Z', confirmedBy: 'owner' });
    history.insertTrigger({ id: 'c-1', title: 'Cron', source: 'cron', effect: 'notify', scheduleCron: '0 9 * * 1', confirmedAt: '2026-01-01T00:00:00.000Z', confirmedBy: 'owner' });
  }, 120_000);
  afterAll(async () => {
    await api?.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  const list = async (): Promise<Record<string, Record<string, unknown>>> => {
    (api as unknown as Inner).rateCounts.clear();
    const res = await fetch(`${base}/api/triggers`, { headers: { cookie: `lynox_session=${ownerCookie}` } });
    const json = await res.json() as { triggers: Array<Record<string, unknown>> };
    return Object.fromEntries(json.triggers.map((t) => [String(t['id']), t]));
  };

  it('under allow-list names the host of a watch outside the list, and nothing for the rest', async () => {
    Object.assign(engine.getToolContext(), { networkPolicy: 'allow-list', allowedHosts: new Set(['listed.example']) });
    const rows = await list();
    expect(rows['w-out']!['blocked_reason']).toEqual({ kind: 'watch_allow_list', host: 'other.example' });
    expect(rows['w-in']!['blocked_reason']).toBeUndefined();
    expect(rows['c-1']!['blocked_reason']).toBeUndefined();
  });

  it('follows the policy as it is now: deny-all refuses every watch, guarded none', async () => {
    Object.assign(engine.getToolContext(), { networkPolicy: 'deny-all' });
    let rows = await list();
    expect(rows['w-in']!['blocked_reason']).toEqual({ kind: 'watch_deny_all' });
    expect(rows['w-out']!['blocked_reason']).toEqual({ kind: 'watch_deny_all' });
    Object.assign(engine.getToolContext(), { networkPolicy: 'guarded' });
    rows = await list();
    expect(rows['w-out']!['blocked_reason']).toBeUndefined();
    expect(rows['w-in']!['blocked_reason']).toBeUndefined();
  });
});
