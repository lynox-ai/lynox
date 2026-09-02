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

import { Agent, ContinuationLoopError } from './agent.js';

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
});
