import { OWNER_PRINCIPAL } from '../core/request-principal.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IAgent, LynoxUserConfig, ToolEntry } from '../types/index.js';

/**
 * A workflow step is handed its parent's context (`parentToolContext`) and judged by the same gate
 * as any agent: the provider-side web search runs outside `network_policy`, so it is offered only
 * where that policy leaves search open and the context carries the instance's policy. Driven
 * through the real runner with REAL step agents; only the LLM is scripted. Every step here has no
 * `web_research`, the case where the gate alone decides.
 */

const sent = vi.hoisted(() => ({ requests: [] as Array<{ tools?: Array<{ type?: string }>; system?: unknown }> }));

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = {
      messages: {
        stream: vi.fn((params: { tools?: Array<{ type?: string }>; system?: unknown }) => {
          sent.requests.push(params);
          return {};
        }),
      },
    };
  }
  class APIError extends Error {
    status: number;
    error: unknown;
    headers: unknown;
    constructor(status: number, error: unknown, message: string | undefined, headers: unknown) {
      super(message ?? String(error));
      this.status = status;
      this.error = error;
      this.headers = headers;
      this.name = 'APIError';
    }
  }
  return { default: MockAnthropic, APIError };
});

const mockProcess = vi.fn();

vi.mock('../core/stream.js', () => ({
  StreamProcessor: vi.fn().mockImplementation(function (this: { process: typeof mockProcess }) {
    this.process = mockProcess;
  }),
}));

import { runManifest, buildRunCtx } from './runner.js';
import { Agent } from '../core/agent.js';
import { applyNetworkPolicy, createToolContext } from '../core/tool-context.js';
import type { ToolContext } from '../core/tool-context.js';
import { STEP_NO_WEB_STRUCTURED_PROMPT_BLOCK, SUBAGENT_NO_WEB_PROMPT_BLOCK } from '../core/prompts.js';

const config: LynoxUserConfig = { api_key: 'test-key', durable_memory_enabled: false };

const OWNER_HISTORY = new Proxy({} as Record<string, unknown>, {
  get: () => () => undefined,
}) as unknown as NonNullable<ToolContext['runHistory']>;

function parentWith(ctx: ToolContext): IAgent {
  ctx.runHistory = OWNER_HISTORY;
  return {
    toolContext: ctx,
    principal: OWNER_PRINCIPAL,
    getAvailableTools: () => [],
    currentThreadId: 't-1',
    userTimezone: 'UTC',
    noteUntrustedData: vi.fn(),
  } as unknown as IAgent;
}

/** The context an agent builds for itself when handed none: it does not carry the policy. */
function unreadContext(): ToolContext {
  return new Agent({ name: 'library', model: 'claude-sonnet-4-6', apiKey: 'test-key' }).toolContext;
}

function engineContext(policy?: 'deny-all' | 'allow-all' | 'allow-list'): ToolContext {
  const ctx = createToolContext(config);
  if (policy) applyNetworkPolicy(ctx, policy, policy === 'allow-list' ? ['api.example.com'] : []);
  return ctx;
}

/** Whether the step was told the network settings keep it off the web (`withNoWebSentence`). */
const sentSystem = (text: string): boolean => sent.requests.some((r) => JSON.stringify(r.system ?? '').includes(JSON.stringify(text).slice(1, -1)));
/** Both sentences a step gets: the one a spawned child gets, and the one for structured output. */
const toldNoWeb = (): boolean => sentSystem(SUBAGENT_NO_WEB_PROMPT_BLOCK) && sentSystem(STEP_NO_WEB_STRUCTURED_PROMPT_BLOCK);
const toldAnyNoWeb = (): boolean => sentSystem(SUBAGENT_NO_WEB_PROMPT_BLOCK) || sentSystem(STEP_NO_WEB_STRUCTURED_PROMPT_BLOCK);

/** Every step result of a run, as one string. */
const outputsOf = (state: { outputs: Map<string, { result: string }> }): string => [...state.outputs.values()].map((o) => o.result).join('\n');

const offered = (): boolean => sent.requests.some((r) => (r.tools ?? []).some((t) => t.type === 'web_search_20250305'));

describe('the provider-side web search in a workflow step', () => {
  let dir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    sent.requests = [];
    mockProcess.mockReset();
    mockProcess.mockResolvedValue({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } });
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'step-search-')));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A nested pipeline's inline step (runtime-adapter, inline). */
  const runInline = async (ctx: ToolContext): Promise<string> => {
    const parent = parentWith(ctx);
    return outputsOf(await runManifest({
      manifest_version: '1.0', name: 'search-probe', triggered_by: 'test', context: {},
      agents: [{ id: 'outer', agent: 'outer', runtime: 'pipeline', pipeline: [{ id: 'look', task: 'Look it up.' }] }],
      gate_points: [], on_failure: 'stop',
    }, config, { ...buildRunCtx({ autonomy: undefined, parentTools: [], parentToolContext: parent.toolContext }), source: { kind: 'adhoc' as const } }));
  };

  /** An inline step that names `tools` from the parent's set, under `disabled` tool toggles. */
  const runInlineWith = async (ctx: ToolContext, names: string[], disabled: string[] = []): Promise<void> => {
    const parent = parentWith(ctx);
    const parentTools = names.map((name) => ({
      definition: { name, description: name, input_schema: { type: 'object' as const, properties: {} } },
      handler: async () => 'ok',
    })) as unknown as ToolEntry[];
    await runManifest({
      manifest_version: '1.0', name: 'search-probe-tools', triggered_by: 'test', context: {},
      agents: [{ id: 'outer', agent: 'outer', runtime: 'pipeline', pipeline: [{ id: 'look', task: 'Look it up.', tools: names }] }],
      gate_points: [], on_failure: 'stop',
    }, { ...config, disabled_tools: disabled }, { ...buildRunCtx({ autonomy: undefined, parentTools, parentToolContext: parent.toolContext }), source: { kind: 'adhoc' as const } });
  };

  /** A named agent's step (runtime-adapter, agent). */
  const runNamed = async (ctx: ToolContext): Promise<string> => {
    const agentsDir = join(dir, 'agents');
    mkdirSync(join(agentsDir, 'looker'), { recursive: true });
    writeFileSync(join(agentsDir, 'looker', 'index.js'), `export default { name: 'looker', version: '1.0.0', defaultTier: 'balanced', systemPrompt: 'You look.', tools: [] };\n`);
    const parent = parentWith(ctx);
    return outputsOf(await runManifest({
      manifest_version: '1.0', name: 'named-search-probe', triggered_by: 'test', context: {},
      agents: [{ id: 'l', agent: 'looker', task: 'Look it up.' }],
      gate_points: [], on_failure: 'stop',
    }, config, { ...buildRunCtx({ source: { kind: 'adhoc' as const }, autonomy: undefined, parentToolContext: parent.toolContext }), agentsDir }));
  };

  it.each([['an inline step', runInline], ['a named agent\'s step', runNamed]] as const)('%s under a parent with no policy of its own: withheld', async (_name, run) => {
    await run(unreadContext());
    expect(sent.requests.length).toBeGreaterThan(0);
    expect(offered()).toBe(false);
  });

  it.each([['an inline step', runInline], ['a named agent\'s step', runNamed]] as const)('%s under deny-all: withheld', async (_name, run) => {
    await run(engineContext('deny-all'));
    expect(sent.requests.length).toBeGreaterThan(0);
    expect(offered()).toBe(false);
  });

  it.each([['an inline step', runInline], ['a named agent\'s step', runNamed]] as const)('%s under the engine\'s allow-all: offered (control)', async (_name, run) => {
    await run(engineContext('allow-all'));
    expect(offered()).toBe(true);
  });

  // A step with no web tool under a policy that keeps it off the web is told so, as a spawned
  // child is: the same sentence, from the same helper, and one more for structured output.
  it.each([['an inline step', runInline], ['a named agent\'s step', runNamed]] as const)('%s with no web tool under deny-all: told it cannot reach the web', async (_name, run) => {
    await run(engineContext('deny-all'));
    expect(sent.requests.length).toBeGreaterThan(0);
    expect(toldNoWeb()).toBe(true);
  });

  it.each([['an inline step', runInline], ['a named agent\'s step', runNamed]] as const)('%s with no web tool under an allow-list: told it cannot reach the web', async (_name, run) => {
    await run(engineContext('allow-list'));
    expect(toldNoWeb()).toBe(true);
  });

  // The sentence is read from the tools the step is left with, after the tool toggles: a web tool
  // that is turned off does not count, one that stays does, and so does bash under deny-all.
  it('an inline step under an allow-list: not told while it keeps http_request, told once it is turned off', async () => {
    await runInlineWith(engineContext('allow-list'), ['http_request']);
    expect(sent.requests.length).toBeGreaterThan(0);
    expect(toldAnyNoWeb()).toBe(false);
    sent.requests = [];
    await runInlineWith(engineContext('allow-list'), ['http_request'], ['http_request']);
    expect(sent.requests.length).toBeGreaterThan(0);
    expect(toldNoWeb()).toBe(true);
  });

  // A named agent's own tools run their own code, which the network policy does not reach: such a
  // step may open pages through one of them, so it is not told it cannot.
  it('a named agent\'s step that brings a tool of its own, under deny-all: not told', async () => {
    const agentsDir = join(dir, 'agents');
    mkdirSync(join(agentsDir, 'fetcher'), { recursive: true });
    writeFileSync(join(agentsDir, 'fetcher', 'index.js'), `export default { name: 'fetcher', version: '1.0.0', defaultTier: 'balanced', systemPrompt: 'You look.', tools: [{ name: 'lookup_company', description: 'Look a company up.', input_schema: { type: 'object', properties: {} }, execute: async () => 'ok' }] };\n`);
    const parent = parentWith(engineContext('deny-all'));
    await runManifest({
      manifest_version: '1.0', name: 'named-tool-probe', triggered_by: 'test', context: {},
      agents: [{ id: 'f', agent: 'fetcher', task: 'Look it up.' }],
      gate_points: [], on_failure: 'stop',
    }, config, { ...buildRunCtx({ source: { kind: 'adhoc' as const }, autonomy: undefined, parentToolContext: parent.toolContext }), agentsDir });
    expect(sent.requests.length).toBeGreaterThan(0);
    expect(toldAnyNoWeb()).toBe(false);
  });

  it('an inline step under deny-all that keeps bash: not told, as bash runs past the policy', async () => {
    await runInlineWith(engineContext('deny-all'), ['bash']);
    expect(sent.requests.length).toBeGreaterThan(0);
    expect(toldAnyNoWeb()).toBe(false);
  });

  it.each([['an inline step', runInline], ['a named agent\'s step', runNamed]] as const)('%s under allow-all, or a context without the policy: not told (control)', async (_name, run) => {
    await run(engineContext('allow-all'));
    expect(sent.requests.length).toBeGreaterThan(0);
    expect(toldAnyNoWeb()).toBe(false);
    sent.requests = [];
    await run(unreadContext());
    expect(sent.requests.length).toBeGreaterThan(0);
    expect(toldAnyNoWeb()).toBe(false);
  });

  // A step kept off the web hands on no link to an address it was not given, and the result the
  // run stores is that text, so chat and run report show the same (`withoutUnopenedLinks`).
  describe('a link to an address the step never opened', () => {
    const LINK = 'Gold: [Kitco](https://www.kitco.com/gold), see https://kitco.com/chart';
    beforeEach(() => {
      mockProcess.mockResolvedValue({ content: [{ type: 'text', text: LINK }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } });
    });

    it.each([['an inline step', runInline], ['a named agent\'s step', runNamed]] as const)('%s under deny-all: stored as plain text', async (_name, run) => {
      const out = await run(engineContext('deny-all'));
      expect(out).toContain('Gold: Kitco (kitco.com/gold, not checked), see kitco.com/chart (not checked)');
      expect(out).not.toContain('https://');
    });

    it.each([['an inline step', runInline], ['a named agent\'s step', runNamed]] as const)('%s under allow-all: left as it is (control)', async (_name, run) => {
      expect(await run(engineContext('allow-all'))).toContain(LINK);
    });

    it('a named agent\'s step that brings a tool of its own: left as it is, as it is not told either', async () => {
      const agentsDir = join(dir, 'agents');
      mkdirSync(join(agentsDir, 'fetcher'), { recursive: true });
      writeFileSync(join(agentsDir, 'fetcher', 'index.js'), `export default { name: 'fetcher', version: '1.0.0', defaultTier: 'balanced', systemPrompt: 'You look.', tools: [{ name: 'lookup_company', description: 'Look a company up.', input_schema: { type: 'object', properties: {} }, execute: async () => 'ok' }] };\n`);
      const parent = parentWith(engineContext('deny-all'));
      const out = outputsOf(await runManifest({
        manifest_version: '1.0', name: 'named-tool-links', triggered_by: 'test', context: {},
        agents: [{ id: 'f', agent: 'fetcher', task: 'Look it up.' }],
        gate_points: [], on_failure: 'stop',
      }, config, { ...buildRunCtx({ source: { kind: 'adhoc' as const }, autonomy: undefined, parentToolContext: parent.toolContext }), agentsDir }));
      expect(out).toContain(LINK);
    });

    it('an inline step keeps a link to an address its task gave it', async () => {
      const parent = parentWith(engineContext('deny-all'));
      const out = outputsOf(await runManifest({
        manifest_version: '1.0', name: 'given-link', triggered_by: 'test', context: {},
        agents: [{ id: 'outer', agent: 'outer', runtime: 'pipeline', pipeline: [{ id: 'look', task: 'Summarise https://www.kitco.com/gold' }] }],
        gate_points: [], on_failure: 'stop',
      }, config, { ...buildRunCtx({ autonomy: undefined, parentTools: [], parentToolContext: parent.toolContext }), source: { kind: 'adhoc' as const } }));
      expect(out).toContain('[Kitco](https://www.kitco.com/gold)');
      expect(out).toContain('kitco.com/chart (not checked)');
    });
  });
});
