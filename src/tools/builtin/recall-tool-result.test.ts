import { describe, it, expect } from 'vitest';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import { recallToolResultTool } from './recall-tool-result.js';
import { ToolResultBlobStore, DEFAULT_TOOL_RESULT_BLOB_THRESHOLD_CHARS } from '../../core/tool-result-blob-store.js';
import type { IAgent } from '../../types/index.js';

function makeAgent(store?: ToolResultBlobStore): IAgent {
  return {
    name: 'test',
    model: 'test-model',
    memory: null,
    tools: [],
    onStream: null,
    toolResultBlobStore: store,
  } as unknown as IAgent;
}

/** Evict one oversized result into a fresh store and return [store, id]. */
function storeWithOneBlob(): { store: ToolResultBlobStore; id: string; payload: string } {
  const store = new ToolResultBlobStore();
  const payload = 'R'.repeat(5_000);
  const messages: BetaMessageParam[] = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'http_request', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: payload }] },
  ];
  const handles = store.evictFrom(messages, DEFAULT_TOOL_RESULT_BLOB_THRESHOLD_CHARS);
  return { store, id: handles[0]!.id, payload };
}

describe('recallToolResultTool', () => {
  it('returns the payload for a retained id', async () => {
    const { store, id, payload } = storeWithOneBlob();
    const result = await recallToolResultTool.handler({ id }, makeAgent(store));
    expect(result).toBe(payload);
  });

  it('returns a clear re-run message for an unknown id (not an error)', async () => {
    const { store } = storeWithOneBlob();
    const result = await recallToolResultTool.handler({ id: 'tr-999' }, makeAgent(store));
    expect(result).toContain('no longer available');
    expect(result).toContain('re-run the original tool call');
  });

  it('returns the re-run message after the store was cleared at the next compaction', async () => {
    const { store, id } = storeWithOneBlob();
    // Simulate the next compaction: the store is cleared at its start.
    store.clear();
    const result = await recallToolResultTool.handler({ id }, makeAgent(store));
    expect(result).toContain('no longer available');
    expect(result).toContain(id);
  });

  it('does not throw when no blob store is wired (ad-hoc agent)', async () => {
    const result = await recallToolResultTool.handler({ id: 'tr-1' }, makeAgent(undefined));
    expect(result).toContain('no longer available');
  });

  it('handles an empty id gracefully', async () => {
    const { store } = storeWithOneBlob();
    const result = await recallToolResultTool.handler({ id: '  ' }, makeAgent(store));
    expect(result).toContain('No recall id provided');
  });

  it('is registered with the expected name and required input', () => {
    expect(recallToolResultTool.definition.name).toBe('recall_tool_result');
    expect(recallToolResultTool.definition.input_schema.required).toContain('id');
  });
});
