import { OWNER_PRINCIPAL } from '../core/request-principal.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IAgent, LynoxUserConfig } from '../types/index.js';

/**
 * A workflow step is handed its parent's context (`parentToolContext`) and judged by the same gate
 * as any agent: the provider-side web search runs outside `network_policy`, so it is offered only
 * where that policy leaves search open and the context carries the instance's policy. Driven
 * through the real runner with REAL step agents; only the LLM is scripted. Every step here has no
 * `web_research`, the case where the gate alone decides.
 */

const sent = vi.hoisted(() => ({ requests: [] as Array<{ tools?: Array<{ type?: string }> }> }));

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = {
      messages: {
        stream: vi.fn((params: { tools?: Array<{ type?: string }> }) => {
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

function engineContext(policy?: 'deny-all' | 'allow-all'): ToolContext {
  const ctx = createToolContext(config);
  if (policy) applyNetworkPolicy(ctx, policy, []);
  return ctx;
}

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
  const runInline = async (ctx: ToolContext): Promise<void> => {
    const parent = parentWith(ctx);
    await runManifest({
      manifest_version: '1.0', name: 'search-probe', triggered_by: 'test', context: {},
      agents: [{ id: 'outer', agent: 'outer', runtime: 'pipeline', pipeline: [{ id: 'look', task: 'Look it up.' }] }],
      gate_points: [], on_failure: 'stop',
    }, config, { ...buildRunCtx({ autonomy: undefined, parentTools: [], parentToolContext: parent.toolContext }), source: { kind: 'adhoc' as const } });
  };

  /** A named agent's step (runtime-adapter, agent). */
  const runNamed = async (ctx: ToolContext): Promise<void> => {
    const agentsDir = join(dir, 'agents');
    mkdirSync(join(agentsDir, 'looker'), { recursive: true });
    writeFileSync(join(agentsDir, 'looker', 'index.js'), `export default { name: 'looker', version: '1.0.0', defaultTier: 'balanced', systemPrompt: 'You look.', tools: [] };\n`);
    const parent = parentWith(ctx);
    await runManifest({
      manifest_version: '1.0', name: 'named-search-probe', triggered_by: 'test', context: {},
      agents: [{ id: 'l', agent: 'looker', task: 'Look it up.' }],
      gate_points: [], on_failure: 'stop',
    }, config, { ...buildRunCtx({ source: { kind: 'adhoc' as const }, autonomy: undefined, parentToolContext: parent.toolContext }), agentsDir });
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
});
