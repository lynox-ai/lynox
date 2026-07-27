import { describe, it, expect } from 'vitest';
import type {
  BetaMessageParam,
  BetaImageBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import {
  ToolResultBlobStore,
  DEFAULT_TOOL_RESULT_BLOB_THRESHOLD_CHARS,
  evictImagesFrom,
  DEFAULT_CARRIED_IMAGE_COUNT,
} from './tool-result-blob-store.js';

const T = DEFAULT_TOOL_RESULT_BLOB_THRESHOLD_CHARS;

/** Build an assistant message containing one tool_use block. */
function toolUseMsg(id: string, name: string, input: unknown = {}): BetaMessageParam {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input }],
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

  it('dedups an identical payload re-evicted across windows into ONE blob (amplifier fix)', () => {
    const store = new ToolResultBlobStore();
    const dump = 'X'.repeat(5_000);
    // Same payload parked in two compaction windows — a file dump re-evicted, or
    // a recalled payload re-parked. Pre-fix this minted tr-1 AND tr-2 for the
    // same bytes (the cross-compaction duplicate-resident amplifier); now the
    // second eviction reuses the first handle.
    const h1 = store.evictFrom([toolUseMsg('tu-1', 'read_file'), toolResultMsg('tu-1', dump)], T);
    const h2 = store.evictFrom([toolUseMsg('tu-2', 'read_file'), toolResultMsg('tu-2', dump)], T);
    expect(h2[0]!.id).toBe(h1[0]!.id); // same handle reused
    expect(store.size).toBe(1); // one blob, not two
    expect(store.bytes).toBe(5_000); // bytes counted once
    expect(store.get(h1[0]!.id)?.payload).toBe(dump);
  });

  it('does NOT dedup distinct payloads (no false reuse)', () => {
    const store = new ToolResultBlobStore();
    const a = store.evictFrom([toolUseMsg('tu-1', 'http_request'), toolResultMsg('tu-1', 'A'.repeat(5_000))], T);
    const b = store.evictFrom([toolUseMsg('tu-2', 'http_request'), toolResultMsg('tu-2', 'B'.repeat(5_000))], T);
    expect(b[0]!.id).not.toBe(a[0]!.id);
    expect(store.size).toBe(2);
  });

  it('re-mints identical content after its blob is pruned (dedup index stays consistent)', () => {
    const store = new ToolResultBlobStore();
    const dump = 'Y'.repeat(5_000);
    const first = store.evictFrom([toolUseMsg('tu-1', 'read_file'), toolResultMsg('tu-1', dump)], T)[0]!.id;
    store.pruneToCap(0, 0); // drop everything + clear the dedup index entry
    expect(store.get(first)).toBeUndefined();
    // Same content again → a FRESH blob; the pruned index entry must not linger
    // as a dangling reuse target pointing at the dropped id.
    const second = store.evictFrom([toolUseMsg('tu-2', 'read_file'), toolResultMsg('tu-2', dump)], T)[0]!.id;
    expect(store.get(second)?.payload).toBe(dump);
    expect(store.size).toBe(1);
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
    // Distinct payloads per blob — identical content would (correctly) dedup to
    // a single blob now, defeating this test's byte-cap-with-3-blobs intent.
    for (let i = 1; i <= 3; i++) {
      const tenKb = String.fromCharCode(64 + i).repeat(10_000); // 'A'/'B'/'C' dumps
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

/** A user message carrying one inline base64 image (+ optional leading text). */
function imgMsg(data: string, text = 'screenshot'): BetaMessageParam {
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
    ],
  };
}

/** The base64 payload of a returned image block (typesafe over the source union). */
function dataOf(block: BetaImageBlockParam): string {
  return block.source.type === 'base64' ? block.source.data : '';
}

describe('evictImagesFrom (#4 big-image preserve)', () => {
  it('exposes a default carried-image count of 2', () => {
    expect(DEFAULT_CARRIED_IMAGE_COUNT).toBe(2);
  });

  it('returns the most-recent K (default 2) user images in chronological order', () => {
    const kept = evictImagesFrom([imgMsg('one'), imgMsg('two'), imgMsg('three')]);
    expect(kept.map(dataOf)).toEqual(['two', 'three']);
  });

  it('honors a custom maxImages', () => {
    const kept = evictImagesFrom([imgMsg('a'), imgMsg('b'), imgMsg('c')], { maxImages: 1 });
    expect(kept.map(dataOf)).toEqual(['c']);
  });

  it('keeps every image whose cumulative size is below the byte cap', () => {
    const kept = evictImagesFrom([imgMsg('x'.repeat(5)), imgMsg('y'.repeat(5))], { maxImages: 5, maxBytes: 1_000 });
    expect(kept).toHaveLength(2);
  });

  it('drops the OLDEST image once the byte cap is exceeded (keep most-recent)', () => {
    // three 10-byte images, cap 25 → the two newest fit (20 ≤ 25), the oldest is dropped.
    const kept = evictImagesFrom(
      [imgMsg('x'.repeat(10)), imgMsg('y'.repeat(10)), imgMsg('z'.repeat(10))],
      { maxImages: 5, maxBytes: 25 },
    );
    expect(kept.map(dataOf)).toEqual(['y'.repeat(10), 'z'.repeat(10)]);
  });

  it('ignores tool_result and text blocks, and tolerates string-content user messages', () => {
    const messages: BetaMessageParam[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'x'.repeat(9_000) }] },
      { role: 'assistant', content: [{ type: 'text', text: 'noted' }] },
      { role: 'user', content: 'a plain string turn' },
      imgMsg('the-real-image'),
    ];
    const kept = evictImagesFrom(messages);
    expect(kept).toHaveLength(1);
    expect(dataOf(kept[0]!)).toBe('the-real-image');
  });

  it('ignores non-base64 (url) image sources — nothing to preserve inline', () => {
    const messages: BetaMessageParam[] = [
      { role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }] },
    ];
    expect(evictImagesFrom(messages)).toHaveLength(0);
  });

  it('only carries USER images (assistant-produced images are ignored)', () => {
    const messages: BetaMessageParam[] = [
      { role: 'assistant', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'z' } }] },
    ];
    expect(evictImagesFrom(messages)).toHaveLength(0);
  });

  it('returns empty for an image-free history (the common no-op case)', () => {
    const messages: BetaMessageParam[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    expect(evictImagesFrom(messages)).toHaveLength(0);
  });
});

describe('recall handle descriptors', () => {
  /** Payload shaped like a real wrapped http_request result. */
  function httpPayload(title: string): string {
    return '<untrusted_data source="http_response">\nHTTP 200 OK\n' +
      'content-type: text/html; charset=utf-8\n\n' +
      `title: ${title}\n\n${'Fliesstext. '.repeat(500)}\n</untrusted_data>`;
  }

  it('distinguishes results of the same tool by their call argument', () => {
    // The regression this fixes: the head excerpt used to start at the wrapper,
    // so three different pages produced BYTE-IDENTICAL descriptors and the agent
    // could not tell which handle held which page.
    const store = new ToolResultBlobStore();
    const pages = [
      ['https://konkurrent-a.de/preise', 'Preise & Pakete'],
      ['https://konkurrent-b.de/ueber-uns', 'Über uns'],
    ] as const;
    const messages: BetaMessageParam[] = [];
    pages.forEach(([url, title], i) => {
      messages.push(toolUseMsg(`tu-${i}`, 'http_request', { url, method: 'GET' }));
      messages.push(toolResultMsg(`tu-${i}`, httpPayload(title)));
    });

    const handles = store.evictFrom(messages, T);

    expect(handles).toHaveLength(2);
    expect(new Set(handles.map(h => h.descriptor)).size).toBe(2);
    expect(handles[0]!.descriptor).toContain('https://konkurrent-a.de/preise');
    expect(handles[0]!.descriptor).toContain('Preise & Pakete');
    expect(handles[1]!.descriptor).toContain('https://konkurrent-b.de/ueber-uns');
  });

  it('skips the untrusted-data wrapper and HTTP headers in the excerpt', () => {
    const store = new ToolResultBlobStore();
    const handles = store.evictFrom([
      toolUseMsg('tu-1', 'http_request', { url: 'https://example.com/' }),
      toolResultMsg('tu-1', httpPayload('Echter Titel')),
    ], T);

    expect(handles[0]!.descriptor).not.toContain('untrusted_data');
    expect(handles[0]!.descriptor).not.toContain('HTTP 200');
    expect(handles[0]!.descriptor).not.toContain('content-type');
    expect(handles[0]!.descriptor).toContain('Echter Titel');
  });

  it('keeps the real head of a payload that merely LOOKS header-shaped', () => {
    // The header skip is scoped to wrapper+HTTP-status openings, so an ordinary
    // `key: value` first line must not be eaten.
    const store = new ToolResultBlobStore();
    const handles = store.evictFrom([
      toolUseMsg('tu-1', 'read_file', { path: '/etc/app.conf' }),
      toolResultMsg('tu-1', `hostname: prod-01\n\n${'x'.repeat(5_000)}`),
    ], T);

    expect(handles[0]!.descriptor).toContain('hostname: prod-01');
    expect(handles[0]!.descriptor).toContain('/etc/app.conf');
  });

  it('masks a secret embedded in the identifying argument', () => {
    // The descriptor survives into the post-compaction seed, where the original
    // tool_use block is gone — an unmasked token would be RE-INTRODUCED by the
    // very mechanism meant to shrink the context.
    const store = new ToolResultBlobStore();
    const handles = store.evictFrom([
      toolUseMsg('tu-1', 'http_request', { url: 'https://api.example.com/v1?key=sk-ant-abcdefghijklmnopqrstuvwx' }),
      toolResultMsg('tu-1', 'y'.repeat(5_000)),
    ], T);

    expect(handles[0]!.descriptor).not.toContain('sk-ant-abcdefghijklmnopqrstuvwx');
    expect(handles[0]!.descriptor).toContain('api.example.com');
  });

  it('never uses a payload-carrying argument as the label', () => {
    // `content` would put the whole written file back into the descriptor —
    // the allowlist of key NAMES is what structurally prevents that.
    const store = new ToolResultBlobStore();
    const handles = store.evictFrom([
      toolUseMsg('tu-1', 'write_file', { path: '/tmp/out.md', content: 'A'.repeat(9_000) }),
      toolResultMsg('tu-1', 'z'.repeat(5_000)),
    ], T);

    expect(handles[0]!.descriptor).toContain('/tmp/out.md');
    expect(handles[0]!.descriptor).not.toContain('AAAA');
    expect(handles[0]!.descriptor.length).toBeLessThan(300);
  });

  it('labels a bash result with its command', () => {
    const store = new ToolResultBlobStore();
    const handles = store.evictFrom([
      toolUseMsg('tu-1', 'bash', { command: 'npm test' }),
      toolResultMsg('tu-1', 'w'.repeat(5_000)),
    ], T);

    expect(handles[0]!.descriptor).toContain('bash(npm test)');
  });

  it('truncates an over-long identifying argument but keeps its head', () => {
    const store = new ToolResultBlobStore();
    const handles = store.evictFrom([
      toolUseMsg('tu-1', 'http_request', { url: `https://example.com/${'p'.repeat(400)}` }),
      toolResultMsg('tu-1', 'v'.repeat(5_000)),
    ], T);

    const d = handles[0]!.descriptor;
    // Asserting the argument specifically — a bare `…`/length check would also
    // pass on the old descriptor, whose ellipsis came from the head excerpt.
    expect(d).toContain('https://example.com/ppp');
    expect(d).not.toContain('p'.repeat(200));
    expect(d.length).toBeLessThan(300);
  });

  it('degrades to the bare tool label when no key identifies the call', () => {
    const store = new ToolResultBlobStore();
    const handles = store.evictFrom([
      toolUseMsg('tu-1', 'memory_list', { limit: 50 }),
      toolResultMsg('tu-1', 'u'.repeat(5_000)),
    ], T);

    // The distinguishing bit is the LABEL: `memory_list result` (no argument)
    // versus `memory_list(...)`. A prefix-only match would hold either way.
    expect(handles[0]!.descriptor).toContain('memory_list result · 4.9 KB');
    expect(handles[0]!.descriptor).not.toContain('memory_list(');
  });
});
