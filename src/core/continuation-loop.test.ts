// Regression: the TRUNCATION-CONTINUATION LOOP (2026-08-14, thread 8c09e50a).
// A 90 KB CSV inlined into the user message made the model echo the whole file
// through a write_file tool input; the response hit max_tokens MID-tool_use,
// the truncated call was discarded (never dispatched), the continuation
// restarted the SAME text prefix — seven times, five minutes, not a single
// tool call ever landed. RepeatCallGuard is structurally blind to this class
// (it counts DISPATCHED calls), and maxContinuations only capped the damage.
//
// The continuation-loop detector breaks the run after 3 identical
// no-progress continuations with ContinuationLoopError; progress (a tool that
// landed, or a DIFFERENT continuation text) resets it.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockProcess = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = { messages: { stream: vi.fn() } };
  }
  return { default: MockAnthropic };
});

vi.mock('./stream.js', () => ({
  StreamProcessor: vi.fn().mockImplementation(function (this: { process: typeof mockProcess }) {
    this.process = mockProcess;
  }),
}));

vi.mock('./observability.js', () => ({
  channels: {
    toolStart: { publish: vi.fn() },
    toolEnd: { publish: vi.fn() },
    contentTruncation: { hasSubscribers: false, publish: vi.fn() },
    securityFlagged: { hasSubscribers: false, publish: vi.fn() },
  },
  measureTool: vi.fn().mockReturnValue({ end: () => 0 }),
}));

import { Agent, ContinuationLoopError, ThinkingOnlyLoopError } from './agent.js';

const STUCK_PREFIX = 'Ich speichere die CSV-Datei und analysiere sie strukturiert mit Python.';

function truncatedResponse(text: string): unknown {
  // The loop shape: text prefix + a HUGE tool_use that the output budget cuts
  // mid-JSON. stop_reason max_tokens; the truncated tool_use is what the agent
  // discards (and what the provider rejects on parse — the
  // "Failed to parse tool input for write_file" toast).
  return {
    content: [
      { type: 'text', text },
      { type: 'tool_use', id: 'tu_trunc', name: 'write_file', input: { path: '/tmp/x.csv', content: 'x'.repeat(90_000) } },
    ],
    stop_reason: 'max_tokens',
    usage: { input_tokens: 100, output_tokens: 8192 },
  };
}

describe('continuation-loop break', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('breaks after 3 identical no-progress continuations', async () => {
    // Every turn: the same prefix, never a dispatched tool (the truncated
    // write_file is discarded before dispatch).
    mockProcess.mockImplementation(() => Promise.resolve(truncatedResponse(STUCK_PREFIX)));

    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
    await expect(agent.send('evaluate the csv')).rejects.toThrow(ContinuationLoopError);
    // initial call + 3 continuations, then the throw — not maxContinuations.
    expect(mockProcess).toHaveBeenCalledTimes(4);
  });

  it('a DIFFERENT continuation text resets the detector', async () => {
    let n = 0;
    mockProcess.mockImplementation(() => {
      n++;
      // Second continuation makes progress in WORDING, third is stuck again —
      // only 3 CONSECUTIVE identical continuations break.
      return Promise.resolve(truncatedResponse(`${STUCK_PREFIX} Versuch ${String(n)}`));
    });
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
    (agent as { maxIterations: number }).maxIterations = 6;
    let broke = false;
    try {
      await agent.send('evaluate the csv');
    } catch (err) {
      if (err instanceof ContinuationLoopError) broke = true;
    }
    expect(broke).toBe(false);
    // Continuations RECURSE (_loop() calls itself), so the iteration cap does
    // not bound them — only maxContinuations (default 10) does: 1 initial call
    // + 10 continuations = 11 model calls before the cap-exhausted path ends
    // the run. That is exactly why the prod loop burned 5 minutes: without the
    // detector, cap exhaustion is the ONLY stop.
    expect(mockProcess).toHaveBeenCalledTimes(11);
  });

  describe('blank truncated turns: no text, cut off in thinking or inside a tool call', () => {
    const thinkingOnly = (): unknown => ({ content: [], stop_reason: 'max_tokens', usage: { input_tokens: 100, output_tokens: 8192 } });
    const cutCall = (): unknown => ({
      content: [{ type: 'tool_use', id: 'tu_cut', name: 'write_file', input: {} }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 100, output_tokens: 8192 },
    });

    it('turns alternating between the two shapes stop at the third, not at the cap', async () => {
      // Each shape resets the other guard: the thinking count (not thinking-only) and the prefix
      // guard (blank prefix). This alternation used to reach the continuation cap.
      let n = 0;
      mockProcess.mockImplementation(() => Promise.resolve(n++ % 2 === 0 ? thinkingOnly() : cutCall()));
      const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
      const err = await agent.send('write the report').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ContinuationLoopError);
      expect(err).not.toBeInstanceOf(ThinkingOnlyLoopError);
      expect(mockProcess).toHaveBeenCalledTimes(3);
    });

    it('two thinking-only turns after a cut-off call stop as a thinking loop, the more specific guard', async () => {
      const turns = [cutCall(), thinkingOnly(), thinkingOnly()];
      let n = 0;
      mockProcess.mockImplementation(() => Promise.resolve(turns[n++]));
      const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
      await expect(agent.send('write the report')).rejects.toBeInstanceOf(ThinkingOnlyLoopError);
      expect(mockProcess).toHaveBeenCalledTimes(3);
    });

    it('the same cut-off call alone, with no text, stops at the third', async () => {
      mockProcess.mockImplementation(() => Promise.resolve(cutCall()));
      const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
      await expect(agent.send('write the report')).rejects.toThrow(ContinuationLoopError);
      expect(mockProcess).toHaveBeenCalledTimes(3);
    });

    it('a turn with text in between starts the count over', async () => {
      // blank, blank, text, blank, blank, then the answer: never three blank in a row.
      const turns = [cutCall(), thinkingOnly(), truncatedResponse('Ich schreibe den Bericht.'), cutCall(), thinkingOnly(),
        { content: [{ type: 'text', text: 'Der Bericht.' }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 50 } }];
      let n = 0;
      mockProcess.mockImplementation(() => Promise.resolve(turns[n++]));
      const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
      await expect(agent.send('write the report')).resolves.toBe('Der Bericht.');
      expect(mockProcess).toHaveBeenCalledTimes(6);
    });

    it('a turn whose server tool ran, with no text, is not blank', async () => {
      // A web search's blocks stay in the history: the model has something to build on.
      const searched = (): unknown => ({
        content: [
          { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'q' } },
          { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [] },
        ],
        stop_reason: 'max_tokens',
        usage: { input_tokens: 100, output_tokens: 8192 },
      });
      const turns = [cutCall(), thinkingOnly(), searched(), cutCall(), thinkingOnly(),
        { content: [{ type: 'text', text: 'Gefunden.' }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 50 } }];
      let n = 0;
      mockProcess.mockImplementation(() => Promise.resolve(turns[n++]));
      const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
      await expect(agent.send('search it')).resolves.toBe('Gefunden.');
      expect(mockProcess).toHaveBeenCalledTimes(6);
    });

    it('a server tool call cut off before its result is blank, like a cut-off tool call', async () => {
      // Nothing of it stays to build on: the call never ran, so no result block follows it.
      const cutSearch = (): unknown => ({
        content: [{ type: 'server_tool_use', id: 'srv_cut', name: 'web_search', input: { query: 'q' } }],
        stop_reason: 'max_tokens',
        usage: { input_tokens: 100, output_tokens: 8192 },
      });
      const turns = [cutCall(), thinkingOnly(), cutSearch(), cutCall()];
      let n = 0;
      mockProcess.mockImplementation(() => Promise.resolve(turns[n++]));
      const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
      const err = await agent.send('search it').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ContinuationLoopError);
      expect(err).not.toBeInstanceOf(ThinkingOnlyLoopError);
      expect(mockProcess).toHaveBeenCalledTimes(3);
    });

    it('each message starts the count over', async () => {
      // Two blank turns, then an answer; the next message begins with two blank turns again.
      const answer = (t: string): unknown => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 50 } });
      const turns = [cutCall(), thinkingOnly(), answer('Erster.'), cutCall(), thinkingOnly(), answer('Zweiter.')];
      let n = 0;
      mockProcess.mockImplementation(() => Promise.resolve(turns[n++]));
      const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6' });
      await expect(agent.send('first')).resolves.toBe('Erster.');
      await expect(agent.send('second')).resolves.toBe('Zweiter.');
      expect(mockProcess).toHaveBeenCalledTimes(6);
    });

    it('a tool dispatched in between starts the count over', async () => {
      const turns = [cutCall(), thinkingOnly(),
        { content: [{ type: 'tool_use', id: 'tu_ok', name: 'probe', input: {} }], stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 50 } },
        cutCall(), thinkingOnly(),
        { content: [{ type: 'text', text: 'Fertig.' }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 50 } }];
      let n = 0;
      mockProcess.mockImplementation(() => Promise.resolve(turns[n++]));
      const probe = { definition: { name: 'probe', description: 'probe', input_schema: { type: 'object' as const, properties: {} } }, handler: vi.fn().mockResolvedValue('ok') };
      const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', tools: [probe as never] });
      await expect(agent.send('write the report')).resolves.toBe('Fertig.');
      expect(probe.handler).toHaveBeenCalledTimes(1);
      expect(mockProcess).toHaveBeenCalledTimes(6);
    });
  });
});
