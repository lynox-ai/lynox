// Regression: ENDLESS TOOL LOOP — a model that IGNORES the RepeatCallGuard's
// escalated "do not call this again" result kept re-issuing the identical
// `api_setup view` call. Measured on prod 2026-08-14 (thread 861f3e4b, GLM via
// Fireworks): ~25 identical calls, every escalation read and ignored, ~50 s
// burned per run until the user aborted — and the aborted run's display-only
// rollback meant the NEXT run started with no memory of the loop (see
// DEF-webui-run-refire-on-reconnect for the restart half).
//
// The guard's soft escalation was the only line of defense and it is advisory:
// whether it is obeyed is up to the model. This spec pins the HARD line: after
// RepeatCallGuard.BREAK_AFTER_ESCALATIONS ignored escalations the RUN ends with
// ToolLoopBreakError (which Session renders as a calm tool_loop_break note).
//
// Drives a REAL Agent (LLM stubbed to always re-emit the identical tool_use)
// with a REAL tool whose handler always returns the same soft-failure string —
// exactly the prod shapes. Against the pre-fix code send() RESOLVES after
// maxIterations (the loop is bounded only by iteration cap); with the break it
// rejects after 3 executions + 2 escalated skips.

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

vi.mock('../tools/permission-guard.js', () => ({
  isDangerous: vi.fn().mockReturnValue(null), isDangerousDetailed: vi.fn().mockReturnValue(null),
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

import { Agent, ToolLoopBreakError } from './agent.js';
import type { ToolEntry } from '../tools/registry.js';

const TOOL_NAME = 'api_setup';
const INPUT = { action: 'view', id: 'zai' };
const SOFT_FAILURE = 'API profile "zai" not found. Use action "list" to see available profiles.';

function makeStuckTool(): ToolEntry {
  return {
    definition: {
      name: TOOL_NAME,
      description: 'stuck test tool',
      input_schema: { type: 'object' as const, properties: {}, additionalProperties: true },
    },
    handler: vi.fn().mockResolvedValue(SOFT_FAILURE),
  };
}

describe('hard tool-loop break', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let n = 0;
    // Every "model" turn re-issues the IDENTICAL call (fresh tool_use id — the
    // prod models did the same; the guard keys on name+input, not id).
    mockProcess.mockImplementation(() => {
      n++;
      return Promise.resolve({
        content: [{ type: 'tool_use' as const, id: `tu_${String(n)}`, name: TOOL_NAME, input: INPUT }],
        stop_reason: 'tool_use' as const,
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    });
  });

  it('ends the run with ToolLoopBreakError after ignored escalations', async () => {
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', tools: [makeStuckTool()] });
    // 3 executions (record streak → limit) + 2 escalated skips, then the break
    // fires at the post-tool-result checkpoint — 5 model calls, not maxIterations.
    await expect(agent.send('check the profile')).rejects.toThrow(ToolLoopBreakError);
    expect(mockProcess).toHaveBeenCalledTimes(5);
  });

  it('a run whose tool makes PROGRESS never breaks, however often it is called', async () => {
    let n = 0;
    const progressingTool: ToolEntry = {
      definition: {
        name: TOOL_NAME,
        description: 'progressing test tool',
        input_schema: { type: 'object' as const, properties: {}, additionalProperties: true },
      },
      handler: vi.fn().mockImplementation(() => {
        n++;
        return Promise.resolve(`attempt ${String(n)}: still pending…`);
      }),
    };
    const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', tools: [progressingTool] });
    // Loop forever from the model's side; cap iterations low for the test.
    (agent as { maxIterations: number }).maxIterations = 12;
    let broke = false;
    try {
      await agent.send('poll it');
    } catch (err) {
      if (err instanceof ToolLoopBreakError) broke = true;
    }
    expect(broke).toBe(false); // progress never trips the hard break
    expect(mockProcess).toHaveBeenCalledTimes(12); // ran to the cap — no early stop
  });
});
