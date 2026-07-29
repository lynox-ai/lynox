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
 * ⚠️ COVERAGE, stated rather than implied: the stub does not reach the provider
 * this Session actually summarises through, so `compact()` lands on its
 * `if (!summary)` early return — the path that deliberately leaves the thread
 * intact. That is a REAL path and it was broken (the summariser run clears the
 * latch before compaction decides anything), so the test is not theatre. But the
 * SUCCESSFUL-compaction path — reset + seed + re-derivation — is re-armed by the
 * same `rearmTaint()` and is NOT exercised here. Closing that needs a stub wired
 * to the configured provider; until then this covers one of two exits.
 */

const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = { create: mockCreate };
  }
  return { default: FakeAnthropic, Anthropic: FakeAnthropic };
});

describe('a compaction keeps the durable-write gate armed', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    // Whatever the summariser is asked, hand back a clean summary — i.e. one with
    // no untrusted marker in it. That is the realistic case and the dangerous one.
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Summary: the user asked about pricing and we compared two vendors.' }],
      usage: { input_tokens: 10, output_tokens: 10 },
      stop_reason: 'end_turn',
    });
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

    await s.compact();

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
