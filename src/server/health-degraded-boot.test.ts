import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';

/**
 * `/api/health` after a boot in which engine.db or history.db could not be opened.
 *
 * The engine catches the failure, leaves the store null for the life of the process and writes one
 * line to stderr. Before this, the health body said `status: 'ok'` regardless, so nothing that reads
 * it could tell such an instance from a healthy one.
 *
 * A REAL boot, not the engine stub of `http-api.test.ts`: the store is broken the way the boot meets
 * it (a directory where the database file belongs, which SQLite cannot open), so the test also covers
 * the wiring from the boot's `catch` to the field the health route reads.
 *
 * The body says one word and nothing else: the route answers without auth, so which store failed,
 * and why, stays in the log.
 *
 * One engine per test, shut down before the env goes: a shutdown reads the data dir from the env.
 */

const SECRET = 'health-degraded-test-secret-value';

/** The top-level keys of the health body the control plane parses (`src/contract/fixtures`). */
const CONTRACT_KEYS = Object.keys(JSON.parse(readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../contract/fixtures/health-body.json'), 'utf8',
)) as Record<string, unknown>).sort();

let booted: { api: LynoxHTTPApi; dir: string } | null = null;

afterEach(async () => {
  if (booted !== null) {
    const { api, dir } = booted;
    booted = null;
    await api.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
  reloadConfig(); // and leak none of it into the next test
});

async function bootAndProbe(broken: 'engine.db' | 'history.db' | null, durable?: 'true' | 'false'): Promise<{ body: Record<string, unknown>; text: string; status: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-health-degraded-'));
  if (broken !== null) mkdirSync(join(dir, broken));
  vi.stubEnv('LYNOX_DATA_DIR', dir);
  vi.stubEnv('LYNOX_HTTP_SECRET', SECRET);
  vi.stubEnv('LYNOX_ALLOW_PLAIN_HTTP', 'true');
  vi.stubEnv('LYNOX_MANAGED_INSTANCE_ID', undefined);
  vi.stubEnv('LYNOX_DURABLE_MEMORY_ENABLED', durable);
  reloadConfig(); // loadConfig() memoizes: read the env just set

  const api = new LynoxHTTPApi();
  booted = { api, dir };
  await api.init();
  await api.start(0);
  const port = api.boundPort;
  if (port === undefined) throw new Error('server is not bound after start()');
  const res = await fetch(`http://127.0.0.1:${String(port)}/api/health`);
  const text = await res.text();
  return { body: JSON.parse(text) as Record<string, unknown>, text, status: res.status };
}

describe('/api/health after the boot', () => {
  it('says ok when both boot stores opened', async () => {
    const r = await bootAndProbe(null);
    expect(r.status).toBe(200);
    expect(r.body['status']).toBe('ok');
    expect(Object.keys(r.body).sort()).toEqual(CONTRACT_KEYS);
  }, 60_000);

  it.each(['engine.db', 'history.db'] as const)('says degraded, with HTTP 200, when %s could not be opened', async (broken) => {
    const r = await bootAndProbe(broken);
    // HTTP stays 200: a reader that only asks "is it up" (the container check, a rollout poll on the
    // version) keeps its answer. Only a reader of `status` sees the change.
    expect(r.status).toBe(200);
    expect(r.body['status']).toBe('degraded');
    // One word, nothing else: the keys of the contract body, and no name of the store in it.
    expect(Object.keys(r.body).sort()).toEqual(CONTRACT_KEYS);
    expect(r.text).not.toContain(broken);
    expect(r.text).not.toMatch(/history|engine\.db|run.?history|engine.?db/i);
  }, 60_000);
});

/**
 * `engine.durable_memory`: the one word the control plane reads
 * to tell an owner, before a grant, that a mandate login will be refused here. Real boots, so the
 * word comes from what the boot actually wired, not from a stub.
 */
describe('/api/health names whether durable knowledge runs', () => {
  const word = (body: Record<string, unknown>): unknown => (body['engine'] as Record<string, unknown>)['durable_memory'];

  it('says on when it is switched on and its store loaded', async () => {
    expect(word((await bootAndProbe(null, 'true')).body)).toBe('on');
  }, 60_000);

  it('says off when it is switched off', async () => {
    expect(word((await bootAndProbe(null, 'false')).body)).toBe('off');
  }, 60_000);

  it('says not_loaded when it is switched on but engine.db could not be opened, and nothing more', async () => {
    const r = await bootAndProbe('engine.db', 'true');
    expect(word(r.body)).toBe('not_loaded');
    expect(r.text).not.toMatch(/engine\.db|EngineDb|wiring/i);
  }, 60_000);
});
