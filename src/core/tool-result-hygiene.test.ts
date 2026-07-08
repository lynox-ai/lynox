import { describe, it, expect } from 'vitest';
import type {
  BetaMessageParam,
  BetaToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import {
  contentKey,
  toolResultText,
  toolNameById,
  buildDedupReference,
  buildResidencyIndex,
  dedupToolResultBatch,
  DEFAULT_DEDUP_MIN_CHARS,
  type ResidentPayload,
} from './tool-result-hygiene.js';

const MIN = DEFAULT_DEDUP_MIN_CHARS;
const big = (fill: string): string => fill.repeat(Math.ceil((MIN + 1_000) / fill.length));

function toolUseMsg(id: string, name: string): BetaMessageParam {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] };
}

function toolResultMsg(
  toolUseId: string,
  content: BetaToolResultBlockParam['content'],
  isError = false,
): BetaMessageParam {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) }],
  };
}

function resultBlock(
  toolUseId: string,
  content: BetaToolResultBlockParam['content'],
  isError = false,
): BetaToolResultBlockParam {
  return { type: 'tool_result', tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) };
}

describe('contentKey', () => {
  it('is stable and length-prefixed for identical payloads', () => {
    const p = big('a');
    expect(contentKey(p)).toBe(contentKey(p));
    expect(contentKey(p).startsWith(`${p.length}:`)).toBe(true);
  });

  it('differs for different content and for different lengths', () => {
    expect(contentKey('abc')).not.toBe(contentKey('abd'));
    expect(contentKey('aa')).not.toBe(contentKey('aaa'));
  });
});

describe('toolResultText', () => {
  it('returns a string payload verbatim', () => {
    expect(toolResultText('hello')).toBe('hello');
  });

  it('concatenates text blocks and skips images', () => {
    const content: BetaToolResultBlockParam['content'] = [
      { type: 'text', text: 'foo' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'text', text: 'bar' },
    ];
    expect(toolResultText(content)).toBe('foobar');
  });
});

describe('toolNameById', () => {
  it('maps every tool_use_id to its tool name', () => {
    const names = toolNameById([toolUseMsg('tu-1', 'read_file'), toolUseMsg('tu-2', 'http_request')]);
    expect(names.get('tu-1')).toBe('read_file');
    expect(names.get('tu-2')).toBe('http_request');
  });
});

describe('buildResidencyIndex', () => {
  it('indexes large non-error tool_results keyed by content, with the producing tool', () => {
    const payload = big('a');
    const index = buildResidencyIndex([toolUseMsg('tu-1', 'read_file'), toolResultMsg('tu-1', payload)]);
    const entry = index.get(contentKey(payload));
    expect(entry).toBeDefined();
    expect(entry!.tool).toBe('read_file');
    expect(entry!.payload).toBe(payload);
  });

  it('skips sub-threshold and is_error results', () => {
    const small = 'y'.repeat(MIN - 100);
    const err = big('e');
    const index = buildResidencyIndex([
      toolUseMsg('tu-1', 'read_file'),
      toolResultMsg('tu-1', small),
      toolUseMsg('tu-2', 'bash'),
      toolResultMsg('tu-2', err, true),
    ]);
    expect(index.size).toBe(0);
  });

  it('keeps the earliest-resident copy when a payload appears twice', () => {
    const payload = big('a');
    const index = buildResidencyIndex([
      toolUseMsg('tu-1', 'read_file'),
      toolResultMsg('tu-1', payload),
      toolUseMsg('tu-2', 'http_request'),
      toolResultMsg('tu-2', payload),
    ]);
    expect(index.size).toBe(1);
    expect(index.get(contentKey(payload))!.tool).toBe('read_file'); // first wins
  });

  it('falls back to "tool" for a tool_result with no matching tool_use', () => {
    const payload = big('a');
    // Orphan tool_result (no assistant tool_use with this id) — e.g. a
    // synthesized/rehydrated block. The tool name is unknown → 'tool'.
    const index = buildResidencyIndex([toolResultMsg('orphan-id', payload)]);
    expect(index.get(contentKey(payload))!.tool).toBe('tool');
  });

  it('is empty for a post-compaction shape (no large payload resident inline)', () => {
    // After compaction the large payloads live in the blob store, not inline —
    // the synthetic seed is a summary + short handle list. The index must be
    // empty so a fresh identical result is NOT collapsed against evicted content.
    const index = buildResidencyIndex([
      { role: 'user', content: 'Summary of the conversation so far. Recall tr-1 for the earlier dump.' },
      { role: 'assistant', content: 'Understood.' },
    ]);
    expect(index.size).toBe(0);
  });
});

describe('dedupToolResultBatch', () => {
  const nameFor = (): string => 'read_file';

  it('elides a batch block byte-identical to a resident payload', () => {
    const payload = big('a');
    const index = buildResidencyIndex([toolUseMsg('tu-1', 'read_file'), toolResultMsg('tu-1', payload)]);
    const results = [resultBlock('tu-2', payload)];

    const elided = dedupToolResultBatch(results, nameFor, index);

    expect(elided).toBe(1);
    expect(results[0]!.content).toBe(buildDedupReference('read_file'));
    expect(results[0]!.content).not.toContain(payload);
  });

  it('dedups a repeat within the same batch (first verbatim, second a reference)', () => {
    const payload = big('a');
    const results = [resultBlock('tu-1', payload), resultBlock('tu-2', payload)];

    const elided = dedupToolResultBatch(results, nameFor, new Map());

    expect(elided).toBe(1);
    expect(results[0]!.content).toBe(payload); // first stays verbatim
    expect(results[1]!.content).toBe(buildDedupReference('read_file'));
  });

  it('collapses a 3rd+ copy against the first verbatim payload, not the elided reference', () => {
    // The reference (< minChars) is never indexed, so the 3rd copy must still
    // match the FIRST (verbatim) occurrence — proving the index holds the
    // original, not the substitute.
    const payload = big('a');
    const results = [resultBlock('tu-1', payload), resultBlock('tu-2', payload), resultBlock('tu-3', payload)];

    const elided = dedupToolResultBatch(results, nameFor, new Map());

    expect(elided).toBe(2);
    expect(results[0]!.content).toBe(payload); // first verbatim
    expect(results[1]!.content).toBe(buildDedupReference('read_file'));
    expect(results[2]!.content).toBe(buildDedupReference('read_file'));
  });

  it('registers a distinct array-content result so a later string duplicate elides against it', () => {
    const text = big('a');
    const arrayContent: BetaToolResultBlockParam['content'] = [{ type: 'text', text }];
    const index = new Map<string, ResidentPayload>();
    // First: an array-content result (no resident match) registers under its text key.
    expect(dedupToolResultBatch([resultBlock('tu-1', arrayContent)], nameFor, index)).toBe(0);
    // Then a plain-string result with the same text collapses against it.
    const later = [resultBlock('tu-2', text)];
    expect(dedupToolResultBatch(later, nameFor, index)).toBe(1);
    expect(later[0]!.content).toBe(buildDedupReference('read_file'));
  });

  it('leaves distinct payloads untouched', () => {
    const a = big('a');
    const b = big('b');
    const results = [resultBlock('tu-1', a), resultBlock('tu-2', b)];

    const elided = dedupToolResultBatch(results, nameFor, new Map());

    expect(elided).toBe(0);
    expect(results[0]!.content).toBe(a);
    expect(results[1]!.content).toBe(b);
  });

  it('does not dedup sub-threshold or is_error duplicates', () => {
    const small = 'y'.repeat(MIN - 100);
    const err = big('e');
    const results = [
      resultBlock('tu-1', small),
      resultBlock('tu-2', small),
      resultBlock('tu-3', err, true),
      resultBlock('tu-4', err, true),
    ];

    const elided = dedupToolResultBatch(results, nameFor, new Map());

    expect(elided).toBe(0);
    expect(results.every((r, i) => r.content === (i < 2 ? small : err))).toBe(true);
  });

  it('matches an array (image-bearing) duplicate but never physically replaces it', () => {
    const text = big('a');
    const arrayContent: BetaToolResultBlockParam['content'] = [
      { type: 'text', text },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ];
    // Resident: a plain-string copy of the same text. Batch: the array-content copy.
    const index = buildResidencyIndex([toolUseMsg('tu-1', 'read_file'), toolResultMsg('tu-1', text)]);
    const results = [resultBlock('tu-2', arrayContent)];

    const elided = dedupToolResultBatch(results, nameFor, index);

    expect(elided).toBe(0); // not counted — image preserved
    expect(results[0]!.content).toBe(arrayContent); // untouched, image intact
  });
});
