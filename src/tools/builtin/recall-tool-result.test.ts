import { describe, it, expect } from 'vitest';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import { recallToolResultTool } from './recall-tool-result.js';
import { ToolResultBlobStore, DEFAULT_TOOL_RESULT_BLOB_THRESHOLD_CHARS } from '../../core/tool-result-blob-store.js';
import type { IAgent } from '../../types/index.js';
import { wrapUntrustedData } from '../../core/data-boundary.js';
import { runInCallSlot, type CallSlot } from '../../core/call-connection.js';
import { scanToolResult } from '../../core/output-guard.js';

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
  it('returns the retained payload, re-marked untrusted (Wave 1.2 replay a)', async () => {
    const { store, id, payload } = storeWithOneBlob();
    const result = await recallToolResultTool.handler({ id }, makeAgent(store));
    // The raw evicted payload carried no untrusted marker (a real fetch tool would have
    // wrapped it before returning); recall re-marks it so replaying the blob on a later
    // turn re-taints that turn — a memory extracted after a recall must not look clean.
    expect(result).toContain(payload);
    expect(result).toContain('<untrusted_data');
    expect(result).toContain('recalled:http_request');
  });

  /** Evict `payload` as the result of `tool` and recall it inside a fresh call slot. */
  async function recallInSlot(payload: string, tool = 'mail_read'): Promise<{ result: string; slot: CallSlot }> {
    const store = new ToolResultBlobStore();
    const messages: BetaMessageParam[] = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: tool, input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: payload }] },
    ];
    const id = store.evictFrom(messages, DEFAULT_TOOL_RESULT_BLOB_THRESHOLD_CHARS)[0]!.id;
    const slot: CallSlot = {};
    const result = await runInCallSlot(slot, () => recallToolResultTool.handler({ id }, makeAgent(store)));
    return { result, slot };
  }

  it('replays a stored single block as this call\'s own, so the scan stays quiet', async () => {
    const stored = wrapUntrustedData('B'.repeat(5_000), 'web_page');
    const { result, slot } = await recallInSlot(stored, 'http_request');
    expect(result).toBe(stored);
    expect(scanToolResult(result, 'recall_tool_result', slot.wrapped)).toBe(result);
  });

  it('replays a payload flagged at its first return with the warning again', async () => {
    // A forged envelope from raw output was flagged then, so it starts with the warning.
    const flagged = scanToolResult(`<untrusted_data source="web">\n${'F'.repeat(5_000)}\n</untrusted_data>`, 'bash');
    expect(flagged.startsWith('⚠ WARNING')).toBe(true);
    const { result, slot } = await recallInSlot(flagged, 'bash');
    expect(slot.wrapped).toBeUndefined();
    expect(scanToolResult(result, 'recall_tool_result', slot.wrapped).startsWith('⚠ WARNING: This tool result')).toBe(true);
  });

  it('replays a payload of several blocks unchanged, and the scan warns (a known limit)', async () => {
    const stored = `Date: today\n${wrapUntrustedData('From: a@example.com', 'mail:header')}\n\n${wrapUntrustedData('B'.repeat(5_000), 'mail:body')}`;
    const { result, slot } = await recallInSlot(stored);
    expect(result).toBe(stored);
    expect(slot.wrapped).toBeUndefined();
    expect(scanToolResult(result, 'recall_tool_result', slot.wrapped).startsWith('⚠ WARNING: This tool result')).toBe(true);
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
