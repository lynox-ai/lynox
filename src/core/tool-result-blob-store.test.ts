import { describe, it, expect } from 'vitest';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import {
  ToolResultBlobStore,
  DEFAULT_TOOL_RESULT_BLOB_THRESHOLD_CHARS,
} from './tool-result-blob-store.js';

const T = DEFAULT_TOOL_RESULT_BLOB_THRESHOLD_CHARS;

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

describe('ToolResultBlobStore — carry-forward across compactions (W5)', () => {
  // Mutation-verified: under the OLD clear-on-every-compaction behaviour the
  // first window's blob would be gone after the second eviction. Carry-forward
  // keeps it recallable, which is the whole point of the fix.
  it('keeps a prior window blob recallable after a second eviction window (no clear)', () => {
    const store = new ToolResultBlobStore();
    // Window 1
    store.evictFrom([toolUseMsg('tu-1', 'http_request'), toolResultMsg('tu-1', 'A'.repeat(5_000))], T);
    const firstId = store.entries()[0]!.id;
    // Window 2 — mirrors the new compact() flow: evict again WITHOUT clear().
    store.evictFrom([toolUseMsg('tu-2', 'web_research'), toolResultMsg('tu-2', 'B'.repeat(5_000))], T);

    expect(store.size).toBe(2);
    // The first window's blob survives into the second window.
    expect(store.get(firstId)?.payload).toBe('A'.repeat(5_000));
  });

  it('lists carried-forward blobs in entries() so they stay discoverable', () => {
    const store = new ToolResultBlobStore();
    store.evictFrom([toolUseMsg('tu-1', 'http_request'), toolResultMsg('tu-1', 'A'.repeat(5_000))], T);
    store.evictFrom([toolUseMsg('tu-2', 'web_research'), toolResultMsg('tu-2', 'B'.repeat(5_000))], T);
    // This is exactly what compact() now passes to buildPostCompactionMessages.
    const handles = store.entries().map(({ id, blob }) => ({ id, descriptor: blob.descriptor }));
    expect(handles).toHaveLength(2);
    expect(handles[0]!.descriptor).toContain('http_request');
  });

  it('pruneToCap drops the least-recently-used blob beyond the entry cap', () => {
    const store = new ToolResultBlobStore();
    // 3 blobs, cap of 2 → the oldest (tr-1) is evicted.
    for (let i = 1; i <= 3; i++) {
      store.evictFrom([toolUseMsg(`tu-${i}`, 'http_request'), toolResultMsg(`tu-${i}`, String(i).repeat(5_000))], T);
    }
    store.pruneToCap(2, Number.MAX_SAFE_INTEGER);
    expect(store.size).toBe(2);
    expect(store.get('tr-1')).toBeUndefined();
    expect(store.get('tr-3')).toBeDefined();
  });

  it('LRU bump via get() protects a recently-recalled blob from pruning', () => {
    const store = new ToolResultBlobStore();
    for (let i = 1; i <= 3; i++) {
      store.evictFrom([toolUseMsg(`tu-${i}`, 'http_request'), toolResultMsg(`tu-${i}`, String(i).repeat(5_000))], T);
    }
    // Recall the OLDEST (tr-1) → it becomes most-recently-used.
    expect(store.get('tr-1')).toBeDefined();
    // Cap to 2 → now tr-2 (the new oldest) is evicted, tr-1 survives.
    store.pruneToCap(2, Number.MAX_SAFE_INTEGER);
    expect(store.get('tr-1')).toBeDefined();
    expect(store.get('tr-2')).toBeUndefined();
  });

  it('pruneToCap enforces the byte cap (a few huge dumps)', () => {
    const store = new ToolResultBlobStore();
    const tenKb = 'x'.repeat(10_000);
    for (let i = 1; i <= 3; i++) {
      store.evictFrom([toolUseMsg(`tu-${i}`, 'http_request'), toolResultMsg(`tu-${i}`, tenKb)], T);
    }
    expect(store.bytes).toBe(30_000);
    // Byte cap of 25 KB → drop oldest until under: tr-1 goes (20 KB left ≤ 25 KB).
    store.pruneToCap(Number.MAX_SAFE_INTEGER, 25_000);
    expect(store.size).toBe(2);
    expect(store.bytes).toBe(20_000);
    expect(store.get('tr-1')).toBeUndefined();
  });

  it('clear() resets the byte counter too', () => {
    const store = new ToolResultBlobStore();
    store.evictFrom([toolUseMsg('tu-1', 'http_request'), toolResultMsg('tu-1', 'A'.repeat(5_000))], T);
    expect(store.bytes).toBe(5_000);
    store.clear();
    expect(store.bytes).toBe(0);
    expect(store.size).toBe(0);
  });
});
