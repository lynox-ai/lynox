import { describe, it, expect, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { ExactClearance, type ExactMarker } from './exact-clearance.js';
import { DEBUG_ENV_VARS, isExactHeld, refuseDebug } from './exact-debug-refusal.js';
import { withWireRules, quietSdkLogs, _resetSdkLogQuieting } from './llm-wire-rules.js';
import { initDebugSubscriber, _resetDebugSubscriber } from './debug-subscriber.js';
import { channels } from './observability.js';
import { RunHistory } from './run-history.js';
import { isWireSinkEnabled, isRawWireSinkEnabled, _resetWireCaptureClosed, type WireSnapshot } from './wire-capture.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * S3 of PRD-SHOPIFY-CONTAINMENT-ERASURE (E4): once the exact marker is set, the debug paths
 * stay off. The boot half is in exact-debug-refusal-boot.test.ts.
 */

function memoryMarker(opts: { readThrows?: boolean; writeThrows?: boolean } = {}): ExactMarker & { value: boolean } {
  const m = {
    value: false,
    isSet(): boolean { if (opts.readThrows) throw new Error('unreadable'); return m.value; },
    set(): void { if (opts.writeThrows) throw new Error('unwritable'); m.value = true; },
  };
  return m;
}

const CP = { url: 'http://cp.invalid', instanceId: 'i-1', secret: 's' };
const answer = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as typeof fetch;

afterEach(() => {
  _resetSdkLogQuieting();
  _resetDebugSubscriber();
  _resetWireCaptureClosed();
  vi.restoreAllMocks();
});

describe('isExactHeld', () => {
  it('reads the marker', () => {
    const m = memoryMarker();
    expect(isExactHeld(m)).toBe(false);
    m.set();
    expect(isExactHeld(m)).toBe(true);
  });

  it('counts an unreadable marker as held', () => {
    expect(isExactHeld(memoryMarker({ readThrows: true }))).toBe(true);
  });

  it('counts no marker at all (engine.db did not open) as held', () => {
    expect(isExactHeld(null)).toBe(true);
  });
});

describe('the hook in ExactClearance', () => {
  it('runs after the marker is set and before the boot counts as cleared', async () => {
    const m = memoryMarker();
    const seen: { markerSet: boolean; blocked: boolean }[] = [];
    let clearance: ExactClearance | null = null;
    clearance = new ExactClearance(CP, m, {
      fetch: answer({ ok: true }),
      onMarkerSet: () => { seen.push({ markerSet: m.value, blocked: clearance!.blockedNow() }); },
    });
    expect(await clearance.ensure()).toEqual({ ok: true });
    expect(seen).toEqual([{ markerSet: true, blocked: false }]);
  });

  it('keys on the marker alone: held after the first ok, with no profile or token anywhere (D3)', async () => {
    const m = memoryMarker();
    const clearance = new ExactClearance(CP, m, { fetch: answer({ ok: true }), onMarkerSet: () => undefined });
    await clearance.ensure();
    expect(isExactHeld(m)).toBe(true);
  });

  it('a throwing hook does not turn the clearance into a refusal', async () => {
    const clearance = new ExactClearance(CP, memoryMarker(), { fetch: answer({ ok: true }), onMarkerSet: () => { throw new Error('boom'); } });
    expect(await clearance.ensure()).toEqual({ ok: true });
  });

  it('does not run when the control plane refuses or the marker cannot be written', async () => {
    const calls: string[] = [];
    const refused = new ExactClearance(CP, memoryMarker(), { fetch: answer({ ok: false, reason: 'floor' }), onMarkerSet: () => { calls.push('refused'); } });
    await refused.ensure();
    const unwritable = new ExactClearance(CP, memoryMarker({ writeThrows: true }), { fetch: answer({ ok: true }), onMarkerSet: () => { calls.push('unwritable'); } });
    expect(await unwritable.ensure()).toEqual({ ok: false, reason: 'marker_unwritable' });
    expect(calls).toEqual([]);
  });
});

describe('refuseDebug', () => {
  it('removes every debug variable and reports names, never values', () => {
    const env: NodeJS.ProcessEnv = { KEEP: 'x' };
    for (const v of DEBUG_ENV_VARS) env[v] = `value-of-${v}`;
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array) => { writes.push(String(s)); return true; });
    expect(refuseDebug(env)).toEqual([...DEBUG_ENV_VARS]);
    expect(env).toEqual({ KEEP: 'x' });
    expect(writes.join('')).toContain('ANTHROPIC_LOG');
    expect(writes.join('')).not.toContain('value-of-');
  });

  it('is idempotent and silent when nothing is set', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(refuseDebug({})).toEqual([]);
    expect(refuseDebug({})).toEqual([]);
    expect(write).not.toHaveBeenCalled();
  });
});

describe('the SDK request log', () => {
  /** A real SDK client, built the way `createLLMClient` builds one, that logs into `lines`. */
  function client(level: 'off' | 'error' | 'warn' | 'info' | 'debug', lines: string[]): Anthropic {
    const log = (tag: string) => (...args: unknown[]) => { lines.push(`${tag} ${args.map(String).join(' ')}`); };
    const fakeFetch = (async () => new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    return withWireRules(new Anthropic({ apiKey: 'k', baseURL: 'http://llm.invalid', logLevel: level, logger: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') }, fetch: fakeFetch, maxRetries: 0 }));
  }
  const send = (c: Anthropic) => c.messages.create({ model: 'claude-x', max_tokens: 1, messages: [{ role: 'user', content: 'store data' }] });

  it('a client built at debug logs the request, and after quieting it does not', async () => {
    const lines: string[] = [];
    const c = client('debug', lines);
    await send(c);
    expect(lines.some((l) => l.startsWith('debug'))).toBe(true);
    lines.length = 0;
    quietSdkLogs();
    await send(c);
    expect(lines.filter((l) => l.startsWith('debug') || l.startsWith('info'))).toEqual([]);
  });

  it('a client built after the quieting starts quiet', async () => {
    quietSdkLogs();
    const lines: string[] = [];
    await send(client('debug', lines));
    expect(lines.filter((l) => l.startsWith('debug') || l.startsWith('info'))).toEqual([]);
  });

  it('refuseDebug quiets the clients that are already built', async () => {
    const lines: string[] = [];
    const c = client('debug', lines);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    refuseDebug({});
    await send(c);
    expect(lines.filter((l) => l.startsWith('debug') || l.startsWith('info'))).toEqual([]);
  });

  it('only ever quieter: off and error stay where they are', () => {
    const off = client('off', []);
    const error = client('error', []);
    const info = client('info', []);
    quietSdkLogs();
    expect([off.logLevel, error.logLevel, info.logLevel]).toEqual(['off', 'error', 'warn']);
  });

  it('nothing in src/ copies a client past the register (`withOptions`)', () => {
    const root = join(__dirname, '..');
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!p.endsWith('.ts') || p.endsWith('.test.ts') || p.endsWith('.d.ts')) continue;
        readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
          if (/\.withOptions\s*\(/.test(line)) hits.push(`${relative(root, p)}:${i + 1}`);
        });
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});

describe('the debug subscriber', () => {
  it('writes nothing once refused, though it was subscribed', () => {
    const before = process.env['LYNOX_DEBUG'];
    process.env['LYNOX_DEBUG'] = '1';
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array) => { writes.push(String(s)); return true; });
    try {
      expect(initDebugSubscriber()).toBe(true);
      writes.length = 0;
      channels.toolStart.publish({ name: 'probe-before', input: {} });
      expect(writes.join('')).toContain('probe-before');
      refuseDebug(process.env);
      writes.length = 0;
      channels.toolStart.publish({ name: 'probe-after', input: {} });
      expect(writes.join('')).not.toContain('probe-after');
      expect(process.env['LYNOX_DEBUG']).toBeUndefined();
    } finally {
      if (before === undefined) delete process.env['LYNOX_DEBUG']; else process.env['LYNOX_DEBUG'] = before;
    }
  });
});

describe('wire capture', () => {
  const snapshot = (turnIndex: number): WireSnapshot => ({
    runId: 'run-1', turnIndex, model: 'claude-x', provider: 'anthropic', systemPromptHash: 'h',
    userMessage: 'store data', userMessageChars: 10, toolNames: [], toolCount: 0, toolChoice: undefined,
    temperature: undefined, maxTokens: 1, ephemeralTailPresent: false, ephemeralTailChars: 0, capturedAt: Date.now(),
  });

  it('the owner setting persists snapshots before the refusal and none after it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-exact-wire-'));
    try {
      const h = new RunHistory(join(dir, 'history.db'));
      h.insertWireSnapshot(snapshot(1));
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      refuseDebug({});
      h.insertWireSnapshot(snapshot(2));
      expect(h.getWireSnapshotsForRun('run-1').map((r) => r.turn_index)).toEqual([1]);
      h.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the file sinks refuse after the refusal, even where their gate files exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-exact-sink-'));
    try {
      const gate = join(dir, 'gate'); const raw = join(dir, 'raw-gate');
      writeFileSync(gate, ''); writeFileSync(raw, '');
      const env: NodeJS.ProcessEnv = { LYNOX_DEBUG_WIRE_GATE_FILE: gate, LYNOX_DEBUG_WIRE_RAW_GATE_FILE: raw };
      expect([isWireSinkEnabled(env), isRawWireSinkEnabled(env)]).toEqual([true, true]);
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      refuseDebug({});
      expect([isWireSinkEnabled(env), isRawWireSinkEnabled(env)]).toEqual([false, false]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
