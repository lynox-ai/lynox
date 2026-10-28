import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { ChatContextRef } from '../core/chat-context.js';

/**
 * The first run of a chat opened with "Plan in a new chat" names where it came from
 * (`context: { kind: 'contained-origin', id }`). The run route has to hand that reference to
 * the context resolver, which turns it into a fixed sentence; a kind the route does not take is
 * dropped without a word, and the agent would plan without being pointed at a bulk run. On a
 * booted engine, with the resolver watched. The resolver is called before the provider key is
 * checked, so no model is needed.
 */
const seen: ChatContextRef[] = [];
vi.mock('../core/chat-context.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../core/chat-context.js')>();
  return {
    ...orig,
    resolveChatContext: (...args: Parameters<typeof orig.resolveChatContext>) => {
      seen.push(args[1]);
      return orig.resolveChatContext(...args);
    },
  };
});

const { LynoxHTTPApi } = await import('./http-api.js');
const { reloadConfig } = await import('../core/config.js');

describe('the run route takes a contained-origin context (real engine)', () => {
  // Built at runtime, never a literal: this repo is public and the commit scan looks for keys.
  const SECRET = `t-${randomBytes(12).toString('hex')}`;
  const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY'];
  const saved: Record<string, string | undefined> = {};
  let api: InstanceType<typeof LynoxHTTPApi> | undefined;
  let baseUrl: string;
  let dir: string | undefined;

  async function post(path: string, body: Record<string, unknown>): Promise<string> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.text();
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-contained-origin-'));
    for (const k of ENV) saved[k] = process.env[k];
    process.env['LYNOX_DATA_DIR'] = dir;
    process.env['LYNOX_HTTP_SECRET'] = SECRET;
    process.env['LYNOX_ALLOW_PLAIN_HTTP'] = 'true';
    process.env['LYNOX_VAULT_KEY'] = `v-${randomBytes(12).toString('hex')}`;
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

  async function runWith(context: Record<string, unknown>): Promise<ChatContextRef[]> {
    const { sessionId } = JSON.parse(await post('/api/sessions', {})) as { sessionId: string };
    seen.length = 0;
    await post(`/api/sessions/${sessionId}/run`, { task: 'improve the descriptions', context });
    return [...seen];
  }

  it('hands the reference to the resolver', async () => {
    expect(await runWith({ kind: 'contained-origin', id: 't-old' })).toEqual([{ kind: 'contained-origin', id: 't-old' }]);
  });

  it('drops a kind it does not take, and one without an id', async () => {
    expect(await runWith({ kind: 'contained-elsewhere', id: 't-old' })).toEqual([]);
    expect(await runWith({ kind: 'contained-origin' })).toEqual([]);
  });

  it('positive control: an established kind reaches the resolver the same way', async () => {
    expect(await runWith({ kind: 'run', id: 'r-1' })).toEqual([{ kind: 'run', id: 'r-1' }]);
  });
});
