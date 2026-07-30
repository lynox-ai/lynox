/**
 * Follow-up chip recovery — does the spliced pair actually SURVIVE?
 *
 * The recovery adds a `tool_use`/`tool_result` pair to the turn so the chips
 * render on reload. That only works if the pair is written to the ThreadStore,
 * and it very nearly was not: the eager checkpoint (`_checkpoint()`, fired right
 * after the assistant message is pushed) ran BEFORE the recovery, and
 * `thread-store.appendMessages` is INSERT-only. So mutating the already-written
 * assistant message was a no-op on disk while the pushed `tool_result` still
 * landed — chips gone on reload, orphan `tool_result` row in the thread. Caught
 * in review, before it shipped.
 *
 * These drive the REAL agent loop (`send()`, not the private recovery method)
 * against a persistence sink with the same INSERT-only semantics as the store:
 * a checkpoint freezes what exists AT THAT MOMENT and never revisits it. That is
 * the property the ordering bug violated, so a test that snapshots any other way
 * cannot see it.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic { beta = { messages: { stream: vi.fn() } }; }
  class APIError extends Error {}
  return { default: MockAnthropic, APIError };
});
/**
 * The two call paths differ and both must work: the TURN goes through
 * `StreamProcessor.process(stream)`, the RECOVERY calls `stream.finalMessage()`
 * directly. The fake stream below carries its canned response on itself, so the
 * processor just unwraps what the client handed it.
 */
vi.mock('./stream.js', () => ({
  StreamProcessor: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.process = (stream: { _response: unknown }) => Promise.resolve(stream._response);
    return this;
  }),
}));
vi.mock('../tools/permission-guard.js', () => ({ isDangerous: vi.fn().mockReturnValue(null) }));
vi.mock('./observability.js', () => ({
  channels: {
    cacheHealth: { publish: vi.fn() },
    contentTruncation: { hasSubscribers: false, publish: vi.fn() },
    securityInjection: { hasSubscribers: false, publish: vi.fn() },
  },
  measureTool: vi.fn().mockReturnValue({ end: () => 0 }),
}));
vi.mock('./tier-resolver.js', async () => {
  const actual = await vi.importActual<typeof import('./tier-resolver.js')>('./tier-resolver.js');
  return { ...actual, resolveTierModel: () => ({ provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001' }) };
});
vi.mock('./metered-request.js', async () => {
  const actual = await vi.importActual<typeof import('./metered-request.js')>('./metered-request.js');
  return { ...actual, debitInRunHelperCost: vi.fn() };
});

import { Agent } from './agent.js';
import { suggestFollowUpsTool } from '../tools/builtin/suggest-follow-ups.js';

const CHIPS = [{ label: 'Budget senden', task: 'Sende das Budget an Markus.' }];
const USAGE = { input_tokens: 700, output_tokens: 150, cache_creation_input_tokens: null, cache_read_input_tokens: null };

interface Msg { role: string; content: unknown }

/**
 * INSERT-only persistence, like the real ThreadStore: each checkpoint appends
 * the messages that appeared since the last one and DEEP-COPIES them. A later
 * in-place mutation of an already-written message cannot reach this array —
 * exactly as it cannot reach a row that is already in SQLite.
 */
function makeStore() {
  const rows: Msg[] = [];
  let mark = 0;
  return {
    rows,
    checkpointFrom(messages: readonly Msg[]): void {
      for (let i = mark; i < messages.length; i++) {
        rows.push(structuredClone(messages[i]!) as Msg);
      }
      mark = messages.length;
    },
  };
}

function toolUseNames(rows: readonly Msg[]): string[] {
  return rows.flatMap((m) => Array.isArray(m.content)
    ? (m.content as Array<{ type?: string; name?: string }>)
      .filter((b) => b.type === 'tool_use')
      .map((b) => b.name ?? '?')
    : []);
}

function toolResultIds(rows: readonly Msg[]): string[] {
  return rows.flatMap((m) => Array.isArray(m.content)
    ? (m.content as Array<{ type?: string; tool_use_id?: string }>)
      .filter((b) => b.type === 'tool_result')
      .map((b) => b.tool_use_id ?? '?')
    : []);
}

function toolUseIds(rows: readonly Msg[]): string[] {
  return rows.flatMap((m) => Array.isArray(m.content)
    ? (m.content as Array<{ type?: string; id?: string }>)
      .filter((b) => b.type === 'tool_use')
      .map((b) => b.id ?? '?')
    : []);
}

/** A turn that answers in prose and stops — the non-compliant model. */
function buildAgent(recoveryReply: unknown) {
  const store = makeStore();
  let call = 0;
  const agent = new Agent({
    name: 'test',
    model: 'mistral-medium-2604',
    systemPrompt: 'SYS',
    onMessageCheckpoint: () => {
      store.checkpointFrom((agent as unknown as { messages: Msg[] }).messages);
    },
  });
  const inner = agent as unknown as { client: unknown; tools: unknown[] };
  inner.tools = [suggestFollowUpsTool];
  const TURN = {
    content: [{ type: 'text', text: 'Drei Aufgaben sind überfällig. Soll ich anfangen?' }],
    stop_reason: 'end_turn',
    usage: USAGE,
  };
  inner.client = {
    beta: {
      messages: {
        stream: () => {
          call++;
          // 1st call is the turn (read via StreamProcessor), 2nd is the forced
          // recovery (read via finalMessage). Both are served off `_response`.
          const response = call === 1 ? TURN : recoveryReply;
          return { _response: response, finalMessage: () => Promise.resolve(response) };
        },
      },
    },
  };
  agent.followUpFallback = true;
  return { agent, store };
}

const RECOVERED = {
  content: [{ type: 'tool_use', id: 'call_1', name: 'suggest_follow_ups', input: { suggestions: CHIPS } }],
  usage: USAGE,
};

describe('follow-up recovery survives persistence', () => {
  it('the spliced tool_use reaches the store — chips still render after a reload', async () => {
    const { agent, store } = buildAgent(RECOVERED);
    await agent.send('was steht an?');
    // The bug this pins: with the recovery running AFTER the eager checkpoint,
    // this array holds the assistant text without the tool_use, so the reload
    // path finds no suggest_follow_ups call and renders no chips.
    expect(toolUseNames(store.rows)).toContain('suggest_follow_ups');
  });

  it('never persists an ORPHAN tool_result — every result has its use on disk', async () => {
    const { agent, store } = buildAgent(RECOVERED);
    await agent.send('was steht an?');
    const results = toolResultIds(store.rows);
    expect(results.length).toBeGreaterThan(0);
    // The same ordering bug wrote the tool_result (a new message) while dropping
    // the tool_use (a mutation of an existing one) — leaving a dangling row that
    // a strict provider rejects on the next request.
    for (const id of results) expect(toolUseIds(store.rows)).toContain(id);
  });

  it('persists the suggestions themselves, not just the call shape', async () => {
    const { agent, store } = buildAgent(RECOVERED);
    await agent.send('was steht an?');
    expect(JSON.stringify(store.rows)).toContain('Budget senden');
  });

  it('leaves a clean thread when the recovery yields nothing', async () => {
    const { agent, store } = buildAgent({ content: [{ type: 'text', text: 'no' }], usage: USAGE });
    await agent.send('was steht an?');
    expect(toolUseNames(store.rows)).not.toContain('suggest_follow_ups');
    expect(toolResultIds(store.rows)).toHaveLength(0);
  });
});
