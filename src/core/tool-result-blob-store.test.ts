import { describe, it, expect } from 'vitest';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import {
  ToolResultBlobStore,
  DEFAULT_TOOL_RESULT_BLOB_THRESHOLD_CHARS,
} from './tool-result-blob-store.js';

/** Build an assistant message containing one tool_use block. */
function toolUseMsg(id: string, name: string): BetaMessageParam {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input: {} }],
  };
}

/** Build a user message containing one tool_result block (string payload). */
function toolResultMsg(toolUseId: string, payload: string): BetaMessageParam {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content: payload }],
  };
}

describe('ToolResultBlobStore', () => {
  it('exposes a 4 KB default threshold', () => {
    expect(DEFAULT_TOOL_RESULT_BLOB_THRESHOLD_CHARS).toBe(4_096);
  });

  it('evicts a tool result above the threshold and lands it under an id', () => {
    const store = new ToolResultBlobStore();
    const big = 'x'.repeat(5_000);
    const messages: BetaMessageParam[] = [
      toolUseMsg('tu-1', 'http_request'),
      toolResultMsg('tu-1', big),
    ];

    const handles = store.evictFrom(messages, DEFAULT_TOOL_RESULT_BLOB_THRESHOLD_CHARS);

    expect(handles).toHaveLength(1);
    expect(store.size).toBe(1);
    const blob = store.get(handles[0]!.id);
    expect(blob).toBeDefined();
    expect(blob!.payload).toBe(big);
    expect(blob!.tool).toBe('http_request');
    expect(blob!.descriptor).toContain('http_request');
  });

  it('leaves a tool result at or below the threshold alone', () => {
    const store = new ToolResultBlobStore();
    const small = 'y'.repeat(1_000);
    const messages: BetaMessageParam[] = [
      toolUseMsg('tu-1', 'read_file'),
      toolResultMsg('tu-1', small),
    ];

    const handles = store.evictFrom(messages, DEFAULT_TOOL_RESULT_BLOB_THRESHOLD_CHARS);

    expect(handles).toHaveLength(0);
    expect(store.size).toBe(0);
  });

  it('honors a custom threshold from userConfig', () => {
    const store = new ToolResultBlobStore();
    // 2 KB payload — above a 1 KB custom threshold, below the 4 KB default.
    const payload = 'z'.repeat(2_048);
    const messages: BetaMessageParam[] = [
      toolUseMsg('tu-1', 'web_research'),
      toolResultMsg('tu-1', payload),
    ];

    // Default 4 KB: not evicted.
    expect(store.evictFrom(messages, DEFAULT_TOOL_RESULT_BLOB_THRESHOLD_CHARS)).toHaveLength(0);
    // Custom 1 KB: evicted.
    const custom = new ToolResultBlobStore();
    expect(custom.evictFrom(messages, 1_024)).toHaveLength(1);
  });

  it('evicts only the oversized blocks from a mixed history', () => {
    const store = new ToolResultBlobStore();
    const messages: BetaMessageParam[] = [
      toolUseMsg('tu-1', 'read_file'),
      toolResultMsg('tu-1', 'small'),
      toolUseMsg('tu-2', 'http_request'),
      toolResultMsg('tu-2', 'B'.repeat(8_000)),
      toolUseMsg('tu-3', 'web_research'),
      toolResultMsg('tu-3', 'C'.repeat(9_000)),
    ];

    const handles = store.evictFrom(messages, DEFAULT_TOOL_RESULT_BLOB_THRESHOLD_CHARS);

    expect(handles).toHaveLength(2);
    expect(store.size).toBe(2);
    const tools = store.entries().map(e => e.blob.tool).sort();
    expect(tools).toEqual(['http_request', 'web_research']);
  });

  it('falls back to a generic tool name when no matching tool_use block exists', () => {
    const store = new ToolResultBlobStore();
    // tool_result with no preceding tool_use (drifted history).
    const messages: BetaMessageParam[] = [toolResultMsg('orphan', 'D'.repeat(5_000))];

    const handles = store.evictFrom(messages, DEFAULT_TOOL_RESULT_BLOB_THRESHOLD_CHARS);

    expect(handles).toHaveLength(1);
    expect(store.get(handles[0]!.id)!.tool).toBe('tool');
  });

  it('extracts text from array-shaped tool_result content', () => {
    const store = new ToolResultBlobStore();
    const text = 'E'.repeat(6_000);
    const messages: BetaMessageParam[] = [
      toolUseMsg('tu-1', 'bash'),
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu-1',
            content: [{ type: 'text', text }],
          },
        ],
      },
    ];

    const handles = store.evictFrom(messages, DEFAULT_TOOL_RESULT_BLOB_THRESHOLD_CHARS);

    expect(handles).toHaveLength(1);
    expect(store.get(handles[0]!.id)!.payload).toBe(text);
  });

  it('mints unique, stable ids', () => {
    const store = new ToolResultBlobStore();
    const messages: BetaMessageParam[] = [
      toolUseMsg('tu-1', 'http_request'),
      toolResultMsg('tu-1', 'A'.repeat(5_000)),
      toolUseMsg('tu-2', 'http_request'),
      toolResultMsg('tu-2', 'B'.repeat(5_000)),
    ];
    const handles = store.evictFrom(messages, DEFAULT_TOOL_RESULT_BLOB_THRESHOLD_CHARS);
    const ids = handles.map(h => h.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('clear() hard-drops all retained blobs', () => {
    const store = new ToolResultBlobStore();
    store.evictFrom(
      [toolUseMsg('tu-1', 'http_request'), toolResultMsg('tu-1', 'A'.repeat(5_000))],
      DEFAULT_TOOL_RESULT_BLOB_THRESHOLD_CHARS,
    );
    expect(store.size).toBe(1);
    store.clear();
    expect(store.size).toBe(0);
  });

  it('returns undefined for an unknown id', () => {
    const store = new ToolResultBlobStore();
    expect(store.get('tr-999')).toBeUndefined();
  });
});
