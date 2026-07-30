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

/**
 * A model that calls the tool ITSELF and keeps going, then finishes with prose.
 *
 * This drives the primary gate — the flag that keeps a compliant model from
 * paying for a recovery it does not need — and it needs the co-emitted working
 * tool to reach it at all: `suggest_follow_ups` alone is `endsTurn`, so the loop
 * returns right there and the recovery branch is never entered. The reachable
 * case is the one the loop comment describes: a model that emits it ALONGSIDE a
 * working tool keeps looping, and the turn after that ends with `end_turn` —
 * which is the shape the recovery reads.
 */
describe('follow-up recovery stays silent for a compliant model', () => {
  it('never calls the helper when the model already called the tool', async () => {
    const store = makeStore();
    const working = {
      definition: { name: 'noop', description: 'x', input_schema: { type: 'object' as const, properties: {} } },
      handler: () => Promise.resolve('ok'),
    };
    const responses = [
      {
        content: [
          { type: 'tool_use', id: 'abc123def', name: 'suggest_follow_ups', input: { suggestions: CHIPS } },
          { type: 'tool_use', id: 'ghi456jkl', name: 'noop', input: {} },
        ],
        stop_reason: 'tool_use',
        usage: USAGE,
      },
      { content: [{ type: 'text', text: 'Fertig.' }], stop_reason: 'end_turn', usage: USAGE },
    ];
    let call = 0;
    const agent = new Agent({
      name: 'test',
      model: 'mistral-medium-2604',
      systemPrompt: 'SYS',
      onMessageCheckpoint: () => store.checkpointFrom((agent as unknown as { messages: Msg[] }).messages),
    });
    const inner = agent as unknown as { client: unknown; tools: unknown[] };
    inner.tools = [suggestFollowUpsTool, working];
    inner.client = {
      beta: { messages: { stream: () => {
        // Past the scripted turns the model would be the recovery's forced call.
        const response = responses[call++] ?? { content: [{ type: 'text', text: 'UNSCRIPTED' }], stop_reason: 'end_turn', usage: USAGE };
        return { _response: response, finalMessage: () => Promise.resolve(response) };
      } } },
    };
    agent.followUpFallback = true;
    await agent.send('was steht an?');
    // Two turns, no third: the recovery is what a third would be. Without the
    // gate every compliant model pays for a forced call on every single turn —
    // and persists a duplicate chip pair on top of its own.
    expect(call).toBe(2);
    expect(toolUseNames(store.rows).filter((n) => n === 'suggest_follow_ups')).toHaveLength(1);
  });
});

/** A turn that answers in prose and stops — the non-compliant model. */
function buildAgent(recoveryReply: unknown, turnOverride?: unknown) {
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
  const TURN = turnOverride ?? {
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
  return { agent, store, streamCalls: () => call };
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

  /**
   * The gate that decides whether to pay for a recovery reads the RESPONSE, and
   * `stop_reason` alone is not a reliable reading of it: the openai-compat
   * adapter defaults `stop_reason` to 'end_turn' when a stream ends without a
   * `finish_reason` — on the very provider class this feature targets. A turn
   * that DID call the tool then looks identical to one that declined.
   */
  it('does not pay for a recovery when the turn already carries the call', async () => {
    const COMPLIANT_TURN = {
      content: [
        { type: 'text', text: 'Drei Aufgaben sind überfällig.' },
        { type: 'tool_use', id: 'abc123def', name: 'suggest_follow_ups', input: { suggestions: CHIPS } },
      ],
      // The adapter's default, not a reading of the wire.
      stop_reason: 'end_turn',
      usage: USAGE,
    };
    const { agent, store, streamCalls } = buildAgent(RECOVERED, COMPLIANT_TURN);
    await agent.send('was steht an?');
    // One call: the turn. A second would be a forced tool call billed to the
    // user for suggestions the model had already produced.
    expect(streamCalls()).toBe(1);
    // And it would persist a SECOND chip pair — a duplicate row on reload.
    expect(toolUseNames(store.rows).filter((n) => n === 'suggest_follow_ups')).toHaveLength(1);
  });
});

/**
 * The context meter is anchored on the last REAL prompt size the API reported,
 * plus a char-estimate of everything appended since. That anchor is an index
 * into `messages[]` — and the recovery moves the array underneath it.
 */
describe('follow-up recovery leaves the context meter honest', () => {
  it('keeps the assistant reply inside the delta the meter estimates', async () => {
    // Large enough that dropping it is unmistakable at any chars-per-token.
    const REPLY = 'Der Bericht: ' + 'x'.repeat(20_000);
    const { agent } = buildAgent(RECOVERED, {
      content: [{ type: 'text', text: REPLY }],
      stop_reason: 'end_turn',
      usage: USAGE,
    });
    await agent.send('was steht an?');
    // Anchor = the API-reported prompt of 700 tokens. The delta must still hold
    // the 20k-char reply (≥ ~5k tokens). Read AFTER the recovery spliced a
    // tool_use onto that reply and pushed a tool_result behind it: an anchor
    // taken from the post-recovery `messages.length` points past the reply, and
    // the meter under-reports the turn it just made by the whole answer.
    const occupancy = agent.getEstimatedOccupancyTokens();
    expect(occupancy).toBeGreaterThan(700 + 4000);
    // Bounded above as well: the char-estimate FALLBACK (used when no real usage
    // has been recorded) also clears the lower bound, so a one-sided assertion
    // passes when the anchor is lost entirely rather than merely misplaced.
    // The real path counts the reply once, on top of a 700-token anchor.
    expect(occupancy).toBeLessThan(700 + 20_000);
  });
});

/**
 * The gate added for the adapter's `end_turn` default skips the recovery when
 * the turn's CONTENT already holds the call. A review round read that as "the
 * user then gets no chips at all", on the grounds that the dispatch branch never
 * runs for that shape. The dispatch branch indeed does not run — but the chips
 * do not come from dispatch: the StreamProcessor emits `tool_call` when the
 * BLOCK closes, independently of the stop reason. That half is pinned where the
 * real processor runs (`stream.test.ts`, "even when the stream never reports a
 * stop reason") — this file mocks `./stream.js`, so it cannot assert it.
 *
 * What THIS pins is the other half: no second paid call, and one chip-bearing
 * block on disk rather than two.
 */
describe('the compliant-shape gate does not pay twice', () => {
  it('makes no recovery call when the turn ends with the call in content', async () => {
    const store = makeStore();
    const agent = new Agent({
      name: 'test',
      model: 'mistral-medium-2604',
      systemPrompt: 'SYS',
      onMessageCheckpoint: () => store.checkpointFrom((agent as unknown as { messages: Msg[] }).messages),
    });
    const inner = agent as unknown as { client: unknown; tools: unknown[] };
    inner.tools = [suggestFollowUpsTool];
    let calls = 0;
    // The adapter's default when a stream ends with no finish_reason, carrying a
    // completed tool_use block.
    inner.client = {
      beta: { messages: { stream: () => {
        calls++;
        const response = {
          content: [{ type: 'tool_use', id: 'abc123def', name: 'suggest_follow_ups', input: { suggestions: CHIPS } }],
          stop_reason: 'end_turn',
          usage: USAGE,
        };
        return { _response: response, finalMessage: () => Promise.resolve(response) };
      } } },
    };
    agent.followUpFallback = true;
    await agent.send('was steht an?');
    // No paid second call…
    expect(calls).toBe(1);
    // …and exactly one chip-bearing block on disk, not two.
    expect(toolUseNames(store.rows).filter((n) => n === 'suggest_follow_ups')).toHaveLength(1);
  });
});
