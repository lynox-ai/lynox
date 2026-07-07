import { describe, it, expect, vi } from 'vitest';
import { StreamProcessor } from './stream.js';
import type { StreamEvent } from '../types/index.js';

async function* mockStream(events: Array<Record<string, unknown>>) {
  for (const e of events) {
    yield e;
  }
}

function createProcessor() {
  const collected: StreamEvent[] = [];
  const handler = (event: StreamEvent) => { collected.push(event); };
  const proc = new StreamProcessor(handler, 'test-agent');
  return { proc, collected };
}

describe('StreamProcessor', () => {
  describe('text streaming', () => {
    it('assembles text deltas and emits text events', async () => {
      const { proc, collected } = createProcessor();

      const result = await proc.process(mockStream([
        { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0, cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, inference_geo: null, iterations: null, server_tool_use: null, service_tier: null, speed: null } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5, input_tokens: 10 } },
        { type: 'message_stop' },
      ]) as AsyncIterable<never>);

      // Check assembled content
      expect(result.content[0]).toMatchObject({ type: 'text', text: 'Hello world' });
      expect(result.stop_reason).toBe('end_turn');

      // Check emitted events
      const textEvents = collected.filter(e => e.type === 'text');
      expect(textEvents).toHaveLength(2);
      expect(textEvents[0]).toMatchObject({ type: 'text', text: 'Hello', agent: 'test-agent' });
      expect(textEvents[1]).toMatchObject({ type: 'text', text: ' world', agent: 'test-agent' });
    });
  });

  describe('tool use', () => {
    it('assembles JSON deltas and emits tool_call on block stop', async () => {
      const { proc, collected } = createProcessor();

      await proc.process(mockStream([
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_1', name: 'bash', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"com' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'mand":"ls"}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } },
      ]) as AsyncIterable<never>);

      const toolCalls = collected.filter(e => e.type === 'tool_call');
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]).toMatchObject({
        type: 'tool_call',
        name: 'bash',
        input: { command: 'ls' },
        agent: 'test-agent',
      });
    });

    it('emits memory_recall tool_use as a discrete tool_call event (regression: HN trust-debug visibility)', async () => {
      // memory_recall must surface in the chat UI the same as web_research /
      // email_send / crm_* so users can SEE when prior memory shaped the
      // answer. The pipeline is: Claude tool_use block → StreamProcessor
      // emits `tool_call` → http-api writes SSE → chat store aggregates →
      // ChatView renders. This test locks in the FIRST hop (the only one
      // that could plausibly be regressed by tweaking emission rules); the
      // client-side `tool-call-label.test.ts` covers the labelling layer.
      const { proc, collected } = createProcessor();

      await proc.process(mockStream([
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_mem_1', name: 'memory_recall', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"name' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'space":"knowledge","query":"pricing"}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
      ]) as AsyncIterable<never>);

      const toolCalls = collected.filter(e => e.type === 'tool_call');
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]).toMatchObject({
        type: 'tool_call',
        name: 'memory_recall',
        input: { namespace: 'knowledge', query: 'pricing' },
        agent: 'test-agent',
      });
    });

    it('emits memory_recall with no-query input (namespace-only recency dump path)', async () => {
      // The no-query path (recency-ranked subset) is a valid call shape —
      // see `core/src/tools/builtin/memory.ts`. Confirm it still surfaces
      // as a tool_call so the user sees the namespace being explored.
      const { proc, collected } = createProcessor();

      await proc.process(mockStream([
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_mem_2', name: 'memory_recall', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"namespace":"status"}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } },
      ]) as AsyncIterable<never>);

      const toolCalls = collected.filter(e => e.type === 'tool_call');
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]).toMatchObject({
        type: 'tool_call',
        name: 'memory_recall',
        input: { namespace: 'status' },
      });
    });

    it('emits error for malformed JSON and sets empty input', async () => {
      const { proc, collected } = createProcessor();

      const result = await proc.process(mockStream([
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_1', name: 'bad', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{broken' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
      ]) as AsyncIterable<never>);

      const errors = collected.filter(e => e.type === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ type: 'error', agent: 'test-agent' });

      // Input should be set to empty object
      expect(result.content[0]).toMatchObject({ type: 'tool_use', input: {} });
    });
  });

  describe('server-side tool blocks (tool_search / web_search)', () => {
    it('passes server_tool_use + tool_search_tool_result through into content without emitting a tool_call', async () => {
      const { proc, collected } = createProcessor();

      const result = await proc.process(mockStream([
        // The model invokes the server-side tool-search tool. Its input may stream
        // as deltas; the processor does not accumulate server_tool_use input (only
        // client `tool_use`) — the block rides through whole, exactly as web_search
        // does today. block_stop on a non-tool_use block must be a safe no-op.
        { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srvtu_1', name: 'tool_search_tool_regex', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"regex":"mail"}' } },
        { type: 'content_block_stop', index: 0 },
        // The API appends the server-executed result inline (nested tool_reference).
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_search_tool_result', tool_use_id: 'srvtu_1', content: { tool_references: [{ type: 'tool_reference', tool_name: 'mail_search' }] } } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5, input_tokens: 10 } },
      ]) as AsyncIterable<never>);

      // Both server blocks survive in content, in order, types intact.
      expect(result.content.map(b => b.type)).toEqual(['server_tool_use', 'tool_search_tool_result']);
      expect(result.content[0]).toMatchObject({ type: 'server_tool_use', name: 'tool_search_tool_regex' });
      expect(result.content[1]).toMatchObject({ type: 'tool_search_tool_result', tool_use_id: 'srvtu_1' });
      // Server-executed tools must NOT surface as a client tool_call (no handler runs).
      expect(collected.filter(e => e.type === 'tool_call')).toHaveLength(0);
      expect(result.stop_reason).toBe('end_turn');
    });
  });

  describe('usage extraction', () => {
    it('extracts usage from message_delta', async () => {
      const { proc } = createProcessor();

      const result = await proc.process(mockStream([
        { type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 0, cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, inference_geo: null, iterations: null, server_tool_use: null, service_tier: null, speed: null } } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50, input_tokens: 100 } },
      ]) as AsyncIterable<never>);

      expect(result.usage.output_tokens).toBe(50);
    });

    it('extracts usage from message_start', async () => {
      const { proc } = createProcessor();

      const result = await proc.process(mockStream([
        { type: 'message_start', message: { usage: { input_tokens: 200, output_tokens: 0, cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, inference_geo: null, iterations: null, server_tool_use: null, service_tier: null, speed: null } } },
        { type: 'message_stop' },
      ]) as AsyncIterable<never>);

      expect(result.usage.input_tokens).toBe(200);
    });

    it('preserves cache fields from message_start after message_delta', async () => {
      const { proc } = createProcessor();

      const result = await proc.process(mockStream([
        { type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 0, cache_creation: null, cache_creation_input_tokens: 500, cache_read_input_tokens: 300, inference_geo: null, iterations: null, server_tool_use: null, service_tier: null, speed: null } } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50 } },
      ]) as AsyncIterable<never>);

      expect(result.usage.cache_creation_input_tokens).toBe(500);
      expect(result.usage.cache_read_input_tokens).toBe(300);
      expect(result.usage.output_tokens).toBe(50);
    });

    it('provides default usage when no events provide it', async () => {
      const { proc } = createProcessor();

      const result = await proc.process(mockStream([
        { type: 'message_stop' },
      ]) as AsyncIterable<never>);

      expect(result.usage.input_tokens).toBe(0);
      expect(result.usage.output_tokens).toBe(0);
    });
  });

  describe('thinking blocks', () => {
    it('assembles thinking deltas and emits thinking events', async () => {
      const { proc, collected } = createProcessor();

      await proc.process(mockStream([
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me think...' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      ]) as AsyncIterable<never>);

      const thinkingEvents = collected.filter(e => e.type === 'thinking');
      expect(thinkingEvents).toHaveLength(1);
      expect(thinkingEvents[0]).toMatchObject({
        type: 'thinking',
        thinking: 'Let me think...',
        agent: 'test-agent',
      });
    });
  });

  describe('multi-block response', () => {
    it('handles text + tool_use in same response', async () => {
      const { proc, collected } = createProcessor();

      const result = await proc.process(mockStream([
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'I will run a command.' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool_1', name: 'bash', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"echo hi"}' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
      ]) as AsyncIterable<never>);

      expect(result.content).toHaveLength(2);
      expect(result.content[0]).toMatchObject({ type: 'text', text: 'I will run a command.' });
      expect(result.content[1]).toMatchObject({ type: 'tool_use', name: 'bash', input: { command: 'echo hi' } });

      const textEvents = collected.filter(e => e.type === 'text');
      const toolEvents = collected.filter(e => e.type === 'tool_call');
      expect(textEvents).toHaveLength(1);
      expect(toolEvents).toHaveLength(1);
    });
  });

  describe('empty tool input', () => {
    it('sets empty object for tool with no JSON deltas', async () => {
      const { proc } = createProcessor();

      const result = await proc.process(mockStream([
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_1', name: 'noop', input: {} } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
      ]) as AsyncIterable<never>);

      expect(result.content[0]).toMatchObject({ type: 'tool_use', input: {} });
    });
  });
});
