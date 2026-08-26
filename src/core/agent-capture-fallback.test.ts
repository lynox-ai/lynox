/**
 * Turn-end fact capture — behaviour AND wiring.
 *
 * See `capture-fallback.ts` for the measurement that makes this exist: the
 * durable-knowledge flip replaced a mechanical extractor with a prose duty, the
 * legacy store's last entry is 2026-07-18, and the five weeks after produced 59
 * facts against the previous ~340 a month.
 *
 * The WIRING half is not decoration here. The sibling feature shipped once with
 * twelve green behaviour tests while its wiring was severed, and this session
 * built two separate bugs of exactly that shape in one day. So the last test in
 * this file asserts the CALL SITE, and its killing mutation is the deletion of
 * the wiring line — not a broken classifier.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic { beta = { messages: { stream: vi.fn() } }; }
  class APIError extends Error {}
  return { default: MockAnthropic, APIError };
});
vi.mock('./stream.js', () => ({ StreamProcessor: vi.fn() }));
vi.mock('../tools/permission-guard.js', () => ({ isDangerous: vi.fn().mockReturnValue(null), isDangerousDetailed: vi.fn().mockReturnValue(null) }));
vi.mock('./observability.js', () => ({
  channels: {
    cacheHealth: { publish: vi.fn() },
    contentTruncation: { hasSubscribers: false, publish: vi.fn() },
    // Present for the same reason as in the sibling file: absent, `wrapUntrustedData`
    // throws, the catch swallows it, and the test reads as "no call made".
    securityInjection: { hasSubscribers: false, publish: vi.fn() },
    secretAccess: { publish: vi.fn() },
  },
  measureTool: vi.fn().mockReturnValue({ end: () => 0 }),
}));
const mockResolveTierModel = vi.fn().mockReturnValue({ provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001' });
vi.mock('./tier-resolver.js', async () => {
  const actual = await vi.importActual<typeof import('./tier-resolver.js')>('./tier-resolver.js');
  return { ...actual, resolveTierModel: (tier: unknown, base: unknown) => mockResolveTierModel(tier, base) };
});
vi.mock('./metered-request.js', async () => {
  const actual = await vi.importActual<typeof import('./metered-request.js')>('./metered-request.js');
  return { ...actual, debitInRunHelperCost: vi.fn() };
});

import { Agent } from './agent.js';
import { CAPTURE_EXCERPT_MAX_CHARS, CAPTURE_MAX_FACTS, CAPTURE_TOOL_NAME } from './capture-fallback.js';
import type { StreamEvent } from '../types/index.js';

interface Internals {
  _captureFallback(text: string, turnUntrusted: boolean): Promise<void>;
  _captureAtTurnEnd(text: string): void;
  _sawRememberCall: boolean;
  _suppressTools: boolean;
  _durableMemoryEnabled: boolean;
  memory: unknown;
  messages: Array<{ role: string; content: unknown }>;
  client: unknown;
  onStream: ((e: StreamEvent) => void | Promise<void>) | undefined;
  costGuard: { recordExternalCost: (usd: number) => boolean } | null;
  toolContext: { meteredHost: unknown; knowledgeStore: unknown };
}

const USAGE = { input_tokens: 900, output_tokens: 120, cache_creation_input_tokens: null, cache_read_input_tokens: null };
const ANSWER = 'Habe die Offerte an Aquanatura geschickt. Yvonne ist dort die Ansprechperson für Bestellungen.';
const FACTS = [{ text: 'Yvonne Bieri ist bei Aquanatura die Ansprechperson für Bestellungen.', subject: 'Aquanatura' }];

function makeAgent(opts: { reply?: ReturnType<typeof vi.fn>; writeResult?: unknown } = {}) {
  const reply = opts.reply ?? vi.fn().mockResolvedValue({
    content: [{ type: 'tool_use', id: 'c1', name: CAPTURE_TOOL_NAME, input: { facts: FACTS } }],
    usage: USAGE,
  });
  const write = vi.fn().mockReturnValue(opts.writeResult ?? { id: 'k1', status: 'active', deduped: false });
  const agent = new Agent({ name: 'test', model: 'minimax-m3', systemPrompt: 'SYS' });
  const inner = agent as unknown as Agent & Internals;
  inner.client = {
    beta: { messages: { stream: (params: unknown, opt: unknown) => ({ finalMessage: () => reply(params, opt) }) } },
  };
  inner.toolContext = { ...(inner.toolContext ?? {}), knowledgeStore: { write } } as Internals['toolContext'];
  inner.messages = [
    { role: 'user', content: [{ type: 'text', text: 'schick die offerte an aquanatura' }] },
    { role: 'assistant', content: [{ type: 'text', text: ANSWER }] },
  ];
  const events: StreamEvent[] = [];
  inner.onStream = (e) => { events.push(e); };
  return { agent, inner, reply, write, events };
}

describe('turn-end capture — the two routes rafael asked for', () => {
  it('a CLEAN turn writes the fact as trusted', async () => {
    const { inner, write } = makeAgent();
    await inner._captureFallback(ANSWER, false);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0]).toMatchObject({ sourceUntrusted: false, sourceChannel: 'agent' });
  });

  it('an UNTRUSTED turn writes the same fact, flagged for review', async () => {
    // The half that decides whether this works in a research thread — which is
    // ~80% of real turns. The routing itself is NOT re-decided here: the same
    // `knowledgeStore.write` the `remember` tool calls makes it, from this flag.
    const { inner, write } = makeAgent({ writeResult: { id: 'k2', status: 'pending_review', deduped: false } });
    await inner._captureFallback(ANSWER, true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0]).toMatchObject({ sourceUntrusted: true });
  });

  it('surfaces each fact in the thread, with the status it actually got', async () => {
    const { inner, events } = makeAgent({ writeResult: { id: 'k3', status: 'pending_review', deduped: false } });
    await inner._captureFallback(ANSWER, true);
    const w = events.find((e) => e.type === 'knowledge_write');
    expect(w).toMatchObject({ type: 'knowledge_write', status: 'pending_review', id: 'k3' });
  });
});

describe('turn-end capture — when it stays quiet', () => {
  it('does not run when the model recorded a fact itself', async () => {
    // It RECOVERS, it never duplicates: a model that did the work is not
    // second-guessed by a helper that saw a shorter excerpt than it did.
    const { inner, reply } = makeAgent();
    inner._sawRememberCall = true;
    await inner._captureFallback(ANSWER, false);
    expect(reply).not.toHaveBeenCalled();
  });

  it('writes nothing when the classifier returns an empty list', async () => {
    // The expected answer on most turns, and it must cost nothing downstream.
    const reply = vi.fn().mockResolvedValue({
      content: [{ type: 'tool_use', id: 'c1', name: CAPTURE_TOOL_NAME, input: { facts: [] } }],
      usage: USAGE,
    });
    const { inner, write } = makeAgent({ reply });
    await inner._captureFallback(ANSWER, false);
    expect(write).not.toHaveBeenCalled();
  });

  it('never lets a provider failure surface as a turn error', async () => {
    const reply = vi.fn().mockRejectedValue(new Error('provider down'));
    const { inner, write } = makeAgent({ reply });
    await expect(inner._captureFallback(ANSWER, false)).resolves.toBeUndefined();
    expect(write).not.toHaveBeenCalled();
  });
});

describe('turn-end capture — the bounds that keep it affordable', () => {
  it('runs on the FAST tier, never on the turn model', async () => {
    const { inner, reply } = makeAgent();
    await inner._captureFallback(ANSWER, false);
    expect(mockResolveTierModel).toHaveBeenCalledWith('fast', expect.anything());
    expect((reply.mock.calls[0]![0] as { model: string }).model).toBe('claude-haiku-4-5-20251001');
  });

  it('caps the excerpt, so a long research turn cannot buy a large call', async () => {
    const { inner, reply } = makeAgent();
    await inner._captureFallback('x'.repeat(CAPTURE_EXCERPT_MAX_CHARS * 3), false);
    const sent = JSON.stringify((reply.mock.calls[0]![0] as { messages: unknown }).messages);
    expect(sent.length).toBeLessThan(CAPTURE_EXCERPT_MAX_CHARS * 2.5);
  });

  it('stops at the per-turn ceiling — a wall of proposals is not a feature', async () => {
    const many = Array.from({ length: CAPTURE_MAX_FACTS + 6 }, (_, i) => ({ text: `Fakt Nummer ${i} über den Kunden.` }));
    const reply = vi.fn().mockResolvedValue({
      content: [{ type: 'tool_use', id: 'c1', name: CAPTURE_TOOL_NAME, input: { facts: many } }],
      usage: USAGE,
    });
    const { inner, write } = makeAgent({ reply });
    await inner._captureFallback(ANSWER, false);
    expect(write).toHaveBeenCalledTimes(CAPTURE_MAX_FACTS);
  });
});

describe('turn-end capture — the WIRING, which is the half that decays silently', () => {
  it('the turn-end hook reaches the capture pass on a DK instance', async () => {
    // The killing mutation for this test is DELETING THE WIRING LINE in
    // `_captureAtTurnEnd`, not breaking the classifier. Every behaviour test
    // above survives that deletion — they call the method directly.
    const { inner } = makeAgent();
    inner._durableMemoryEnabled = true;
    inner.memory = {};
    const spy = vi.spyOn(inner as unknown as { _captureFallback: () => Promise<void> }, '_captureFallback')
      .mockResolvedValue(undefined);
    inner._captureAtTurnEnd(ANSWER);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
