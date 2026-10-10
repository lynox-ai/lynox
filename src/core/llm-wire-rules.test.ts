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
  });
  const client = { messages: surface(), beta: { messages: surface() } } as unknown as Anthropic;
  return { client, sent };
}

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

describe('every call site that forces a tool handles the lost call', () => {
  it('the set of forcing sites is pinned, and each file settles and reports as often as it forces', () => {
    // ⛔ Where a model rejects a forced choice, the boundary relaxes it and a reply without
    // the call arrives as ForcedToolNotCalledError. A site that awaits it bare drops the
    // reply's cost in its catch and says nothing. So every file that forces a tool must
    // route the reply through settleForcedTool (books once) and reportForcedToolMiss (says
    // so) — one of each per forcing site. A new forcing site fails here until it does.
    const root = join(__dirname, '..');
    const perFile = new Map<string, { forces: number; settles: number; reports: number }>();
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!p.endsWith('.ts') || p.endsWith('.test.ts') || p.endsWith('.d.ts')) continue;
        if (p.endsWith('llm-wire-rules.ts') || p.endsWith('openai-adapter.ts')) continue;
        const src = readFileSync(p, 'utf8');
        const forces = (src.match(/tool_choice:\s*\{\s*type:\s*'(tool|any)'/g) ?? []).length;
        if (forces === 0) continue;
        perFile.set(relative(root, p), {
          forces,
          settles: (src.match(/settleForcedTool\(/g) ?? []).length,
          reports: (src.match(/reportForcedToolMiss\(/g) ?? []).length,
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
    }
  });
});
