/**
 * A contained chat is held to its list of calls at dispatch (`agent.ts › _executeOneInner`),
 * before any prompt, and is offered no provider-side tool (`_callAPI`). On a real `Agent`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolEntry } from '../types/index.js';

// A busy machine takes longer than the default 10 s to import and open these stores.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = { messages: { stream: vi.fn() } };
  }
  class APIError extends Error {}
  return { default: MockAnthropic, APIError };
});

const mockProcess = vi.fn();
vi.mock('./stream.js', () => ({
  StreamProcessor: vi.fn().mockImplementation(function (this: { process: typeof mockProcess }) {
    this.process = mockProcess;
  }),
}));

// Every call asks for approval, so a call that reaches the prompt is seen asking.
vi.mock('../tools/permission-guard.js', async (importOriginal) => ({
  // The real module, so every export a test does not replace stays what it is.
  ...(await importOriginal<typeof import('../tools/permission-guard.js')>()),
  isDangerous: vi.fn().mockReturnValue(null),
  isDangerousDetailed: vi.fn().mockReturnValue({ warning: 'approve this call', prompt: { [Symbol.for('lynox.promptText')]: true, segments: [{ kind: 'frame', text: 'approve this call' }] } }),
}));

vi.mock('./observability.js', () => ({
  channels: {
    toolStart: { publish: vi.fn() },
    toolEnd: { publish: vi.fn() },
    contentTruncation: { hasSubscribers: true, publish: vi.fn() },
    cacheHealth: { publish: vi.fn() },
    securityFlagged: { hasSubscribers: true, publish: vi.fn() },
    securityInjection: { hasSubscribers: false, publish: vi.fn() },
    secretAccess: { publish: vi.fn() },
  },
  measureTool: vi.fn().mockReturnValue({ end: () => 0 }),
}));

import { Agent } from './agent.js';
import { EngineDb } from './engine-db.js';
import { Containment, CONTAINED_WRITE_REFUSAL } from './containment.js';
import { createToolContext } from './tool-context.js';

const REFUSAL = 'Not run: this chat has read data through a store connection, or this engine cannot read whether it has, and what it holds stays in this chat. '
  + 'Work that does not need the store\'s data belongs in a new chat.';
const OTHER_SERVICE = 'Not run: this chat has read data through a store connection, or this engine cannot read whether it has, so it reaches no other service. '
  + 'Tell the user in one sentence that this chat only reads now, and that they can open a chat where this works with "Plan in a new chat" (you cannot open it for them).';

function tool(name: string): ToolEntry {
  return {
    definition: { name, description: `tool ${name}`, input_schema: { type: 'object' as const, properties: {}, additionalProperties: true } },
    handler: vi.fn().mockResolvedValue(`ran ${name}`),
  } as unknown as ToolEntry;
}

let dir: string;
let engineDb: EngineDb;
let containment: Containment;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lynox-contained-dispatch-'));
  engineDb = new EngineDb(join(dir, 'engine.db'), '');
  containment = new Containment(engineDb.getDb(), null);
  containment.contain({ kind: 'thread', id: 'chat-shop' }, { kind: 'api', connectionId: 'shop-a' });
});
afterEach(() => {
  engineDb.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function agentWith(tools: ToolEntry[], thread: { current?: string; origin?: string }, store: Containment | null = containment): { agent: Agent; prompt: ReturnType<typeof vi.fn> } {
  const toolContext = createToolContext({});
  toolContext.containment = store;
  const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', provider: 'anthropic', tools, toolContext });
  agent.currentThreadId = thread.current;
  agent.originThreadId = thread.origin;
  const prompt = vi.fn().mockResolvedValue('Allow');
  agent.promptUser = prompt;
  return { agent, prompt };
}

interface ToolResult { content: unknown; is_error?: boolean }
const dispatch = (agent: Agent, name: string, input: unknown = {}): Promise<ToolResult> =>
  (agent as unknown as { _executeOneInner(tc: unknown): Promise<ToolResult> })._executeOneInner({ type: 'tool_use', id: `tu-${name}`, name, input });

describe('dispatch in a contained chat', () => {
  it('refuses a call outside the list before the prompt and the handler', async () => {
    const send = tool('mail_send');
    const { agent, prompt } = agentWith([send], { current: 'chat-shop' });
    const r = await dispatch(agent, 'mail_send', { to: 'x@example.org' });
    expect(r.is_error).toBe(true);
    expect(String(r.content)).toContain(REFUSAL);
    expect(prompt).not.toHaveBeenCalled();
    expect(send.handler).not.toHaveBeenCalled();
  });

  it('runs a call on the list (through its prompt)', async () => {
    const recall = tool('memory_recall');
    const { agent, prompt } = agentWith([recall], { current: 'chat-shop' });
    const r = await dispatch(agent, 'memory_recall', { query: 'q' });
    expect(r.is_error).not.toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(recall.handler).toHaveBeenCalledTimes(1);
  });

  it('refuses http_request to a host that is not the store\'s', async () => {
    const http = tool('http_request');
    const { agent } = agentWith([http], { current: 'chat-shop' });
    expect(String((await dispatch(agent, 'http_request', { url: 'https://api.example.com/x' })).content)).toContain(OTHER_SERVICE);
    expect(http.handler).not.toHaveBeenCalled();
  });

  it('refuses a write to the store itself before the prompt and the handler, with the write\'s own answer', async () => {
    const http = tool('http_request');
    const { agent, prompt } = agentWith([http], { current: 'chat-shop' });
    const r = await dispatch(agent, 'http_request', { url: 'https://acme.myshopify.com/admin/api/2025-10/webhooks.json', method: 'POST', body: '{"webhook":{"address":"https://x.example"}}' });
    expect(r.is_error).toBe(true);
    expect(String(r.content)).toContain(CONTAINED_WRITE_REFUSAL);
    expect(prompt).not.toHaveBeenCalled();
    expect(http.handler).not.toHaveBeenCalled();
  });

  it('streams each refusal with its reason, for the chat\'s view to key on', async () => {
    const http = tool('http_request');
    const plan = tool('bulk_plan');
    const send = tool('mail_send');
    const { agent } = agentWith([http, plan, send], { current: 'chat-shop' });
    const events: Array<Record<string, unknown>> = [];
    agent.onStream = (e) => { events.push(e as unknown as Record<string, unknown>); };
    await dispatch(agent, 'http_request', { url: 'https://acme.myshopify.com/admin/api/2025-10/products/1.json', method: 'PUT', body: '{}' });
    await dispatch(agent, 'bulk_plan', { target_system: 'http', target_host: 'acme.myshopify.com' });
    await dispatch(agent, 'mail_send', {});
    expect(events.filter((e) => e['type'] === 'tool_result').map((e) => [e['name'], e['contained'], e['isError'], e['toolUseId']])).toEqual([
      ['http_request', 'contained_write', true, 'tu-http_request'],
      ['bulk_plan', 'contained_plan', true, 'tu-bulk_plan'],
      ['mail_send', 'contained_call', true, 'tu-mail_send'],
    ]);
    expect(plan.handler).not.toHaveBeenCalled();
  });

  it('streams no reason for a call in another chat (control)', async () => {
    const plan = tool('bulk_plan');
    const { agent } = agentWith([plan], { current: 'chat-free' });
    const events: Array<Record<string, unknown>> = [];
    agent.onStream = (e) => { events.push(e as unknown as Record<string, unknown>); };
    await dispatch(agent, 'bulk_plan', {});
    expect(plan.handler).toHaveBeenCalledTimes(1);
    expect(events.some((e) => 'contained' in e)).toBe(false);
  });

  it('refuses a keyword lookup at another service after the store was read, and runs it in a new chat', async () => {
    const http = tool('http_request');
    const lookup = { url: 'https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live', method: 'POST', body: '[{"keywords":["wasserfilter"]}]' };
    const { agent, prompt } = agentWith([http], { current: 'chat-shop' });
    const events: Array<Record<string, unknown>> = [];
    agent.onStream = (e) => { events.push(e as unknown as Record<string, unknown>); };
    const r = await dispatch(agent, 'http_request', lookup);
    expect(r.is_error).toBe(true);
    expect(String(r.content)).toContain(OTHER_SERVICE);
    expect(events.filter((e) => e['type'] === 'tool_result').map((e) => e['contained'])).toEqual(['contained_call']);
    expect(prompt).not.toHaveBeenCalled();
    expect(http.handler).not.toHaveBeenCalled();
    const fresh = agentWith([http], { current: 'chat-new' });
    expect((await dispatch(fresh.agent, 'http_request', lookup)).is_error).not.toBe(true);
    expect(fresh.prompt).toHaveBeenCalledTimes(1);
    expect(http.handler).toHaveBeenCalledTimes(1);
  });

  it('runs a read of the store (through its prompt), and the same write in another chat (controls)', async () => {
    const http = tool('http_request');
    const { agent } = agentWith([http], { current: 'chat-shop' });
    expect((await dispatch(agent, 'http_request', { url: 'https://acme.myshopify.com/admin/api/2025-10/shop.json' })).is_error).not.toBe(true);
    const free = agentWith([http], { current: 'chat-free' });
    expect((await dispatch(free.agent, 'http_request', { url: 'https://acme.myshopify.com/admin/api/2025-10/webhooks.json', method: 'POST', body: '{}' })).is_error).not.toBe(true);
    expect(http.handler).toHaveBeenCalledTimes(2);
  });

  it('holds a spawned child, which only knows the chat it runs for', async () => {
    const send = tool('mail_send');
    const { agent, prompt } = agentWith([send], { origin: 'chat-shop' });
    expect(String((await dispatch(agent, 'mail_send')).content)).toContain(REFUSAL);
    expect(prompt).not.toHaveBeenCalled();
    expect(send.handler).not.toHaveBeenCalled();
  });

  it('refuses a tool registered after the agent was built', async () => {
    const { agent } = agentWith([], { current: 'chat-shop' });
    const late = tool('late_tool');
    agent.tools.push(late);
    expect(String((await dispatch(agent, 'late_tool')).content)).toContain(REFUSAL);
    expect(late.handler).not.toHaveBeenCalled();
  });

  it('leaves another chat as it was (control)', async () => {
    const send = tool('mail_send');
    const { agent, prompt } = agentWith([send], { current: 'chat-free' });
    const r = await dispatch(agent, 'mail_send');
    expect(r.is_error).not.toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(send.handler).toHaveBeenCalledTimes(1);
  });

  it('without a store: every chat is held on a provisioned instance, none elsewhere', async () => {
    const send = tool('mail_send');
    const free = agentWith([send], { current: 'chat-free' }, null);
    expect((await dispatch(free.agent, 'mail_send')).is_error).not.toBe(true);
    expect(send.handler).toHaveBeenCalledTimes(1);
    vi.stubEnv('LYNOX_BILLING_TIER', 'managed');
    const held = agentWith([send], { current: 'chat-free' }, null);
    expect(String((await dispatch(held.agent, 'mail_send')).content)).toContain(REFUSAL);
    expect(held.prompt).not.toHaveBeenCalled();
    expect(send.handler).toHaveBeenCalledTimes(1);
  });
});

describe('provider-side tools', () => {
  interface StreamTool { name?: string; type?: string }
  const toolsSent = async (thread: string): Promise<StreamTool[]> => {
    mockProcess.mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
    const { agent } = agentWith([tool('memory_recall')], { current: thread });
    await agent.send('hi');
    const stream = (agent as unknown as { client: { beta: { messages: { stream: { mock: { calls: unknown[][] } } } } } }).client.beta.messages.stream;
    return (stream.mock.calls.at(-1)![0] as { tools: StreamTool[] }).tools;
  };

  it('none in a contained chat; web_search in another (control)', async () => {
    expect((await toolsSent('chat-free')).map((t) => t.type)).toContain('web_search_20250305');
    const contained = await toolsSent('chat-shop');
    expect(contained.map((t) => t.type)).not.toContain('web_search_20250305');
    expect(contained.map((t) => t.name)).toContain('memory_recall');
  });
});
