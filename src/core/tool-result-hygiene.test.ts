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
