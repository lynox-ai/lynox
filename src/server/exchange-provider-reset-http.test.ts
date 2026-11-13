import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';

/**
 * The provider reset through the HTTP API of a booted engine: a managed
 * instance that picked Mistral boots with the Shopify exchange on. The engine has put the pick back
 * on Anthropic, `GET /api/config` names the change for the line the page shows and locks the
 * Mistral tile, `PUT /api/config` refuses Mistral, and "Got it" or a provider pick ends the line.
 */
const { LynoxHTTPApi } = await import('./http-api.js');
const { reloadConfig } = await import('../core/config.js');

describe('the Shopify exchange on an instance that picked Mistral (real engine)', () => {
  // Built at runtime, never a literal: this repo is public and the commit scan looks for keys.
  const SECRET = `t-${randomBytes(12).toString('hex')}`;
  const POOL_KEY = `sk-ant-${randomBytes(12).toString('hex')}`;
  const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY', 'LYNOX_BILLING_TIER', 'LYNOX_SHOPIFY_EXCHANGE', 'ANTHROPIC_API_KEY', 'MISTRAL_API_KEY', 'LYNOX_MANAGED_CONTROL_PLANE_URL', 'LYNOX_MANAGED_INSTANCE_ID'];
  const saved: Record<string, string | undefined> = {};
  let api: InstanceType<typeof LynoxHTTPApi> | undefined;
  let baseUrl: string;
  let dir: string;

  async function call(method: string, path: string, body?: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, json: text === '' ? {} : JSON.parse(text) as Record<string, unknown> };
  }
  const noticeFile = (): string => join(dir, 'provider-reset.json');

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-provider-reset-http-'));
    for (const k of ENV) saved[k] = process.env[k];
    process.env['LYNOX_DATA_DIR'] = dir;
    process.env['LYNOX_HTTP_SECRET'] = SECRET;
    process.env['LYNOX_ALLOW_PLAIN_HTTP'] = 'true';
    process.env['LYNOX_VAULT_KEY'] = `v-${randomBytes(12).toString('hex')}`;
    process.env['LYNOX_BILLING_TIER'] = 'managed';
    process.env['LYNOX_SHOPIFY_EXCHANGE'] = '1';
    process.env['ANTHROPIC_API_KEY'] = POOL_KEY;
    delete process.env['MISTRAL_API_KEY'];
    // A managed tier boots with its control plane named; nothing here calls it.
    process.env['LYNOX_MANAGED_CONTROL_PLANE_URL'] = 'https://cp.example.test';
    process.env['LYNOX_MANAGED_INSTANCE_ID'] = 'zz-inst';
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ provider: 'openai', api_base_url: 'https://api.eu.mistral.ai/v1', openai_model_id: 'mistral-large-2512' }));
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
      rmSync(dir, { recursive: true, force: true });
      reloadConfig();
    }
  });

  it('booted on Anthropic and names the change and the lock', async () => {
    const stored = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8')) as Record<string, unknown>;
    expect(stored['provider']).toBe('anthropic');
    expect(stored['api_base_url']).toBeUndefined();

    const { status, json } = await call('GET', '/api/config');
    expect(status).toBe(200);
    expect(json['provider_reset']).toEqual({ from: 'Mistral' });
    expect((json['locks'] as Record<string, unknown>)['mistral_provider']).toEqual({ reason: 'shopify-exchange' });
  });

  it('refuses a Mistral pick sent past the locked tile', async () => {
    const res = await call('PUT', '/api/config', { provider: 'openai', api_base_url: 'https://api.eu.mistral.ai/v1', openai_model_id: 'mistral-large-2512' });
    expect(res.status).toBe(400);
    expect(String(res.json['error'])).toBe('Mistral is not available on this instance. Choose Anthropic.');
    const stored = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8')) as Record<string, unknown>;
    expect(stored['provider']).toBe('anthropic');
  });

  it('refuses a Mistral endpoint sent alone, onto a stored OpenAI-compatible pick', async () => {
    const before = readFileSync(join(dir, 'config.json'), 'utf-8');
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ provider: 'openai', api_base_url: 'https://api.groq.com/openai/v1', openai_model_id: 'x' }));
    try {
      const res = await call('PUT', '/api/config', { api_base_url: 'https://api.mistral.ai/v1' });
      expect(res.status).toBe(400);
      expect(String(res.json['error'])).toBe('Mistral is not available on this instance. Choose Anthropic.');
    } finally {
      writeFileSync(join(dir, 'config.json'), before);
    }
  });

  it('with the exchange turned off again: no lock and no line', async () => {
    delete process.env['LYNOX_SHOPIFY_EXCHANGE'];
    try {
      const { json } = await call('GET', '/api/config');
      expect(json['provider_reset']).toBeNull();
      expect((json['locks'] as Record<string, unknown>)['mistral_provider']).toBeUndefined();
    } finally {
      process.env['LYNOX_SHOPIFY_EXCHANGE'] = '1';
    }
    expect((await call('GET', '/api/config')).json['provider_reset']).toEqual({ from: 'Mistral' });
  });

  it('"Got it" ends the line for every page', async () => {
    expect(existsSync(noticeFile())).toBe(true);
    expect((await call('POST', '/api/config/provider-reset/dismiss')).status).toBe(200);
    expect(existsSync(noticeFile())).toBe(false);
    expect((await call('GET', '/api/config')).json['provider_reset']).toBeNull();
  });

  it('a provider the owner changes ends it too; a save that resends the same one does not', async () => {
    writeFileSync(noticeFile(), JSON.stringify({ from: 'Mistral', at: '2026-11-13T12:00:00.000Z' }));
    expect((await call('PUT', '/api/config', { default_tier: 'fast' })).status).toBe(200);
    expect(existsSync(noticeFile())).toBe(true);
    // The LLM page sends `provider` with every save.
    expect((await call('PUT', '/api/config', { provider: 'anthropic', default_tier: 'balanced' })).status).toBe(200);
    expect(existsSync(noticeFile())).toBe(true);
    // A stored config without a provider: picking Anthropic is a change.
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ default_tier: 'fast' }));
    expect((await call('PUT', '/api/config', { provider: 'anthropic' })).status).toBe(200);
    expect(existsSync(noticeFile())).toBe(false);
  });
});
