import { describe, it, expect, vi } from 'vitest';
import type { ToolEntry } from '../../types/index.js';

/**
 * A `web_research` read whose address went through the origin check follows no redirect to
 * another host: the hop would carry the query to a host the owner was never asked about. The
 * real tool and its real handler run; only the page fetch is replaced, and it plays one redirect
 * through the hook the handler hands it, the way `fetchWithRedirects` does before each hop.
 */

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic { beta = { messages: { stream: vi.fn() } }; }
  class APIError extends Error {}
  return { default: MockAnthropic, APIError };
});
vi.mock('../../core/stream.js', () => ({ StreamProcessor: vi.fn() }));

const fetched: string[] = [];
let hop = '';
vi.mock('./content-extractor.js', () => ({
  extractContent: async (url: string, _max: unknown, _ctx: unknown, onRedirect?: (u: string, m: string, h?: Record<string, string>) => void) => {
    fetched.push(url);
    if (hop !== '') { onRedirect?.(hop, 'GET', {}); fetched.push(hop); }
    return { title: 't', url: hop || url, content: 'page', wordCount: 1, truncated: false };
  },
}));

import { Agent } from '../../core/agent.js';
import { OwnerKnownTargets } from '../../core/owner-known-targets.js';
import { ConversationLatch } from '../../core/conversation-latch.js';
import { createWebSearchTool, crossHostRedirectGuard, maskedHost } from './web-search-tool.js';
import type { SearchProvider } from './search-provider.js';

type Result = { content: unknown; is_error?: boolean };
type Exec = { _executeOneInner(tc: unknown): Promise<Result> };

function agentWith(tainted: boolean, ownerText: string): Agent {
  const agent = new Agent({
    name: 'a', model: 'claude-sonnet-4-6', provider: 'anthropic', noticeLanguage: 'en',
    tools: [createWebSearchTool({} as SearchProvider) as ToolEntry],
    promptUser: async () => 'Allow',
    ownerKnown: OwnerKnownTargets.of({ ownerTexts: () => [ownerText] }),
    conversationLatch: ConversationLatch.detached(),
  } as ConstructorParameters<typeof Agent>[0]);
  if (tainted) agent.restoreConversationTaint();
  return agent;
}

async function readVia(agent: Agent, url: string, redirectTo: string): Promise<Result> {
  fetched.length = 0;
  hop = redirectTo;
  return (agent as unknown as Exec)._executeOneInner({ type: 'tool_use', id: `t${Math.random()}`, name: 'web_research', input: { action: 'read', url } });
}

describe('a checked read and its redirects', () => {
  it('does not follow a redirect to another host, names it masked, and fetches nothing there', async () => {
    const agent = agentWith(true, 'see https://named.example for it');
    const r = await readVia(agent, 'https://named.example/r?to=x', 'https://d-secret.collect.evil.example/?d=secret');
    expect(fetched).toEqual(['https://named.example/r?to=x']);
    expect(String(r.content)).toContain('forwards this read to another host (…evil.example), and lynox did not follow');
    expect(String(r.content)).toContain('do not guess it');
    expect(String(r.content)).not.toContain('d-secret');
  });

  it('also after the owner said yes to the first host', async () => {
    const agent = agentWith(true, 'nothing named');
    const r = await readVia(agent, 'https://first.example/p?q=1', 'https://other.example/?d=x');
    expect(fetched).toEqual(['https://first.example/p?q=1']);
    expect(String(r.content)).toContain('forwards this read to another host');
  });

  it('follows a redirect on the same host', async () => {
    const agent = agentWith(true, 'see https://named.example for it');
    const r = await readVia(agent, 'https://named.example/p?q=1', 'https://named.example/next?q=1');
    expect(fetched).toEqual(['https://named.example/p?q=1', 'https://named.example/next?q=1']);
    expect(r.is_error).not.toBe(true);
  });

  it('an unchecked read (no foreign content before it) follows a redirect to another host as before', async () => {
    const agent = agentWith(false, 'nothing named');
    await readVia(agent, 'https://first.example/p?q=1', 'https://other.example/?d=x');
    expect(fetched).toEqual(['https://first.example/p?q=1', 'https://other.example/?d=x']);
  });

  it('a read without a query to a host the owner did not name is asked about, and after the yes its hops are held too', async () => {
    const agent = agentWith(true, 'nothing named');
    const r = await readVia(agent, 'https://first.example/page/secret', 'https://other.example/landing');
    expect(fetched).toEqual(['https://first.example/page/secret']);
    expect(String(r.content)).toContain('forwards this read to another host');
  });

  it('a read without a query of a host the owner named follows a redirect to another host, as before', async () => {
    // A download link on a named host that moves to a file host keeps working.
    const agent = agentWith(true, 'see https://named.example for it');
    await readVia(agent, 'https://named.example/download/1', 'https://files.other.example/1');
    expect(fetched).toEqual(['https://named.example/download/1', 'https://files.other.example/1']);
  });
});

describe('crossHostRedirectGuard', () => {
  it('passes the inner hook through when the read was not checked, and calls it on a same-host hop', () => {
    const inner = vi.fn();
    expect(crossHostRedirectGuard('https://a.example/?q=1', false, inner)).toBe(inner);
    crossHostRedirectGuard('https://a.example/?q=1', true, inner)?.('https://a.example/b', 'GET', {});
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('masks all but the last two labels', () => {
    expect(maskedHost('x.y.evil.example')).toBe('…evil.example');
    expect(maskedHost('evil.example')).toBe('evil.example');
  });
});
