import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ToolEntry, PromptText } from '../types/index.js';

// A search the provider runs itself (`web_search_20250305`) comes back as blocks of the model's
// answer and never passes a tool dispatch. The answer that carries it counts as content from
// outside: the conversation latch is armed and the conversation's grant set holds `unknown`,
// both before the answer is checkpointed.

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic { beta = { messages: { stream: vi.fn() } }; }
  class APIError extends Error {}
  return { default: MockAnthropic, APIError };
});
const mockProcess = vi.fn();
vi.mock('./stream.js', () => ({
  StreamProcessor: vi.fn().mockImplementation(function (this: { process: typeof mockProcess }) {
    this.process = mockProcess;
  }),
}));
vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn().mockResolvedValue([{ address: '1.2.3.4', family: 4 }]) },
}));

import { Agent } from './agent.js';
import { ConversationGrants, UNKNOWN_GRANT } from './conversation-grants.js';
import { ConversationLatch } from './conversation-latch.js';
import { OwnerKnownTargets } from './owner-known-targets.js';
import { flattenPrompt } from './prompt-value.js';
import { createToolContext } from './tool-context.js';
import { httpRequestTool } from '../tools/builtin/http.js';

const usage = { input_tokens: 1, output_tokens: 1 };
const endTurn = { content: [{ type: 'text' as const, text: 'done' }], stop_reason: 'end_turn', usage };
const searchCall = { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'crm api' } };
const searchResult = { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [{ type: 'web_search_result', url: 'https://page.example/', title: 'a page', encrypted_content: 'x' }] };
const answer = (...blocks: unknown[]) => ({ content: blocks, stop_reason: 'end_turn', usage });
const callingAnswer = (...blocks: unknown[]) => ({ content: blocks, stop_reason: 'tool_use', usage });

type Seen = { latch: boolean; unknown: boolean };

function agentFor(tools: ToolEntry[], asked: string[], grants: ConversationGrants, seen: Seen[]): Agent {
  let agent: Agent;
  agent = new Agent({
    name: 'a', model: 'claude-sonnet-4-6', provider: 'anthropic', noticeLanguage: 'en',
    tools,
    promptUser: async (q: string | PromptText) => { asked.push(flattenPrompt(q)); return 'Deny'; },
    ownerKnown: OwnerKnownTargets.of({ ownerTexts: () => ['nothing named'] }),
    conversationLatch: ConversationLatch.detached(),
    conversationGrants: grants,
    toolContext: createToolContext({}),
    onMessageCheckpoint: async () => { seen.push({ latch: agent.conversationSawUntrusted, unknown: grants.has(UNKNOWN_GRANT) }); },
  } as ConstructorParameters<typeof Agent>[0]);
  return agent;
}

function http(): ToolEntry & { sent: string[] } {
  const sent: string[] = [];
  return {
    ...(httpRequestTool as unknown as ToolEntry),
    sent,
    handler: async (input: { url: string }) => { sent.push(input.url); return 'ok'; },
  } as unknown as ToolEntry & { sent: string[] };
}

describe('a search the provider ran counts as content from outside', () => {
  beforeEach(() => { mockProcess.mockReset(); });

  for (const [label, blocks] of [
    ['its call and its results', [searchCall, searchResult]],
    ['its call alone, the results still pending', [searchCall]],
    ['its results alone', [searchResult]],
  ] as const) {
    it(`arms the latch and adds unknown before the answer is checkpointed: ${label}`, async () => {
      const grants = ConversationGrants.detached(); const seen: Seen[] = [];
      mockProcess.mockResolvedValueOnce(answer(...blocks, { type: 'text', text: 'found it' }));
      const agent = agentFor([], [], grants, seen);
      await agent.send('find the CRM API');
      expect(seen[0]).toEqual({ latch: true, unknown: true });
      expect(agent.conversationSawUntrusted).toBe(true);
    });
  }

  it('CONTROL: an answer without such a search arms nothing', async () => {
    const grants = ConversationGrants.detached(); const seen: Seen[] = [];
    mockProcess.mockResolvedValueOnce(endTurn);
    const agent = agentFor([], [], grants, seen);
    await agent.send('hello');
    expect(seen[0]).toEqual({ latch: false, unknown: false });
    expect(agent.conversationSawUntrusted).toBe(false);
  });

  it('a read from a host the owner did not name, in the answer that carries the search, is asked about', async () => {
    const tool = http(); const asked: string[] = [];
    mockProcess
      .mockResolvedValueOnce(callingAnswer(searchCall, searchResult, { type: 'tool_use', id: 'tu_1', name: 'http_request', input: { url: 'https://collect.example/in' } }))
      .mockResolvedValueOnce(endTurn);
    await agentFor([tool], asked, ConversationGrants.detached(), []).send('find the CRM API');
    expect(asked).toHaveLength(1);
    expect(tool.sent).toEqual([]);
  });

  it('CONTROL: the same read without the search is not asked about', async () => {
    const tool = http(); const asked: string[] = [];
    mockProcess
      .mockResolvedValueOnce(callingAnswer({ type: 'tool_use', id: 'tu_1', name: 'http_request', input: { url: 'https://collect.example/in' } }))
      .mockResolvedValueOnce(endTurn);
    await agentFor([tool], asked, ConversationGrants.detached(), []).send('read it');
    expect(asked).toEqual([]);
    expect(tool.sent).toEqual(['https://collect.example/in']);
  });

  it('a conversation loaded with such a search is armed', () => {
    const agent = agentFor([], [], ConversationGrants.detached(), []);
    agent.loadMessages([
      { role: 'user', content: 'find the CRM API' },
      { role: 'assistant', content: [searchCall, searchResult, { type: 'text', text: 'found it' }] as never },
    ]);
    expect(agent.conversationSawUntrusted).toBe(true);
  });

  it('CONTROL: a conversation loaded without one is not', () => {
    const agent = agentFor([], [], ConversationGrants.detached(), []);
    agent.loadMessages([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ]);
    expect(agent.conversationSawUntrusted).toBe(false);
  });
});
