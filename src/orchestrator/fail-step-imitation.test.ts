import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LynoxUserConfig } from '../types/index.js';
import type { Manifest, ManifestStep } from '../types/orchestration.js';

// A pure-reasoning step (`tools: []`) is offered its fail_step, so its request now
// carries a tool and the stream's tool-call imitation detector is armed for it. A model that
// writes `fail_step(...)` out as text, over and over, instead of calling it is stopped: the step
// fails — the direction a report of failure asks for — though not as a reported failure. The
// REAL StreamProcessor and detector run here; only the provider's event stream is scripted.

const { scripts, calls } = vi.hoisted(() => ({
  scripts: [] as Array<Array<Record<string, unknown>>>,
  calls: [] as Array<{ tools?: Array<{ name: string }> }>,
}));

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    beta = {
      messages: {
        stream: (params: { tools?: Array<{ name: string }> }) => ({
          finalMessage: async () => ({ content: [{ type: 'text', text: '' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }),
          [Symbol.asyncIterator]() {
            calls.push(params);
            const events = scripts.shift();
            if (!events) throw new Error('no scripted reply left');
            let i = 0;
            return {
              next: async () => (i < events.length ? { done: false, value: events[i++] } : { done: true, value: undefined }),
              return: async () => ({ done: true, value: undefined }),
            };
          },
        }),
      },
    };
  }
  class APIError extends Error {}
  return { default: MockAnthropic, APIError };
});

const { runManifest } = await import('./runner.js');

const usage = { input_tokens: 100, output_tokens: 0, cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, inference_geo: null, iterations: null, server_tool_use: null, service_tier: null, speed: null };
const config = { api_key: 'test-key' } as unknown as LynoxUserConfig;

/** A text reply, streamed in pieces of 7 characters. */
function textReply(text: string): void {
  const deltas: Array<Record<string, unknown>> = [];
  for (let o = 0; o < text.length; o += 7) {
    deltas.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(o, o + 7) } });
  }
  scripts.push([
    { type: 'message_start', message: { usage: { ...usage } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...deltas,
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 200 } },
    { type: 'message_stop' },
  ]);
}

const step: ManifestStep = { id: 'think', agent: 'think', runtime: 'inline', task: 'Check that the list has at least one order.', tools: [] };
const manifest: Manifest = {
  manifest_version: '1.1', name: 'imitation-flow', triggered_by: 'test', context: {},
  agents: [step], gate_points: [], on_failure: 'stop', execution: 'sequential',
};

beforeEach(() => {
  scripts.length = 0;
  calls.length = 0;
});

describe('a tools: [] step that writes fail_step out as text', { timeout: 60_000 }, () => {
  it('fails (stopped by the imitation detector), not completes — and not as a reported failure', async () => {
    textReply('Verification failed.\n' + 'fail_step(reason="The list has no orders.")\n'.repeat(5));
    const state = await runManifest(manifest, config, { source: { kind: 'adhoc' as const }, parentTools: [] });
    expect(calls[0]?.tools?.map(t => t.name).filter(n => n !== 'web_search')).toEqual(['fail_step']);
    expect(state.status).toBe('failed');
    expect(state.error).toMatch(/wrote the same tool call out as text/);
    expect(state.errorReportedBy).toBeUndefined();
  });

  it('control: the same step answering in plain prose completes', async () => {
    textReply('Verification passed: the list has 3 orders.');
    const state = await runManifest(manifest, config, { source: { kind: 'adhoc' as const }, parentTools: [] });
    expect(state.status).toBe('completed');
    expect(state.outputs.get('think')?.result).toContain('3 orders');
  });
});
