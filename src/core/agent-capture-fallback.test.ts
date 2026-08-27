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

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
vi.mock('./capture-telemetry.js', async () => {
  const actual = await vi.importActual<typeof import('./capture-telemetry.js')>('./capture-telemetry.js');
  return { ...actual, appendCaptureTelemetry: vi.fn() };
});
vi.mock('./metered-request.js', async () => {
  const actual = await vi.importActual<typeof import('./metered-request.js')>('./metered-request.js');
  return { ...actual, debitInRunHelperCost: vi.fn() };
});

import { Agent } from './agent.js';
import { CAPTURE_EXCERPT_MAX_CHARS, CAPTURE_MAX_FACTS, CAPTURE_TOOL_NAME } from './capture-fallback.js';
import { calculateCost } from './pricing.js';
import { debitInRunHelperCost } from './metered-request.js';
import { appendCaptureTelemetry } from './capture-telemetry.js';
import type { StreamEvent } from '../types/index.js';

interface Internals {
  _captureFallback(text: string, turnUntrusted: boolean): Promise<void>;
  _captureAtTurnEnd(text: string): void;
  _turnToolNames: Set<string>;
  _suppressTools: boolean;
  _durableMemoryEnabled: boolean;
  memory: unknown;
  messages: Array<{ role: string; content: unknown }>;
  client: unknown;
  onStream: ((e: StreamEvent) => void | Promise<void>) | undefined;
  costGuard: { recordExternalCost: (usd: number) => boolean } | null;
  toolContext: { meteredHost: unknown; knowledgeStore: unknown };
  _helperCostUsd: number;
  _pendingMemory: Array<Promise<unknown>>;
  secretStore: { containsSecret(t: string): boolean; maskSecrets(t: string): string } | null;
  currentRunId: string | undefined;
  currentThreadId: string | undefined;
  isInternalRun: boolean;
  skipMemoryExtraction: boolean;
  captureFallback: boolean;
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
  agent.captureFallback = true;
  const events: StreamEvent[] = [];
  inner.onStream = (e) => { events.push(e); };
  return { agent, inner, reply, write, events };
}

// Call counts are asserted below, and the module-level mocks live for the whole file —
// without this, `toHaveBeenCalledTimes(1)` reads every earlier test's calls too.
beforeEach(() => { vi.clearAllMocks(); });

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
    // Set through the ONE choke point every dispatched tool call passes, not a
    // private latch: the latch used to be set at two separate sites and deleting
    // either left every test green.
    (inner as unknown as { _turnToolNames: Set<string> })._turnToolNames.add('remember');
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
    // …and it must SAY that it ran. Without this the test passes just as happily when the
    // pass never executed — which is what happened on a live staging turn: no chip, no
    // event, and no way to tell a correct empty judgement from a dead mechanism.
    // `facts: 0` is a result; silence is not.
    const ran = vi.mocked(appendCaptureTelemetry).mock.calls
      .map(c => c[1] as unknown as Record<string, unknown>)
      .filter(e => e['event'] === 'capture_ran');
    expect(ran, 'an empty classification is indistinguishable from a pass that never ran').toHaveLength(1);
    expect(ran[0]).toMatchObject({ facts: 0, source: 'capture' });
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
    // Both halves long, because the cap USED to be applied per half — the real
    // bound was twice the constant, and the assert allowed 2.5x, so a mutation
    // raising the limit survived. This pins the constant with ~10% of slack for
    // the wrapper and the framing, nothing more.
    (inner.messages[0] as { content: unknown }).content = [{ type: 'text', text: 'q'.repeat(CAPTURE_EXCERPT_MAX_CHARS * 3) }];
    await inner._captureFallback('x'.repeat(CAPTURE_EXCERPT_MAX_CHARS * 3), false);
    const sent = JSON.stringify((reply.mock.calls[0]![0] as { messages: unknown }).messages);
    // A LITERAL, not the constant. Asserting against `CAPTURE_EXCERPT_MAX_CHARS`
    // means a mutation that raises the constant also raises the bar — measured:
    // doubling it to 14'000 left this test green. The number below is what the
    // constant is allowed to be worth in bytes on the wire, and it fails if the
    // constant moves.
    expect(sent.length).toBeLessThan(7000);
    // And the constant is what produced it — so a silent raise cannot hide here.
    expect(CAPTURE_EXCERPT_MAX_CHARS).toBe(6000);
  });

  it('stops at the per-turn ceiling — a wall of proposals is not a feature', async () => {
    const many = Array.from({ length: CAPTURE_MAX_FACTS + 6 }, (_, i) => ({ text: `Fakt Nummer ${i} über den Kunden.` }));
    const reply = vi.fn().mockResolvedValue({
      content: [{ type: 'tool_use', id: 'c1', name: CAPTURE_TOOL_NAME, input: { facts: many } }],
      usage: USAGE,
    });
    const { inner, write } = makeAgent({ reply });
    await inner._captureFallback(ANSWER, false);
    // Against a LITERAL, plus a pin on the constant — the same fix the excerpt test
    // got. Comparing to `CAPTURE_MAX_FACTS` made the assert restate the value it was
    // meant to hold: raising the constant to 40 kept it green, and nothing else in the
    // repo reads that constant.
    expect(write).toHaveBeenCalledTimes(4);
    expect(CAPTURE_MAX_FACTS, 'the per-turn ceiling moved — decide it, do not drift into it').toBe(4);
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
    // The ARGUMENTS, not just the count. An adversarial round flipped the second
    // argument to a hard `false` and all sixteen tests stayed green: the nine
    // behaviour tests pass the flag themselves, so the wiring `turnUntrusted ->
    // sourceUntrusted` — the half the entire security argument rests on — was
    // covered by nothing.
    expect(spy).toHaveBeenCalledWith(ANSWER, false);
  });

  it('hands the turn-end hook the REAL taint, not a constant', async () => {
    const { inner } = makeAgent();
    inner._durableMemoryEnabled = true;
    inner.memory = {};
    // Arm the conversation latch the way an external-content tool would.
    (inner as unknown as { _conversationSawUntrusted: boolean })._conversationSawUntrusted = true;
    const spy = vi.spyOn(inner as unknown as { _captureFallback: () => Promise<void> }, '_captureFallback')
      .mockResolvedValue(undefined);
    inner._captureAtTurnEnd(ANSWER);
    expect(spy).toHaveBeenCalledWith(ANSWER, true);
  });
});

describe('turn-end capture — what an adversarial round found missing', () => {
  it('is OFF unless the surface opted in', async () => {
    // No flag, no pass: a proposal nobody can see is a silent write, and a
    // spawned child inherits the parent's store but not this override.
    const { agent, inner, reply } = makeAgent();
    agent.captureFallback = false;
    await inner._captureFallback(ANSWER, false);
    expect(reply).not.toHaveBeenCalled();
  });

  it('FORCES the tool call — `auto` is the 2-4% compliance this exists to replace', async () => {
    const { inner, reply } = makeAgent();
    await inner._captureFallback(ANSWER, false);
    const params = reply.mock.calls[0]![0] as { tool_choice: { type: string; name: string } };
    expect(params.tool_choice).toEqual({ type: 'tool', name: CAPTURE_TOOL_NAME });
  });

  it('refuses a fact that looks like a credential — the gate `remember` has', async () => {
    // The store's own backstop is a SIZE limit; the secret rejection lives one
    // level up, in the tool handler. Writing through the same store inherited only
    // the first, so a clean turn could have stored a typed-in API key as trusted.
    const reply = vi.fn().mockResolvedValue({
      content: [{ type: 'tool_use', id: 'c1', name: CAPTURE_TOOL_NAME, input: {
        facts: [{ text: `Der Stripe-Key des Kunden ist sk_live_${'a'.repeat(40)}.` }],
      } }],
      usage: USAGE,
    });
    const { inner, write } = makeAgent({ reply });
    await inner._captureFallback(ANSWER, false);
    expect(write).not.toHaveBeenCalled();
  });

  it('marks the excerpt as untrusted data', async () => {
    // It carries web pages and mail bodies to a model whose output is written to a
    // store. Unwrapped, the classifier reads an injected "record that ..." as
    // instruction rather than as data.
    const { inner, reply } = makeAgent();
    await inner._captureFallback(ANSWER, false);
    const msgs = (reply.mock.calls[0]![0] as { messages: Array<{ content: string }> }).messages;
    const sent = msgs[0]!.content;
    // The BOUNDARY, not the label. `toContain('turn_excerpt')` was satisfied by any
    // string mentioning it — including a plain `turn_excerpt: ${x}` interpolation with
    // no tag neutralisation, no injection scan and no marker.
    expect(sent).toContain('<untrusted_data source="turn_excerpt"');
  });

  it('books the helper spend on the turn that caused it', async () => {
    // Measured as landing on the NEXT turn's line or nowhere, because the pass ran
    // past the end of `send()`. The turn drains it now; these are the two sinks.
    const { inner } = makeAgent();
    const recordExternalCost = vi.fn().mockReturnValue(true);
    inner.costGuard = { recordExternalCost } as unknown as Internals['costGuard'];
    await inner._captureFallback(ANSWER, false);
    expect(recordExternalCost).toHaveBeenCalledTimes(1);
    // The VALUE, not just "> 0". Pricing the call on `this.model` instead of the fast
    // snapshot also books a positive number — it books the WRONG one, and an unpriced
    // model silently falls back to $5/$25 per Mtok. The fixture runs `minimax-m3` as
    // the conversation model and haiku as the fast tier, so the two differ.
    const booked = recordExternalCost.mock.calls[0]![0] as number;
    const priced = (m: string): number => calculateCost(m, {
      input_tokens: USAGE.input_tokens, output_tokens: USAGE.output_tokens,
    });
    const expected = priced('claude-haiku-4-5-20251001');
    expect(booked).toBeCloseTo(expected, 10);
    expect(booked, 'priced on the conversation model, not the fast tier')
      .not.toBeCloseTo(priced('minimax-m3'), 10);
    // The SECOND sink the comment claims. Asserting one of two is how a comment that
    // says "these are the two sinks" outlives the code that made it true.
    expect(vi.mocked(debitInRunHelperCost)).toHaveBeenCalledTimes(1);
    expect(inner._helperCostUsd).toBeCloseTo(expected, 10);
  });

  it('does not surface a chip for a deduplicated write', async () => {
    // A dedup is not a proposal: nothing new happened, and a chip would ask the
    // user to approve something already recorded.
    const { inner, events } = makeAgent({ writeResult: { id: 'k9', status: 'active', deduped: true } });
    await inner._captureFallback(ANSWER, false);
    expect(events.find((e) => e.type === 'knowledge_write')).toBeUndefined();
  });

  it('announces ONCE even when the write path throws after the announcement', async () => {
    // `ks.write` on a busy database, or `onStream` on an SSE response that already ended —
    // the latter recorded in this file as a measured defect. Both emits firing puts one run
    // in two states the comment calls mutually exclusive, and the over-count lands exactly
    // on failing runs, which is where an honest rate matters most.
    const { inner } = makeAgent();
    inner.onStream = () => { throw new Error('SSE already ended'); };
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try { await inner._captureFallback(ANSWER, false); } finally { stderr.mockRestore(); }
    const ran = vi.mocked(appendCaptureTelemetry).mock.calls
      .map(c => c[1] as unknown as Record<string, unknown>)
      .filter(e => e['event'] === 'capture_ran');
    expect(ran, 'one pass announced itself twice').toHaveLength(1);
    expect(ran[0]!['facts'], 'the surviving line must be the one that knows the count').toBe(1);
  });

  it('treats a MISSING tool block as a completed empty pass, not as a failure', async () => {
    // A forced `tool_choice` is not a guarantee: a non-Anthropic fast slot on a hybrid
    // tenant may not honour it, and a max_tokens truncation can drop the block. The old
    // line returned before announcing, so that state was silent; it must now read as
    // "ran, found nothing" rather than vanish.
    const reply = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'kein Werkzeug' }], usage: USAGE });
    const { inner, write } = makeAgent({ reply });
    await inner._captureFallback(ANSWER, false);
    expect(write).not.toHaveBeenCalled();
    const ran = vi.mocked(appendCaptureTelemetry).mock.calls
      .map(c => c[1] as unknown as Record<string, unknown>)
      .filter(e => e['event'] === 'capture_ran');
    expect(ran).toHaveLength(1);
    expect(ran[0]!['facts']).toBe(0);
  });

  it('counts what the model OFFERED, not what survived the ceiling', async () => {
    // The producer half. The report tests seed `proposed` by hand and therefore cannot see
    // whether anything ever produces it — the same consumer-tested-in-isolation split that
    // let `facts` reach the sink and never be read. Nine offered, four written.
    const many = Array.from({ length: 9 }, (_, i) => ({ text: `Dauerhafter Fakt Nummer ${i} über den Kunden.` }));
    const reply = vi.fn().mockResolvedValue({
      content: [{ type: 'tool_use', id: 'c1', name: CAPTURE_TOOL_NAME, input: { facts: many } }],
      usage: USAGE,
    });
    const { inner, write } = makeAgent({ reply });
    await inner._captureFallback(ANSWER, false);
    expect(write, 'the ceiling must still bound what is WRITTEN').toHaveBeenCalledTimes(4);
    const ran = vi.mocked(appendCaptureTelemetry).mock.calls
      .map(c => c[1] as unknown as Record<string, unknown>)
      .filter(e => e['event'] === 'capture_ran');
    expect(ran).toHaveLength(1);
    expect(ran[0]!['facts'], 'written through the ceiling').toBe(4);
    expect(ran[0]!['proposed'], 'offered before it — this is what makes the ceiling measurable').toBe(9);
  });

  it('reports the fact COUNT it proposed, not merely that it ran', async () => {
    // A boolean "it ran" cannot separate a classifier proposing three facts from one
    // proposing one and dropping two. The count is what makes the per-turn ceiling
    // measurable at all — the legacy corpus lost exactly that to its own schema.
    const reply = vi.fn().mockResolvedValue({
      content: [{ type: 'tool_use', id: 'c1', name: CAPTURE_TOOL_NAME, input: { facts: [
        { text: 'Erster dauerhafter Fakt über den Kunden.' },
        { text: 'Zweiter dauerhafter Fakt über den Kunden.' },
        { text: 'Dritter dauerhafter Fakt über den Kunden.' },
      ] } }],
      usage: USAGE,
    });
    const { inner } = makeAgent({ reply });
    await inner._captureFallback(ANSWER, false);
    const ran = vi.mocked(appendCaptureTelemetry).mock.calls
      .map(c => c[1] as unknown as Record<string, unknown>)
      .filter(e => e['event'] === 'capture_ran');
    expect(ran).toHaveLength(1);
    expect(ran[0]!['facts']).toBe(3);
  });

  it('surfaces a chip for a TRUSTED write too — the one with no panel to recover it', async () => {
    // The pending route has a review panel; the trusted route has nothing. A guard
    // narrowed to `status === 'pending_review'` therefore fails in the direction that
    // is invisible: the fact is written and the user is never told. Both routes, or
    // the silent one is the one that breaks.
    const { inner, events } = makeAgent();
    await inner._captureFallback(ANSWER, false);
    const chip = events.find((e) => e.type === 'knowledge_write');
    expect(chip, 'a trusted capture wrote silently').toBeDefined();
    expect(chip).toMatchObject({ status: 'active' });
  });

  it('records the fact with the run id — the join key the fire rate needs', async () => {
    const { inner, write } = makeAgent();
    inner.currentRunId = 'run-77';
    await inner._captureFallback(ANSWER, false);
    // Named fields, not `toMatchObject` on two of them: the earlier version passed
    // with `sourceRunId` deleted, and without it the report cannot join a capture to
    // the run that paid for it.
    expect(write.mock.calls[0]![0]).toMatchObject({
      sourceRunId: 'run-77',
      subjectName: 'Aquanatura',
      text: FACTS[0]!.text,
    });
  });

  it('emits the telemetry that makes the rate readable, tagged as the MECHANISM', async () => {
    // Without `source`, a lifted rate and a model that started complying are one
    // number — which is the question the report exists to answer. This is also the
    // only thing that distinguishes "the feature landed" from "the feature is inert".
    // Both routes in one test, because `propose_shown` fires only where a proposal is
    // actually shown — a trusted write emits `remember_invoked` alone. Asserting the
    // pair on a clean turn would have pinned a sequence the code never produces.
    const clean = makeAgent();
    await clean.inner._captureFallback(ANSWER, false);
    const cleanEvents = vi.mocked(appendCaptureTelemetry).mock.calls
      .map((c) => c[1] as unknown as Record<string, unknown>);
    // `capture_ran` FIRST, then the write. The order is the claim: the pass announces
    // that it executed before anything depends on what it found, so an empty run and a
    // dead run stay distinguishable.
    expect(cleanEvents.map((e) => e['event'])).toEqual(['capture_ran', 'remember_invoked']);
    expect(cleanEvents[0]!['facts']).toBe(1);
    expect(cleanEvents[1]!['outcome']).toBe('active');

    vi.clearAllMocks();
    const queued = makeAgent({ writeResult: { id: 'k2', status: 'pending_review', deduped: false } });
    await queued.inner._captureFallback(ANSWER, true);
    const queuedEvents = vi.mocked(appendCaptureTelemetry).mock.calls
      .map((c) => c[1] as unknown as Record<string, unknown>);
    expect(queuedEvents.map((e) => e['event'])).toEqual(['capture_ran', 'remember_invoked', 'propose_shown']);
    for (const e of [...cleanEvents, ...queuedEvents]) {
      expect(e['source'], 'the mechanism is indistinguishable from model compliance').toBe('capture');
    }
  });

  it('is OFF on a fresh Agent — a spawned child must not run a paid pass', async () => {
    // The wiring file cannot hold this: it mocks the Agent constructor, so the class
    // field default is never evaluated there. Flipping the default to `true` left
    // every other test green because they all set the flag explicitly.
    const fresh = new Agent({ name: 'child', model: 'minimax-m3', systemPrompt: 'S' });
    expect(fresh.captureFallback).toBe(false);
  });

  it('does not run when tools are suppressed', async () => {
    const { inner, reply } = makeAgent();
    inner._suppressTools = true;
    await inner._captureFallback(ANSWER, false);
    expect(reply).not.toHaveBeenCalled();
  });

  it('does not run on an internal run', async () => {
    const { inner, reply } = makeAgent();
    inner.isInternalRun = true;
    await inner._captureFallback(ANSWER, false);
    expect(reply).not.toHaveBeenCalled();
  });

  it('refuses a fact whose SUBJECT is the credential', async () => {
    // The gate read `text` while the write also stored `subject` — and `subject_hint`
    // is the column that is NOT encrypted at rest, and that renders into the review
    // panel and into every later focus block. An innocuous sentence with a key as its
    // subject passed a check that was looking at the wrong field.
    const reply = vi.fn().mockResolvedValue({
      content: [{ type: 'tool_use', id: 'c1', name: CAPTURE_TOOL_NAME, input: { facts: [
        { text: 'Der Kunde hat eine Projekt-Kennung hinterlegt.', subject: `sk_live_${'a'.repeat(40)}` },
      ] } }],
      usage: USAGE,
    });
    const { inner, write } = makeAgent({ reply });
    await inner._captureFallback(ANSWER, false);
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses a fact the TENANT vault knows, not only one that looks shaped', async () => {
    // The pattern half was covered; the `secretStore.containsSecret` half was not, so
    // passing `undefined` for the store kept every test green while tenant-known
    // secrets flowed through.
    const reply = vi.fn().mockResolvedValue({
      content: [{ type: 'tool_use', id: 'c1', name: CAPTURE_TOOL_NAME, input: { facts: [
        { text: 'Das Kundenpasswort lautet Ho1zwurm-Nordberg-2026.' },
      ] } }],
      usage: USAGE,
    });
    const { inner, write } = makeAgent({ reply });
    inner.secretStore = {
      containsSecret: (t: string) => t.includes('Ho1zwurm-Nordberg-2026'),
      maskSecrets: (t: string) => t,
    };
    await inner._captureFallback(ANSWER, false);
    expect(write).not.toHaveBeenCalled();
  });

  it('masks the excerpt before it leaves for a possibly DIFFERENT vendor', async () => {
    const { inner, reply } = makeAgent();
    inner.secretStore = {
      containsSecret: () => false,
      maskSecrets: (t: string) => t.replace(/GEHEIM-\w+/g, '[redacted]'),
    };
    // BOTH halves. The excerpt is built from the answer AND from `lastUserText`, and a
    // credential is at least as likely to have been typed by the user as restated by the
    // assistant — masking only one half left the other shipping it verbatim.
    inner.messages = [
      { role: 'user', content: [{ type: 'text', text: 'mein zugang ist GEHEIM-frage999' }] },
      { role: 'assistant', content: [{ type: 'text', text: ANSWER }] },
    ];
    await inner._captureFallback(`Der Zugang ist GEHEIM-abc123. ${ANSWER}`, false);
    const sent = (reply.mock.calls[0]![0] as { messages: Array<{ content: string }> }).messages[0]!.content;
    expect(sent, 'the answer half ships the credential').not.toContain('GEHEIM-abc123');
    expect(sent, 'the question half ships the credential').not.toContain('GEHEIM-frage999');
    expect(sent).toContain('[redacted]');
  });

  it('reports a provider failure to stderr instead of swallowing it whole', async () => {
    // Silence made "found nothing" and "every run is throwing" the same observation.
    const reply = vi.fn().mockRejectedValue(new Error('upstream exploded'));
    const { inner } = makeAgent({ reply });
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await expect(inner._captureFallback(ANSWER, false)).resolves.toBeUndefined();
      expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain('upstream exploded');
    } finally { stderr.mockRestore(); }
    // …and the SINK hears it as well. stderr is not something the report can read, so a
    // failure that only reaches stderr is a failure the rate cannot see: it looked
    // identical to a mechanism that never ran. `facts` ABSENT is what distinguishes a
    // failed pass from one that completed and found nothing.
    const ran = vi.mocked(appendCaptureTelemetry).mock.calls
      .map(c => c[1] as unknown as Record<string, unknown>)
      .filter(e => e['event'] === 'capture_ran');
    expect(ran, 'a failed pass is invisible to the report').toHaveLength(1);
    expect(ran[0]!['facts'], 'a failed pass must not read as "completed, found nothing"').toBeUndefined();
    expect(ran[0]).toMatchObject({ source: 'capture' });
  });

  it('the TURN TRACKS the pass — it is not fired and forgotten', async () => {
    // The whole point of the fix: an untracked pass emits its chip after the SSE
    // stream closed and books its cost on the next turn's line. A spy on the method
    // cannot see this — the argument is identical either way; only the tracking
    // differs. So read the queue the turn drains.
    const { inner } = makeAgent();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = vi.fn().mockImplementation(async () => { await gate; return { content: [], usage: USAGE }; });
    inner.client = { beta: { messages: { stream: () => ({ finalMessage: () => slow() }) } } };
    inner._pendingMemory = [];
    // The three guards at the head of `_captureAtTurnEnd`, plus the DK branch the
    // capture pass lives in. Satisfied explicitly so the queue assert below is about
    // the tracking and not about a guard quietly returning first.
    inner.memory = {};
    inner.isInternalRun = false;
    inner._durableMemoryEnabled = true;
    inner._captureAtTurnEnd(ANSWER);
    expect(inner._pendingMemory.length, 'the pass is not in the queue the turn awaits').toBe(1);
    release?.();
    await Promise.all(inner._pendingMemory);
  });
});

/**
 * The turn-end hook's early exits — the level ABOVE the pass.
 *
 * Every test above drives `_captureFallback` directly, so all of them stay green when the
 * hook returns before ever reaching it. That is not hypothetical: `capture_eligible` fires
 * AFTER these guards and `remember_invoked` fires behind none of them, so a turn cut here
 * left no trace at either end of the fire-rate — measured as 910 numerator events against
 * 0 denominator events, with no way to say why.
 *
 * For the four REASON tests the killing mutation is deleting or reordering the matching
 * clause in `_captureGate`, not breaking the classifier. The other three are pinned by
 * something else and say so at the test — the gate flag, the denominator, and the positive
 * control. An earlier version of this sentence claimed all of them, which the PR's own
 * mutation table contradicted.
 */
describe('turn-end capture — the SILENT exits, now named', () => {
  function dkAgent(mutate: (inner: Agent & Internals) => void) {
    const { inner } = makeAgent();
    inner._durableMemoryEnabled = true;
    inner.memory = {};
    mutate(inner);
    return inner;
  }

  function suppressedCalls() {
    return vi.mocked(appendCaptureTelemetry).mock.calls
      .filter(([, entry]) => entry?.event === 'capture_suppressed');
  }

  beforeEach(() => { vi.mocked(appendCaptureTelemetry).mockClear(); });

  it('an isolated-memory child (no Memory) is COUNTED, not silent', () => {
    // The live path: spawn.ts hands `memory: undefined` for `isolated_memory: true` while
    // still passing `durableMemoryEnabled` through, so this agent can emit the numerator
    // from the `remember` handler and could never emit anything from here.
    const inner = dkAgent((a) => { a.memory = null; });
    inner._captureAtTurnEnd(ANSWER);
    const calls = suppressedCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toMatchObject({ event: 'capture_suppressed', reason: 'no_memory' });
    expect(calls[0]![0]).toBe(true);
  });

  it('a DK-OFF instance passes the gate FALSE — the sink stays a no-op', () => {
    // The assertion above cannot carry this on its own: in a DK-on agent the flag and a
    // hard-coded `true` are indistinguishable, so replacing `this._durableMemoryEnabled`
    // with `true` at the emit site SURVIVED the whole suite. Measured, not assumed — it is
    // the one mutation this file did not kill on the first cut. The property at stake is
    // the sink's founding one: byte-identical no-op wherever DK is off.
    const { inner } = makeAgent();
    inner._durableMemoryEnabled = false;
    inner.memory = null;
    inner._captureAtTurnEnd(ANSWER);
    const calls = suppressedCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]![0], 'the emit ignores the DK flag — a DK-off instance would write').toBe(false);
  });

  it('the ghost/privacy toggle is counted as itself, not as an absence', () => {
    const inner = dkAgent((a) => { a.skipMemoryExtraction = true; });
    inner._captureAtTurnEnd(ANSWER);
    expect(suppressedCalls()[0]![1]).toMatchObject({ reason: 'extraction_off' });
  });

  it('an internal run is counted as itself', () => {
    const inner = dkAgent((a) => { a.isInternalRun = true; });
    inner._captureAtTurnEnd(ANSWER);
    expect(suppressedCalls()[0]![1]).toMatchObject({ reason: 'internal_run' });
  });

  it('reports the guard that ACTUALLY returned first when two hold at once', () => {
    // Order is load-bearing: a reordering re-LABELS the population instead of changing it,
    // and nothing else in the suite would notice. `no_memory` precedes `extraction_off`.
    const inner = dkAgent((a) => {
      a.memory = null;
      a.skipMemoryExtraction = true;
    });
    inner._captureAtTurnEnd(ANSWER);
    expect(suppressedCalls()[0]![1]).toMatchObject({ reason: 'no_memory' });
  });

  it('pins the OTHER half of the order — extraction_off precedes internal_run', () => {
    // The first order test only pinned `no_memory` vs `extraction_off`; swapping the lower
    // two survived the whole suite. Half a pinned order is an unpinned order: the code calls
    // the sequence load-bearing, so every adjacent pair has to be.
    const inner = dkAgent((a) => { a.skipMemoryExtraction = true; a.isInternalRun = true; });
    inner._captureAtTurnEnd(ANSWER);
    expect(suppressedCalls()[0]![1]).toMatchObject({ reason: 'extraction_off' });
  });

  it('carries the REAL taint on a suppressed line, not a constant', () => {
    // The field's docblock argues it keeps suppression and untrustedness separable. Nothing
    // read it, so hard-coding `untrusted: false` passed everything — the same defect the
    // sibling turn-end test was written for after an adversarial round flipped that argument.
    const inner = dkAgent((a) => {
      a.skipMemoryExtraction = true;
      (a as unknown as { _conversationSawUntrusted: boolean })._conversationSawUntrusted = true;
    });
    inner._captureAtTurnEnd(ANSWER);
    expect(suppressedCalls()[0]![1]).toMatchObject({ reason: 'extraction_off', untrusted: true });
  });

  it('an ARMED-BUT-OFF pass is counted, and it is IN the denominator', async () => {
    // The exit one level down, found by an adversarial refuter: `worker-loop.ts` runs
    // scheduled tasks through a non-internal Session that HAS a Memory, so those turns pass
    // every prologue guard, emit `capture_eligible`, and then find `captureFallback` false.
    // Both lines must appear — the turn IS an opportunity, and it had no mechanism.
    const { agent, inner } = makeAgent();
    inner._durableMemoryEnabled = true;
    inner.memory = {};
    agent.captureFallback = false;
    inner._captureAtTurnEnd(ANSWER);
    await Promise.all(inner._pendingMemory);
    const calls = vi.mocked(appendCaptureTelemetry).mock.calls;
    expect(calls.filter(([, e]) => e?.event === 'capture_eligible')).toHaveLength(1);
    const sup = calls.filter(([, e]) => e?.event === 'capture_suppressed');
    expect(sup).toHaveLength(1);
    expect(sup[0]![1]).toMatchObject({ reason: 'fallback_off' });
  });

  it('the HEALTHY stand-down is not filed as a suppression — ARMED surface', async () => {
    // `_sawRememberCall` shares the exit but is the success case, already visible as
    // `remember_invoked` with `source: 'model'`. Counting it here would put a success under
    // a failure heading and inflate exactly the number that is supposed to explain a gap.
    const { inner } = makeAgent();
    inner._durableMemoryEnabled = true;
    inner.memory = {};
    inner._turnToolNames.add('remember');
    inner._captureAtTurnEnd(ANSWER);
    await Promise.all(inner._pendingMemory);
    expect(suppressedCalls()).toHaveLength(0);
  });

  it('the HEALTHY stand-down is not filed as a suppression — UNARMED surface either', async () => {
    // The combination the test above cannot reach: `makeAgent` arms the pass, so every
    // assertion about the healthy exit was made on the one surface where `captureFallback`
    // is true. On EVERY other surface — worker-loop, telegram, MCP, CLI — it is false on
    // every turn, so emitting `fallback_off` before the `_sawRememberCall` check filed each
    // turn where the model DID record a fact as a suppression. That defect passed the whole
    // suite. The killing mutation is putting the emit back above that check.
    const { agent, inner } = makeAgent();
    inner._durableMemoryEnabled = true;
    inner.memory = {};
    agent.captureFallback = false;
    inner._turnToolNames.add('remember');
    inner._captureAtTurnEnd(ANSWER);
    await Promise.all(inner._pendingMemory);
    expect(suppressedCalls(), 'a turn the model DID record is filed as a suppression').toHaveLength(0);
  });

  it('the SECOND writer pins its own fields — thread and taint, not just the prologue', async () => {
    // Two writers of one event are two signals sharing a name, and every field assertion
    // above was made on the PROLOGUE writer only. Measured: re-adding `thread` and
    // hard-coding `untrusted: false` at the `fallback_off` emit both SURVIVED the suite.
    // The docblock's promise is an allquantor over every `capture_suppressed` line, and one
    // of its two producers was unpinned — the same two-writer defect this branch corrects in
    // the prose, found one level down in my own tests.
    const { agent, inner } = makeAgent();
    inner._durableMemoryEnabled = true;
    inner.memory = {};
    agent.captureFallback = false;
    inner.currentThreadId = 'thread-xyz';
    (inner as unknown as { _conversationSawUntrusted: boolean })._conversationSawUntrusted = true;
    inner._captureAtTurnEnd(ANSWER);
    await Promise.all(inner._pendingMemory);
    const sup = suppressedCalls();
    expect(sup).toHaveLength(1);
    expect(sup[0]![1]).toMatchObject({ reason: 'fallback_off', untrusted: true });
    expect(sup[0]![1].thread, 'the second writer leaks the conversation id').toBeUndefined();
    // The control that makes the `thread` assertion mean something on THIS writer: the same
    // agent DOES put the id on the `capture_eligible` line of the very same turn.
    const eligible = vi.mocked(appendCaptureTelemetry).mock.calls
      .filter(([, e]) => e?.event === 'capture_eligible');
    expect(eligible[0]![1].thread).toBe('thread-xyz');
  });

  // ⚠ NOT covered, and deliberately not faked: hard-coding the DK gate to `true` at that
  // same emit ALSO survives — but it is an EQUIVALENT mutant, not a gap. `_captureFallback`
  // has exactly one call site (`agent.ts:1695`) and it sits inside `if (this._durableMemory
  // Enabled)`, so the flag is provably true wherever this line runs. Writing a test that
  // drives an unreachable state to kill it would manufacture coverage for a branch that
  // cannot occur. The argument is kept because a second call site would make it load-bearing.

  it('does NOT widen the denominator — a suppressed turn emits no capture_eligible', () => {
    // The restraint this change is built on. `capture_eligible` is the denominator of a
    // before/after comparison; a suppressed turn appearing there would corrupt the window.
    const inner = dkAgent((a) => { a.memory = null; });
    inner._captureAtTurnEnd(ANSWER);
    const eligible = vi.mocked(appendCaptureTelemetry).mock.calls
      .filter(([, entry]) => entry?.event === 'capture_eligible');
    expect(eligible).toHaveLength(0);
  });

  it('carries NO thread — the privacy toggle must not leave per-conversation metadata', () => {
    // `extraction_off` is the ghost mode used when handing the instance to someone else.
    // A per-turn line naming the conversation would put metadata about a third party's
    // session where that user chose to leave none, and nothing reads the field here.
    const inner = dkAgent((a) => {
      a.skipMemoryExtraction = true;
      // A thread id MUST be present on the agent, or the assertion below is satisfied by the
      // fixture rather than by the code — re-adding `thread: this.currentThreadId` survived
      // the whole suite until this line existed. The sibling `capture_eligible` assertion
      // proves the id is reachable, so an absent `thread` here is a decision, not a default.
      a.currentThreadId = 'thread-abc';
    });
    inner._captureAtTurnEnd(ANSWER);
    expect(suppressedCalls()[0]![1].thread, 'a suppressed line names the conversation').toBeUndefined();

    // The control that makes the assertion above mean something: the same agent DOES put the
    // id on an eligible line, so the omission is scoped to suppression.
    vi.mocked(appendCaptureTelemetry).mockClear();
    const ok = dkAgent((a) => { a.currentThreadId = 'thread-abc'; });
    ok._captureAtTurnEnd(ANSWER);
    const eligible = vi.mocked(appendCaptureTelemetry).mock.calls
      .filter(([, e]) => e?.event === 'capture_eligible');
    expect(eligible[0]![1].thread).toBe('thread-abc');
  });

  it('a turn that passes every guard emits capture_eligible and NO suppression line', () => {
    // The positive control. Without it every assertion above is satisfied by a hook that
    // suppresses unconditionally.
    const inner = dkAgent(() => {});
    inner._captureAtTurnEnd(ANSWER);
    expect(suppressedCalls()).toHaveLength(0);
    const eligible = vi.mocked(appendCaptureTelemetry).mock.calls
      .filter(([, entry]) => entry?.event === 'capture_eligible');
    expect(eligible).toHaveLength(1);
  });
});

/**
 * The `cause` column — DEF-dk-capture-observability (b).
 *
 * The killing mutation these are built for is NOT "the field is absent". It is the field
 * present at ONE end and missing at the other: a numerator stratified by cause against a
 * denominator that is not stratified is not a ratio, and every per-site presence check stays
 * green while that is true. So each test below drives a real turn and asserts the pair.
 */
describe('cause — both ends of the ratio, or it is not a ratio', () => {
  beforeEach(() => { vi.mocked(appendCaptureTelemetry).mockClear(); });

  function linesFor(event: string) {
    return vi.mocked(appendCaptureTelemetry).mock.calls
      .filter(([, e]) => e?.event === event)
      .map(([, e]) => e!);
  }

  it('a clean turn carries cause `none` on the DENOMINATOR and on the pass', async () => {
    const { inner } = makeAgent();
    inner._durableMemoryEnabled = true;
    inner.memory = {};
    inner._captureAtTurnEnd(ANSWER);
    await Promise.all(inner._pendingMemory);
    const eligible = linesFor('capture_eligible');
    const ran = linesFor('capture_ran');
    expect(eligible).toHaveLength(1);
    expect(ran.length, 'the pass did not run, so this asserts nothing about it').toBeGreaterThan(0);
    // The PAIR. Either one alone survives the mutation this test exists for.
    expect(eligible[0]!.cause).toBe('none');
    expect(ran[0]!.cause).toBe('none');
  });

  it('a conversation-tainted turn carries `conversation` at BOTH ends', async () => {
    // The member the whole row turns on: priority order means `conversation` implies the other
    // two did not fire, so its share over eligible turns is the upper bound on what the
    // data-scoped-taint redesign could flip.
    const { inner } = makeAgent();
    inner._durableMemoryEnabled = true;
    inner.memory = {};
    (inner as unknown as { _conversationSawUntrusted: boolean })._conversationSawUntrusted = true;
    inner._captureAtTurnEnd(ANSWER);
    await Promise.all(inner._pendingMemory);
    expect(linesFor('capture_eligible')[0]!.cause).toBe('conversation');
    expect(linesFor('capture_ran')[0]!.cause).toBe('conversation');
    expect(linesFor('remember_invoked')[0]!.cause).toBe('conversation');
  });

  it('cause `none` and untrusted `false` never disagree, on every line', async () => {
    // The invariant that catches a writer deriving one of the two from somewhere else. Checked
    // across every emitted line rather than a chosen one, so a single divergent writer fails.
    const { inner } = makeAgent();
    inner._durableMemoryEnabled = true;
    inner.memory = {};
    (inner as unknown as { _conversationSawUntrusted: boolean })._conversationSawUntrusted = true;
    inner._captureAtTurnEnd(ANSWER);
    await Promise.all(inner._pendingMemory);
    const withCause = vi.mocked(appendCaptureTelemetry).mock.calls
      .map(([, e]) => e!)
      .filter((e) => e.cause !== undefined);
    expect(withCause.length, 'no line carried a cause — the invariant is vacuous').toBeGreaterThan(1);
    for (const line of withCause) {
      expect((line.cause === 'none'), `${line.event}: cause=${line.cause} untrusted=${line.untrusted}`)
        .toBe(line.untrusted === false);
    }
  });

  it('the recovery pass tags its OWN remember_invoked, not just the tool handler', async () => {
    // `remember_invoked` has two writers. The tool handler is covered by knowledge.ts's own
    // suite; this pins the one inside the pass, which is the writer a `source: 'capture'` line
    // comes from and the one that was added later.
    const { inner } = makeAgent();
    inner._durableMemoryEnabled = true;
    inner.memory = {};
    inner._captureAtTurnEnd(ANSWER);
    await Promise.all(inner._pendingMemory);
    const remembered = linesFor('remember_invoked');
    expect(remembered).toHaveLength(1);
    expect(remembered[0]).toMatchObject({ source: 'capture', cause: 'none' });
  });

  it('the FAILED pass carries the cause too — the emit path the success test misses', async () => {
    // `capture_ran` has two writers: the success emit and the catch. Dropping `cause` from the
    // catch survived every test above, because they all drive a provider that answers. A
    // failed pass whose taint is unknown cannot be compared with a completed one, which is the
    // whole reason the failure emits at all.
    const reply = vi.fn().mockRejectedValue(new Error('provider down'));
    const { inner } = makeAgent({ reply });
    inner._durableMemoryEnabled = true;
    inner.memory = {};
    (inner as unknown as { _conversationSawUntrusted: boolean })._conversationSawUntrusted = true;
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      inner._captureAtTurnEnd(ANSWER);
      await Promise.all(inner._pendingMemory);
    } finally { stderr.mockRestore(); }
    const ran = linesFor('capture_ran');
    expect(ran).toHaveLength(1);
    // `facts` absent is what marks this as the failure state; the cause must ride along.
    expect(ran[0]!.facts, 'this drove the SUCCESS path, so it proves nothing about the catch').toBeUndefined();
    expect(ran[0]!.cause).toBe('conversation');
  });

  it('a SUPPRESSED line deliberately carries no cause', async () => {
    // Stated as a test so the omission cannot be read later as an oversight and "fixed" into
    // an inert field. A suppressed turn is not in the denominator, so its cause cannot enter
    // the ratio; a fallback_off turn already emitted its cause on `capture_eligible`.
    const { inner } = makeAgent();
    inner._durableMemoryEnabled = true;
    inner.memory = null;
    inner._captureAtTurnEnd(ANSWER);
    await Promise.all(inner._pendingMemory);
    const sup = linesFor('capture_suppressed');
    expect(sup).toHaveLength(1);
    expect(sup[0]!.cause).toBeUndefined();
  });
});
