import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import type { LynoxConfig } from '../types/index.js';

/**
 * A SearXNG URL that names a private IP as a number used to boot as configured: its health check
 * answered (it does not pass the egress check), every search was then refused by the egress check,
 * and the model was told nothing. The boot now refuses it, falls back, and the prompt says so.
 * The health check answers here for every URL, so a refused URL is told apart by the status alone.
 */
describe('Engine boot — a SearXNG URL every search would be refused for', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  const prev = { dataDir: process.env['LYNOX_DATA_DIR'], searxng: process.env['SEARXNG_URL'] };

  afterEach(async () => {
    for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
    engines.length = 0;
    for (const [k, v] of [['LYNOX_DATA_DIR', prev.dataDir], ['SEARXNG_URL', prev.searxng]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    reloadConfig();
  });

  async function boot(searxngUrl: string, healthy = true): Promise<{ engine: Engine; stderr: string }> {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-searxng-boot-'));
    dirs.push(dir);
    process.env['LYNOX_DATA_DIR'] = dir;
    if (searxngUrl) process.env['SEARXNG_URL'] = searxngUrl; else delete process.env['SEARXNG_URL'];
    reloadConfig();
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input instanceof URL ? input.href : input);
      return new Response(url.endsWith('/healthz') && healthy ? 'OK' : '', { status: url.endsWith('/healthz') && healthy ? 200 : 404 });
    }));
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; });
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();
    return { engine, stderr: writes.join('') };
  }

  it('does not count a loopback IP as set up, and tells the operator the hostname way', async () => {
    const { engine, stderr } = await boot('http://127.0.0.1:18080');
    expect(engine.getWebSearchStatus()).toBe('fallback');
    expect(stderr).toContain('[lynox] SearXNG init failed: SearXNG URL http://127.0.0.1:18080 names the IP address 127.0.0.1');
    expect(stderr).toContain('Name the host instead: http://localhost:<port>');
    expect(stderr).toContain('[lynox] SearXNG URL refused, using DuckDuckGo HTML-scrape fallback (best-effort).');
    expect(stderr).not.toContain('No SearXNG configured');
  });

  it('keeps the old line when no SearXNG is set', async () => {
    const { engine, stderr } = await boot('');
    expect(engine.getWebSearchStatus()).toBe('fallback');
    expect(stderr).toContain('[lynox] No SearXNG configured — using DuckDuckGo HTML-scrape fallback (best-effort).');
  });

  it('does not call an unreachable SearXNG refused', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1000 });
    try {
      const { engine, stderr } = await boot('http://localhost:18080', false);
      expect(engine.getWebSearchStatus()).toBe('fallback');
      expect(stderr).not.toContain('SearXNG URL refused');
    } finally { vi.useRealTimers(); }
  }, 60_000);

  it('counts the same SearXNG named by a hostname as set up', async () => {
    const { engine } = await boot('http://localhost:18080');
    expect(engine.getWebSearchStatus()).toBe('configured');
  });
});
