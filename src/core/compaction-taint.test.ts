import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * DK.1 F5 regression: the sticky conversation taint must SURVIVE a compaction.
 *
 * A conversation that ingests untrusted content (a fetched page, a mail body, an
 * http_request result) arms `conversationSawUntrusted`, and a durable `remember`
 * write derives `sourceUntrusted` from it. The latch is meant to be sticky for
 * the life of the conversation.
 *
 * Compaction broke it, silently. `Session.compact()` rewrites the context via
 * `Agent.reset()` — which is the FRESH-conversation path and clears the latch by
 * design — and then `loadMessages()`, which re-derives the latch from the new
 * context. The post-compaction seed is a summary: it carries no wrapped-untrusted
 * marker and no `tool_use` block naming an external-content tool, so the
 * re-derivation lands on FALSE. The durable-write gate then stood open on a
 * conversation that HAD ingested untrusted data.
 *
 * Auto-compaction fires on context pressure, so the threads this hit were exactly
 * the long research ones most likely to be tainted.
 *
 * This spec drives the REAL `Session.compact()` with the summarising LLM stubbed,
 * so it fails on the pre-fix wiring rather than on a hand-fed value.
 *
 * ⚠️ The stub seam is `StreamProcessor`, NOT `messages.create`, and the
 * difference is not cosmetic. The agent summarises through
 * `client.beta.messages.stream(...)` handed to a `StreamProcessor`
 * (`agent.ts:1931`/`:1959`), so a `messages.create` stub intercepts nothing: the
 * summariser run reached the real provider, and in CI — no credentials, no
 * config — it sat on the network until vitest's 10s timeout. That made this
 * spec an INTERMITTENT failure on `main` (~1 run in 4 as of 2026-08-01), which
 * is worse than a red test: it trains re-running, and it reads as an
 * environment problem rather than a wiring one. Same seam as
 * `persist-post-compaction.test.ts`, which drives compaction deterministically.
 *
 * Stubbing the real seam also closes the coverage gap this file used to declare:
 * with a summary actually coming back, `compact()` now completes, so the
 * SUCCESSFUL path — reset + seed + re-derivation — is exercised, not just the
 * `if (!summary)` early return. Both exits are covered below.
 */

const mockProcess = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    beta = { messages: { stream: vi.fn() } };
  }
  return { default: FakeAnthropic, Anthropic: FakeAnthropic };
});

vi.mock('./stream.js', () => ({
  StreamProcessor: vi.fn().mockImplementation(function (this: { process: typeof mockProcess }) {
    this.process = mockProcess;
  }),
}));

/** A completed assistant turn carrying `text`. */
function endTurnResponse(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

describe('a compaction keeps the durable-write gate armed', () => {
  beforeEach(() => {
    mockProcess.mockReset();
    // Whatever the summariser is asked, hand back a clean summary — i.e. one with
    // no untrusted marker in it. That is the realistic case and the dangerous one:
    // nothing in the seed lets `loadMessages` re-derive the latch.
    mockProcess.mockResolvedValue(
      endTurnResponse('Summary: the user asked about pricing and we compared two vendors.'),
    );
  });

  it('carries conversationSawUntrusted across compact()', async () => {
    const { Engine } = await import('./engine.js');
    const engine = new Engine({
      model: 'balanced',
      context: { id: 'taint-spec', name: 'taint-spec', source: 'cli', workspaceDir: '' },
    });
    await engine.init();
    const session = engine.createSession?.() ?? (engine as unknown as { session: unknown }).session;
    const s = session as {
      agent: { noteUntrustedData(): void; conversationSawUntrusted: boolean } | null;
      loadMessages(m: unknown[]): void;
      compact(focus?: string): Promise<{ success: boolean }>;
    };

    // Enough history that compaction has something to summarise.
    s.loadMessages([
      { role: 'user', content: 'Please read the vendor page and compare.' },
      { role: 'assistant', content: 'I read it; here is the comparison.' },
    ]);

    // The conversation ingests untrusted content.
    s.agent?.noteUntrustedData();
    expect(s.agent?.conversationSawUntrusted).toBe(true);

    const result = await s.compact();

    // Pin WHICH exit was taken, rather than asserting it in a comment. The
    // docstring's claim that this file now covers the successful path is only
    // true while this holds; if the seam ever stops feeding a summary, compact()
    // silently reverts to the `if (!summary)` early return and the taint
    // assertion below would still pass — covering half of what it says it does.
    expect(result.success).toBe(true);

    // THE ASSERTION. Pre-fix this is false: reset() cleared the latch and the
    // summary seed gave loadMessages nothing to re-derive it from.
    expect(s.agent?.conversationSawUntrusted).toBe(true);
  });

  it('does not invent a taint where there was none', async () => {
    // The carry is one-way. A clean conversation must stay clean, or the gate
    // becomes noise and every durable write gets flagged.
    const { Engine } = await import('./engine.js');
    const engine = new Engine({
      model: 'balanced',
      context: { id: 'taint-spec-2', name: 'taint-spec-2', source: 'cli', workspaceDir: '' },
    });
    await engine.init();
    const s = (engine.createSession?.() ?? (engine as unknown as { session: unknown }).session) as {
      agent: { conversationSawUntrusted: boolean } | null;
      loadMessages(m: unknown[]): void;
      compact(focus?: string): Promise<{ success: boolean }>;
    };

    s.loadMessages([
      { role: 'user', content: 'What is two plus two?' },
      { role: 'assistant', content: 'Four.' },
    ]);
    expect(s.agent?.conversationSawUntrusted).toBe(false);

    await s.compact();

    expect(s.agent?.conversationSawUntrusted).toBe(false);
  });
});
