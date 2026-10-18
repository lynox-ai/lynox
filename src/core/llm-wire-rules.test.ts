import { describe, it, expect } from 'vitest';
import { inspect } from 'node:util';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import {
  shapeRequestForModel,
  assertForcedToolCalled,
  ForcedToolNotCalledError,
  forcedToolInstruction,
  withWireRules,
  isWireShaped,
  isCutOffReply,
  ForcedToolInBatchError,
} from './llm-wire-rules.js';
import { createLLMClient } from './llm-client.js';
import { MODEL_CAPABILITIES } from '../types/models.js';

const TOOL = { type: 'tool', name: 'extract' } as const;

describe('shapeRequestForModel', () => {
  it('hands a model without rules the very same object', () => {
    const p = { model: 'claude-sonnet-4-6', temperature: 0, tool_choice: TOOL, thinking: { type: 'disabled' } };
    expect(shapeRequestForModel(p).params).toBe(p);
    expect(shapeRequestForModel(p).forced).toBeUndefined();
  });

  it('drops sampling fields where the model rejects them, and only there', () => {
    const p = { model: 'claude-sonnet-5', max_tokens: 10, temperature: 0, top_p: 0.5, top_k: 3 };
    const out = shapeRequestForModel(p).params;
    expect(out).not.toHaveProperty('temperature');
    expect(out).not.toHaveProperty('top_p');
    expect(out).not.toHaveProperty('top_k');
    expect(out['max_tokens']).toBe(10);
    // Pure: the caller's object is untouched.
    expect(p.temperature).toBe(0);
  });

  it('omits disabled thinking on Opus 5.5 and sends between_tools on Sonnet 5.5', () => {
    const opus = shapeRequestForModel({ model: 'claude-opus-5-5', thinking: { type: 'disabled' } }).params;
    expect(opus).not.toHaveProperty('thinking');
    const sonnet = shapeRequestForModel({ model: 'claude-sonnet-5-5', thinking: { type: 'disabled' } }).params;
    expect(sonnet['thinking']).toEqual({ type: 'between_tools' });
    // Adaptive thinking is not touched.
    const adaptive = shapeRequestForModel({ model: 'claude-sonnet-5-5', thinking: { type: 'adaptive' } }).params;
    expect(adaptive['thinking']).toEqual({ type: 'adaptive' });
  });

  it('relaxes a forced tool to auto, keeps parallel-use, and says in the system prompt what is expected', () => {
    const { params, forced } = shapeRequestForModel({
      model: 'claude-opus-5-5',
      system: 'You extract facts.',
      tool_choice: { ...TOOL, disable_parallel_tool_use: true },
    });
    expect(forced).toEqual(TOOL);
    expect(params['tool_choice']).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    expect(params['system']).toBe(`You extract facts.\n\n${forcedToolInstruction(TOOL)}`);
  });

  it('uses the instruction alone when system is absent or empty', () => {
    for (const system of [undefined, '']) {
      const { params } = shapeRequestForModel({ model: 'claude-opus-5-5', ...(system === undefined ? {} : { system }), tool_choice: { type: 'any' } });
      expect(params['system']).toBe(forcedToolInstruction({ type: 'any' }));
    }
  });

  it('appends the instruction as a block to a block-array system, keeping cache markers in place', () => {
    const block = { type: 'text', text: 'cached prefix', cache_control: { type: 'ephemeral' } };
    const { params } = shapeRequestForModel({ model: 'claude-sonnet-5-5', system: [block], tool_choice: { type: 'any' } });
    expect(params['system']).toEqual([block, { type: 'text', text: forcedToolInstruction({ type: 'any' }) }]);
  });

  it('leaves a forced tool alone on Haiku 5.5, which accepts it', () => {
    const p = { model: 'claude-haiku-5-5', tool_choice: TOOL, temperature: 0 };
    const { params, forced } = shapeRequestForModel(p);
    expect(forced).toBeUndefined();
    expect(params['tool_choice']).toEqual(TOOL);
    expect(params).not.toHaveProperty('temperature');
  });
});

describe('the rule table', () => {
  it('rules only on Anthropic-wire models, each with a cited source', () => {
    // A rule on an openai-wire model would never run (the adapter is not wrapped) and
    // would read as protection that is not there.
    const ruled = Object.entries(MODEL_CAPABILITIES).filter(([, m]) => m.wireRules);
    expect(ruled.length).toBeGreaterThan(0);
    for (const [id, m] of ruled) expect(['anthropic', 'vertex'], id).toContain(m.provider);
  });
});

describe('assertForcedToolCalled', () => {
  const usage = { input_tokens: 120, output_tokens: 30 };

  it('throws a named error when the reply is text only — the silent-empty case', () => {
    const reply = { content: [{ type: 'text', text: 'Here are the facts: …' }], usage };
    expect(() => assertForcedToolCalled('claude-opus-5-5', TOOL, reply)).toThrow(ForcedToolNotCalledError);
  });

  it('throws when a DIFFERENT tool was called', () => {
    const reply = { content: [{ type: 'tool_use', name: 'other' }], usage };
    expect(() => assertForcedToolCalled('claude-opus-5-5', TOOL, reply)).toThrow(ForcedToolNotCalledError);
  });

  it('passes when the required tool was called, and for `any` when some tool was', () => {
    expect(() => assertForcedToolCalled('m', TOOL, { content: [{ type: 'tool_use', name: 'extract' }] })).not.toThrow();
    expect(() => assertForcedToolCalled('m', { type: 'any' }, { content: [{ type: 'tool_use', name: 'x' }] })).not.toThrow();
  });

  it('carries the usage to book, and keeps the reply text out of every serialised form', () => {
    const secret = 'Kundin Muster schuldet 4200 CHF';
    const reply = { content: [{ type: 'text', text: secret }], usage };
    let err: ForcedToolNotCalledError | undefined;
    try { assertForcedToolCalled('claude-opus-5-5', TOOL, reply); } catch (e) { err = e as ForcedToolNotCalledError; }
    expect(err).toBeInstanceOf(ForcedToolNotCalledError);
    expect(err!.usage).toEqual(usage);
    // Reachable on purpose…
    expect(err!.response).toBe(reply);
    // …but not by anything that walks the error: logs (inspect), JSON, key enumeration.
    expect(Object.keys(err!)).not.toContain('response');
    expect(JSON.stringify(err)).not.toContain(secret);
    expect(inspect(err)).not.toContain(secret);
    expect(err!.message).not.toContain(secret);
  });
});

/** A client double recording what reached the SDK. */
function fakeClient(reply: { content: Array<{ type: string; name?: string; text?: string }>; usage?: unknown }) {
  const sent: Record<string, unknown>[] = [];
  const surface = () => ({
    create: (p: Record<string, unknown>) => { sent.push(p); return Promise.resolve(reply); },
    stream: (p: Record<string, unknown>) => { sent.push(p); return { finalMessage: () => Promise.resolve(reply) }; },
    countTokens: (p: Record<string, unknown>) => { sent.push(p); return Promise.resolve({ input_tokens: 1 }); },
    batches: { create: (p: Record<string, unknown>) => { sent.push(p); return Promise.resolve({ id: 'batch' }); } },
  });
  const client = { messages: surface(), beta: { messages: surface() } } as unknown as Anthropic;
  return { client, sent };
}

describe('isCutOffReply', () => {
  it('is true only for a reply that stopped at its output budget', () => {
    expect(isCutOffReply({ stop_reason: 'max_tokens' })).toBe(true);
    for (const stop_reason of ['tool_use', 'end_turn', 'stop_sequence', undefined, null]) {
      expect(isCutOffReply({ stop_reason }), String(stop_reason)).toBe(false);
    }
  });
});

describe('withWireRules', () => {
  const textOnly = { content: [{ type: 'text', text: 'no tool' }], usage: { input_tokens: 5, output_tokens: 5 } };
  const called = { content: [{ type: 'tool_use', name: 'extract' }], usage: { input_tokens: 5, output_tokens: 5 } };

  it('shapes what create, stream and countTokens send, on both surfaces', async () => {
    const { client, sent } = fakeClient(called);
    const c = withWireRules(client);
    const p = { model: 'claude-sonnet-5-5', temperature: 0, tool_choice: TOOL };
    await c.messages.create(p as never);
    await c.beta.messages.stream(p as never).finalMessage();
    await c.messages.countTokens(p as never);
    expect(sent).toHaveLength(3);
    for (const s of sent) {
      expect(s).not.toHaveProperty('temperature');
      expect(s['tool_choice']).toEqual({ type: 'auto' });
    }
  });

  it('turns a missing forced call into the named error on stream and on create', async () => {
    const { client } = fakeClient(textOnly);
    const c = withWireRules(client);
    const p = { model: 'claude-opus-5-5', tool_choice: TOOL };
    await expect(c.beta.messages.stream(p as never).finalMessage()).rejects.toBeInstanceOf(ForcedToolNotCalledError);
    await expect(c.messages.create(p as never)).rejects.toBeInstanceOf(ForcedToolNotCalledError);
  });

  it('does not check replies of requests it did not relax', async () => {
    const { client } = fakeClient(textOnly);
    const c = withWireRules(client);
    // Sonnet 4.6 accepts the forced choice, so the SDK enforces it and nothing is added.
    await expect(c.beta.messages.stream({ model: 'claude-sonnet-4-6', tool_choice: TOOL } as never).finalMessage())
      .resolves.toBe(textOnly);
  });

  it('wraps once', async () => {
    const { client, sent } = fakeClient(called);
    const c = withWireRules(withWireRules(client));
    expect(isWireShaped(c)).toBe(true);
    await c.messages.create({ model: 'claude-opus-5-5', tool_choice: TOOL } as never);
    // The instruction is appended exactly once. This holds even without the wrap-once
    // guard, because shaping is idempotent: a second pass sees `auto` and adds nothing
    // (mutation-checked). The guard only saves the extra function layer.
    const system = String(sent[0]!['system']);
    expect(system.split(forcedToolInstruction(TOOL)).length - 1).toBe(1);
  });
});

describe('batches', () => {
  type Batch = { requests: Array<{ custom_id: string; params: Record<string, unknown> }> };
  const req = (custom_id: string, params: Record<string, unknown>) => ({ custom_id, params });

  it('shapes every request of a batch, on both surfaces, and leaves a model without rules as it was', async () => {
    const { client, sent } = fakeClient({ content: [] });
    const c = withWireRules(client) as unknown as { messages: { batches: { create: (p: unknown) => Promise<unknown> } }; beta: { messages: { batches: { create: (p: unknown) => Promise<unknown> } } } };
    const untouched = { model: 'claude-sonnet-4-6', temperature: 0, max_tokens: 10 };
    const batch = { requests: [req('a', { model: 'claude-sonnet-5-5', temperature: 0, thinking: { type: 'disabled' } }), req('b', untouched)] };
    await c.messages.batches.create(batch);
    await c.beta.messages.batches.create(batch);
    expect(sent).toHaveLength(2);
    for (const s of sent as unknown as Batch[]) {
      expect(s.requests[0]!.params).not.toHaveProperty('temperature');
      expect(s.requests[0]!.params['thinking']).toEqual({ type: 'between_tools' });
      expect(s.requests[1]!.params).toBe(untouched);
    }
  });

  it('refuses, before sending, a batch request that forces a tool on a model that rejects it', async () => {
    const { client, sent } = fakeClient({ content: [] });
    const c = withWireRules(client) as unknown as { messages: { batches: { create: (p: unknown) => unknown } } };
    const batch = { requests: [req('ok', { model: 'claude-sonnet-4-6', tool_choice: TOOL }), req('forced', { model: 'claude-opus-5-5', tool_choice: TOOL })] };
    expect(() => c.messages.batches.create(batch)).toThrow(ForcedToolInBatchError);
    expect(() => c.messages.batches.create(batch)).toThrow(/batch request "forced"/);
    expect(sent).toHaveLength(0);
  });

  it('reaches the batches surface of a real SDK client from createLLMClient', () => {
    // The fake above has the shape the wrapper looks for; this shows the SDK's own
    // client has it too. The refusal throws before any network call.
    const c = createLLMClient({ provider: 'anthropic', apiKey: 'test-key' }) as unknown as { messages: { batches: { create: (p: unknown) => unknown } } };
    const batch = { requests: [req('forced', { model: 'claude-opus-5-5', max_tokens: 1, messages: [], tool_choice: TOOL })] };
    expect(() => c.messages.batches.create(batch)).toThrow(ForcedToolInBatchError);
  });
});

describe('every Claude-wire client is built shaped', () => {
  it('createLLMClient returns a shaped client on each Anthropic branch', () => {
    expect(isWireShaped(createLLMClient({ provider: 'anthropic', apiKey: 'test-key' }))).toBe(true);
    expect(isWireShaped(createLLMClient({ provider: 'anthropic', apiBaseURL: 'http://localhost:1' }))).toBe(true);
    expect(isWireShaped(createLLMClient({ provider: 'custom', apiBaseURL: 'http://localhost:1', apiKey: 'k' }))).toBe(true);
  });

  it('the set of places that construct an Anthropic or Vertex client is pinned, and each is wrapped', () => {
    // ⛔ The boundary is only a boundary if nothing builds a client around it. A new
    // `new Anthropic(` anywhere in src/ fails here, and the author has to route it
    // through withWireRules (or justify adding it to this list).
    const root = join(__dirname, '..');
    const sites: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!p.endsWith('.ts') || p.endsWith('.test.ts') || p.endsWith('.d.ts')) continue;
        readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
          if (/^\s*(\/\/|\*)/.test(line)) return;
          if (/new\s+(Anthropic|AnthropicVertex|AnthropicBedrock|_vertexCtor)\s*\(/.test(line)) {
            sites.push(`${relative(root, p)}:${i + 1}:${line.trim()}`);
          }
        });
      }
    };
    walk(root);
    // Positive control: the scan finds the known constructions at all.
    expect(sites.length).toBe(4);
    for (const s of sites) {
      expect(s, s).toMatch(/^core\/llm-client\.ts:\d+:/);
      expect(s, `${s} is not routed through withWireRules`).toMatch(/withWireRules\(new /);
    }
  });
});

// Hosts whose own API has a `/messages` path that is not an LLM endpoint. Closed list, keyed on
// the RESOLVED host: a name that merely looks like one of these is not enough.
const NON_LLM_HOSTS = new Set(['graph.microsoft.com']);

/**
 * The value of `const NAME = '…'` / `…` in `source`, with `${OTHER}` resolved the same way; null
 * when anything is unresolvable. A name declared more than once in the file (any `const`/`let`/
 * `var`, e.g. shadowed in two functions) is unresolvable: which one a line sees is not decided here.
 */
function resolveConst(name: string, source: string, depth = 0): string | null {
  if (depth > 4) return null;
  if ((source.match(new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`, 'g')) ?? []).length !== 1) return null;
  const def = new RegExp(`\\bconst ${name}\\s*=\\s*(['"\`])([^'"\`]*)\\1\\s*;`).exec(source);
  if (def === null) return null;
  let unresolved = false;
  const value = def[2]!.replace(/\$\{(\w+)\}/g, (_m, inner: string) => resolveConst(inner, source, depth + 1) ?? (unresolved = true, ''));
  return unresolved ? null : value;
}

/**
 * The host of the Messages-looking URL that ends at `at` on `line`, resolved through the file's
 * constants, or null when it cannot be resolved. Only the literal's head counts: `${BASE}…` or
 * `https://host…`.
 */
function messagesUrlHost(line: string, at: number, source: string): string | null {
  const open = Math.max(line.lastIndexOf('`', at), line.lastIndexOf("'", at), line.lastIndexOf('"', at));
  if (open < 0) return null;
  const head = line.slice(open + 1, at);
  let base: string | null;
  const ref = /^\$\{(\w+)\}/.exec(head);
  if (ref !== null) base = resolveConst(ref[1]!, source);
  else if (/^https?:\/\//.test(head)) {
    const origin = /^https?:\/\/[^/]*/.exec(head)![0];
    let unresolved = false;
    base = origin.replace(/\$\{(\w+)\}/g, (_m, inner: string) => resolveConst(inner, source) ?? (unresolved = true, ''));
    if (unresolved) base = null;
  } else base = null;
  if (base === null) return null;
  try { return new URL(base).hostname; } catch { return null; }
}

/** True only when EVERY `/messages` on the line resolves onto NON_LLM_HOSTS. */
const skipsAsNonLlmHost = (line: string, source: string): boolean => {
  const ats = [...line.matchAll(/\/messages/g)].map(m => m.index);
  return ats.length > 0 && ats.every((at) => {
    const host = messagesUrlHost(line, at, source);
    return host !== null && NON_LLM_HOSTS.has(host);
  });
};

describe('a /messages URL on a non-LLM host is skipped only when its host resolves onto the list', () => {
  const graph = "const H = 'graph.microsoft.com';\nconst ME = `https://${H}/v1.0/me`;\n";
  it('skips a Graph URL built on a constant', () => {
    expect(skipsAsNonLlmHost('get(`${ME}/messages/${id}?${q}`, \'fetch\')', graph)).toBe(true);
  });
  it('still catches an Anthropic URL built on a constant', () => {
    expect(skipsAsNonLlmHost('fetch(`${baseUrl}/messages`, {', "const baseUrl = 'https://api.anthropic.com/v1';\n")).toBe(false);
  });
  it('still catches a URL whose constant cannot be resolved', () => {
    expect(skipsAsNonLlmHost('fetch(`${ME}/messages`, {', '')).toBe(false);
    expect(skipsAsNonLlmHost('fetch(`${cfg.base}/messages`, {', graph)).toBe(false);
    // Partly unresolvable: dropping the unknown piece would land on a listed host, so it must not be dropped.
    expect(skipsAsNonLlmHost('fetch(`${ME}/messages`, {', 'const ME = `https://${SUB}graph.microsoft.com/v1.0/me`;\n')).toBe(false);
    expect(skipsAsNonLlmHost('fetch(`https://${SUB}graph.microsoft.com/v1/messages`, {', '')).toBe(false);
  });
  it('still catches a name declared twice, whichever declaration comes first', () => {
    const twice = "const B = 'https://graph.microsoft.com/v1.0';\nfunction f() {\n  const B = 'https://api.anthropic.com/v1';\n}\n";
    expect(skipsAsNonLlmHost('fetch(`${B}/messages`, {', twice)).toBe(false);
  });
  it('still catches a line with a Graph URL and a second, non-Graph one', () => {
    expect(skipsAsNonLlmHost('a(`${ME}/messages`); b(`${baseUrl}/messages`, {', `${graph}const baseUrl = 'https://api.anthropic.com/v1';\n`)).toBe(false);
  });
  it('still catches a host that only starts like a listed one', () => {
    expect(skipsAsNonLlmHost('fetch(`https://graph.microsoft.com.example.net/v1/messages`, {', '')).toBe(false);
  });
});

describe('every raw call to the Messages API is shaped', () => {
  it('the set of places that build a Messages URL outside the SDK is pinned, and each sends a shaped body', () => {
    // ⛔ A probe that posts to the Messages API with fetch is outside the client boundary,
    // whatever wrapper it fetches through. The scan keys on the URL, not on the call: any
    // string in code that ends in `/messages`, or continues with a query or a sub-path (an
    // Anthropic or custom Anthropic-wire endpoint), must have a body built with
    // shapeRequestForModel within the next lines. Only a line that builds a URL counts
    // (`://` or a template `${…}`), so the SDK's own module paths do not; a line quoting a
    // route path of lynox's own API (`/api/…`) is skipped whole. A URL assembled further
    // from its body, or ending in a variable, is not seen. A URL whose host resolves onto
    // NON_LLM_HOSTS (Microsoft Graph's mail `/messages`) is not an LLM call and is skipped.
    const root = join(__dirname, '..');
    const sites: Array<{ at: string; body: string }> = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!p.endsWith('.ts') || p.endsWith('.test.ts') || p.endsWith('.d.ts')) continue;
        const source = readFileSync(p, 'utf8');
        const lines = source.split('\n');
        lines.forEach((line, i) => {
          if (/^\s*(\/\/|\*)/.test(line)) return;
          if (!/\/messages(['"`?]|\/)/.test(line) || !/:\/\/|\$\{/.test(line) || /['"`]\/api\//.test(line)) return;
          if (skipsAsNonLlmHost(line, source)) return;
          const body = lines.slice(i, i + 12).find(l => /\bbody:/.test(l)) ?? '';
          sites.push({ at: `${relative(root, p)}:${String(i + 1)}`, body: body.trim() });
        });
      }
    };
    walk(root);
    // Positive control: the scan finds the known probes at all.
    expect(sites.map(s => s.at.replace(/:\d+$/, '')).sort()).toEqual(['cli/docker-installer.ts', 'server/http-api.ts', 'server/http-api.ts']);
    for (const s of sites) expect(s.body, `${s.at} sends a body that is not shaped`).toMatch(/body: JSON\.stringify\(shapeRequestForModel\(/);
  });
});

describe('every call site that forces a tool handles the lost call', () => {
  it('the set of forcing sites is pinned, and each file settles and reports as often as it forces', () => {
    // ⛔ Where a model rejects a forced choice, the boundary relaxes it and a reply without
    // the call arrives as ForcedToolNotCalledError. A site that awaits it bare drops the
    // reply's cost in its catch and says nothing. So every file that forces a tool must
    // route the reply through settleForcedTool (books once) and reportForcedToolMiss (says
    // so) — one of each per forcing site. A new forcing site fails here until it does.
    const root = join(__dirname, '..');
    const perFile = new Map<string, { forces: number; settles: number; reports: number; cutOffs: number; unchecked: number }>();
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!p.endsWith('.ts') || p.endsWith('.test.ts') || p.endsWith('.d.ts')) continue;
        if (p.endsWith('llm-wire-rules.ts') || p.endsWith('openai-adapter.ts')) continue;
        const src = readFileSync(p, 'utf8');
        // Field order and quote style inside the literal do not matter.
        const forces = (src.match(/tool_choice:\s*\{[^}]*\btype:\s*['"`](tool|any)['"`]/g) ?? []).length;
        if (forces === 0) continue;
        perFile.set(relative(root, p), {
          forces,
          settles: (src.match(/settleForcedTool\(/g) ?? []).length,
          reports: (src.match(/reportForcedToolMiss\(/g) ?? []).length,
          // A reply cut off at `max_tokens` can carry the call with a partial input, which
          // the miss check counts as a call. One cut-off report per forcing site says so.
          cutOffs: (src.match(/reportForcedToolCutOff\(/g) ?? []).length,
          // The boundary checks the reply on `create` and on a stream's `finalMessage()` only.
          // These readers get the reply past that check, so a forcing file must not use them.
          unchecked: (src.match(/\.finalText\(|\.done\(\)|['"]finalMessage['"]|stream:\s*true/g) ?? []).length,
        });
      }
    };
    walk(root);
    expect([...perFile.keys()].sort()).toEqual([
      'core/agent.ts',
      'core/dag-planner.ts',
      'core/entity-extractor-v2.ts',
      'core/llm-helper.ts',
      'core/process-capture.ts',
      'integrations/search/search-reranker.ts',
    ]);
    for (const [file, n] of perFile) {
      expect(n.settles, `${file}: settleForcedTool per forcing site`).toBe(n.forces);
      expect(n.reports, `${file}: reportForcedToolMiss per forcing site`).toBe(n.forces);
      expect(n.cutOffs, `${file}: reportForcedToolCutOff per forcing site`).toBe(n.forces);
      expect(n.unchecked, `${file}: reads a forced reply past the check (finalText / done / 'finalMessage' event / stream:true)`).toBe(0);
    }
  });
});
