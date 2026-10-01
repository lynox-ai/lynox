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
  function wrapped(title: string): string {
    return '<untrusted_data source="http_response">\nHTTP 200 OK\n' +
      'content-type: text/html; charset=utf-8\n\n' +
      `title: ${title}\n\n${'Fliesstext. '.repeat(500)}\n</untrusted_data>`;
  }

  it('distinguishes results of the same tool by their call argument', () => {
    // The defect this fixes: every http_request descriptor was `http_request
    // result · N KB · <untrusted_data…>` — byte-identical across pages.
    const store = new ToolResultBlobStore();
    const messages: BetaMessageParam[] = [
      toolUseMsg('tu-0', 'http_request', { url: 'https://a.de/preise', method: 'GET' }),
      toolResultMsg('tu-0', wrapped('Preise')),
      toolUseMsg('tu-1', 'http_request', { url: 'https://b.de/ueber-uns', method: 'GET' }),
      toolResultMsg('tu-1', wrapped('Über uns')),
    ];

    const handles = store.evictFrom(messages, T);

    expect(new Set(handles.map(h => h.descriptor)).size).toBe(2);
    expect(handles[0]!.descriptor).toContain('http_request(https://a.de/preise)');
    expect(handles[1]!.descriptor).toContain('http_request(https://b.de/ueber-uns)');
  });

  it('KEEPS the untrusted-data marker in the excerpt', () => {
    // Load-bearing, and the reason the excerpt is the RAW payload head: after a
    // compaction this descriptor is the only place the marker still appears, and
    // `Agent._contextHoldsUntrustedMarker()` re-derives the conversation taint by
    // scanning for it. An excerpt that skipped the wrapper silently disarmed the
    // durable-write gate, so later `remember` writes derived from fetched pages
    // were recorded as trusted.
    const store = new ToolResultBlobStore();
    const handles = store.evictFrom([
      toolUseMsg('tu-1', 'http_request', { url: 'https://example.com/' }),
      toolResultMsg('tu-1', wrapped('Titel')),
    ], T);

    expect(handles[0]!.descriptor).toContain('<untrusted_data');
  });

  it('prefers `url` over a later key when both are present', () => {
    // Pins the ORDER of IDENTIFYING_INPUT_KEYS. Without this, reversing the list
    // leaves every other descriptor test green.
    const store = new ToolResultBlobStore();
    const handles = store.evictFrom([
      toolUseMsg('tu-1', 'api_setup', { url: 'https://api.example.com/v1', path: '/local/cache', name: 'x' }),
      toolResultMsg('tu-1', 'q'.repeat(5_000)),
    ], T);

    expect(handles[0]!.descriptor).toContain('(https://api.example.com/v1)');
    expect(handles[0]!.descriptor).not.toContain('/local/cache');
  });

  it('ignores a payload-carrying key even when it is the ONLY key', () => {
    // Pins the ALLOWLIST itself. A test that also passes `path` would stay green
    // if `content` were added to the list, because `path` wins by order.
    const store = new ToolResultBlobStore();
    const handles = store.evictFrom([
      toolUseMsg('tu-1', 'write_file', { content: 'A'.repeat(9_000) }),
      toolResultMsg('tu-1', 'z'.repeat(5_000)),
    ], T);

    expect(handles[0]!.descriptor).toContain('write_file result');
    expect(handles[0]!.descriptor).not.toContain('AAAA');
  });

  it('labels a bash result with its command', () => {
    const store = new ToolResultBlobStore();
    const handles = store.evictFrom([
      toolUseMsg('tu-1', 'bash', { command: 'npm test' }),
      toolResultMsg('tu-1', 'w'.repeat(5_000)),
    ], T);

    expect(handles[0]!.descriptor).toContain('bash(npm test)');
  });

  it('redacts credential-named query params and URL userinfo', () => {
    // `maskSecretPatterns` alone catches only vendor-shaped tokens; an opaque
    // `?access_token=<random>` and `https://user:pw@host` both passed through it.
    const store = new ToolResultBlobStore();
    const messages: BetaMessageParam[] = [
      toolUseMsg('tu-0', 'http_request', { url: 'https://api.example.com/v1?access_token=abcdefghijklmnopqrstuvwxyz012345' }),
      toolResultMsg('tu-0', 'a'.repeat(5_000)),
      toolUseMsg('tu-1', 'http_request', { url: 'https://admin:Hunter2Secret@internal.corp/data' }),
      toolResultMsg('tu-1', 'b'.repeat(5_000)),
      toolUseMsg('tu-2', 'http_request', { url: 'https://x.de/?sig=0123456789abcdef0123456789abcdef' }),
      toolResultMsg('tu-2', 'c'.repeat(5_000)),
    ];

    const [d0, d1, d2] = store.evictFrom(messages, T).map(h => h.descriptor);

    expect(d0).toContain('access_token=***');
    expect(d0).not.toContain('abcdefghijklmnop');
    expect(d1).not.toContain('Hunter2Secret');
    expect(d1).toContain('internal.corp');
    expect(d2).toContain('sig=***');
  });

  it('matches credential param names by WORD, not by substring', () => {
    // A substring test redacts `?design=`, `?assignee=` and `?signal_strength=`
    // because all three contain "sig" — destroying exactly the useful labels
    // this descriptor exists to provide. Both directions are pinned here.
    const store = new ToolResultBlobStore();
    const keep = ['design=modern', 'assignee=rafael', 'signal_strength=7', 'sort_key=name', 'category=authors'];
    const redact = ['sig=abc123', 'signature=abc123', 'api_key=abc123', 'access_token=abc123', 'accessToken=abc123', 'key=abc123'];
    const messages: BetaMessageParam[] = [];
    [...keep, ...redact].forEach((qs, i) => {
      messages.push(toolUseMsg(`tu-${i}`, 'http_request', { url: `https://shop.de/?${qs}` }));
      messages.push(toolResultMsg(`tu-${i}`, `${i}-${'k'.repeat(5_000)}`));
    });

    const descriptors = store.evictFrom(messages, T).map(h => h.descriptor);

    keep.forEach((qs, i) => {
      expect(descriptors[i], `${qs} must stay readable`).toContain(qs);
    });
    redact.forEach((qs, i) => {
      const d = descriptors[keep.length + i]!;
      expect(d, `${qs} must be redacted`).toContain('=***');
      expect(d).not.toContain('abc123');
    });
  });

  it('masks a vendor token that is not in a query param', () => {
    const store = new ToolResultBlobStore();
    const handles = store.evictFrom([
      toolUseMsg('tu-1', 'bash', { command: 'curl -H "Authorization: Bearer sk-ant-abcdefghijklmnopqrstuvwx"' }),
      toolResultMsg('tu-1', 'd'.repeat(5_000)),
    ], T);

    expect(handles[0]!.descriptor).not.toContain('sk-ant-abcdefghijklmnopqrstuvwx');
  });

  it('drops the argument when one blob is reused by a DIFFERENT call', () => {
    // Dedup maps two calls onto one blob. Keeping the first call's URL would
    // label the handle with a URL it did not come from — a confidently wrong
    // label is worse than none.
    const store = new ToolResultBlobStore();
    const same = wrapped('Nicht gefunden');
    const first = store.evictFrom([
      toolUseMsg('tu-1', 'http_request', { url: 'https://a.de/x' }),
      toolResultMsg('tu-1', same),
    ], T);
    const second = store.evictFrom([
      toolUseMsg('tu-2', 'http_request', { url: 'https://b.de/y' }),
      toolResultMsg('tu-2', same),
    ], T);

    expect(second[0]!.id).toBe(first[0]!.id);
    expect(first[0]!.descriptor).toContain('https://a.de/x');
    expect(second[0]!.descriptor).not.toContain('a.de');
    expect(second[0]!.descriptor).toContain('http_request result');
  });

  it('keeps the argument when the SAME call is re-evicted', () => {
    const store = new ToolResultBlobStore();
    const same = wrapped('Stabil');
    const msgs = [toolUseMsg('tu-1', 'read_file', { path: '/etc/app.conf' }), toolResultMsg('tu-1', same)];
    const first = store.evictFrom(msgs, T);
    const second = store.evictFrom(msgs, T);

    expect(second[0]!.descriptor).toBe(first[0]!.descriptor);
    expect(second[0]!.descriptor).toContain('/etc/app.conf');
  });

  it('truncates an over-long argument but keeps its head', () => {
    const store = new ToolResultBlobStore();
    const handles = store.evictFrom([
      toolUseMsg('tu-1', 'http_request', { url: `https://example.com/${'p'.repeat(400)}` }),
      toolResultMsg('tu-1', 'v'.repeat(5_000)),
    ], T);

    expect(handles[0]!.descriptor).toContain('https://example.com/ppp');
    expect(handles[0]!.descriptor).not.toContain('p'.repeat(200));
    expect(handles[0]!.descriptor.length).toBeLessThan(300);
  });

  it('degrades to the bare tool label for inputs with no usable key', () => {
    const store = new ToolResultBlobStore();
    const cases: Array<[string, unknown]> = [
      ['tu-0', { limit: 50 }],           // no identifying key
      ['tu-1', null],                     // null input
      ['tu-2', ['a', 'b']],               // array input
      ['tu-3', { url: 42 }],              // non-string value
      ['tu-4', { url: '   ' }],           // blank value
    ];
    const messages: BetaMessageParam[] = [];
    for (const [id, input] of cases) {
      messages.push(toolUseMsg(id, 'memory_list', input));
      messages.push(toolResultMsg(id, `${id}-${'u'.repeat(5_000)}`));
    }

    for (const h of store.evictFrom(messages, T)) {
      expect(h.descriptor).toContain('memory_list result');
      expect(h.descriptor).not.toContain('memory_list(');
    }
  });
});

describe('collapseIn — in-place parking under context pressure', () => {
  /** Read the string payload of the first tool_result block of a message. */
  function resultTextOf(msg: BetaMessageParam): string {
    const content = msg.content;
    if (typeof content === 'string') return content;
    const block = content.find(b => b.type === 'tool_result');
    if (!block || block.type !== 'tool_result') return '';
    return typeof block.content === 'string' ? block.content : '';
  }

  it('replaces an oversized payload with a stub naming its recall id', () => {
    const store = new ToolResultBlobStore();
    const big = 'z'.repeat(50_000);
    const messages: BetaMessageParam[] = [
      toolUseMsg('tu-1', 'http_request', { url: 'https://api.example.com/contacts' }),
      toolResultMsg('tu-1', big),
      // Tail padding so the collapsed pair is not protected by skipTail.
      toolUseMsg('tu-2', 'read_file'),
      toolResultMsg('tu-2', 'small'),
    ];

    const { handles, freedChars } = store.collapseIn(messages, T, 2);

    expect(handles).toHaveLength(1);
    const id = handles[0]!.id;
    const text = resultTextOf(messages[1]!);
    // The stub is the ONLY place the model learns the handle exists, so the id
    // must appear in the exact shape recall_tool_result takes.
    expect(text).toContain(`recall_tool_result`);
    expect(text).toContain(`"${id}"`);
    expect(text).not.toContain(big);
    expect(text.length).toBeLessThan(1_000);
    expect(freedChars).toBeGreaterThan(49_000);
    // ...and the payload is still retrievable, i.e. parked, not discarded.
    expect(store.get(id)!.payload).toBe(big);
  });

  it('preserves tool_use_id and is_error on the collapsed block', () => {
    const store = new ToolResultBlobStore();
    const messages: BetaMessageParam[] = [
      toolUseMsg('tu-1', 'http_request'),
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tu-1',
          content: 'e'.repeat(20_000),
          is_error: true,
        }],
      },
      toolUseMsg('tu-2', 'read_file'),
      toolResultMsg('tu-2', 'small'),
    ];

    store.collapseIn(messages, T, 2);

    const content = messages[1]!.content;
    expect(Array.isArray(content)).toBe(true);
    const block = (content as Array<{ type: string; tool_use_id?: string; is_error?: boolean }>)[0]!;
    // Dropping either field breaks the tool_use↔tool_result pairing the API
    // validates on every request — a 400 that bricks the whole thread.
    expect(block.tool_use_id).toBe('tu-1');
    expect(block.is_error).toBe(true);
  });

  it('leaves the newest turns untouched so the model does not re-fetch at once', () => {
    const store = new ToolResultBlobStore();
    const big = 'q'.repeat(30_000);
    const messages: BetaMessageParam[] = [
      toolUseMsg('tu-1', 'http_request'),
      toolResultMsg('tu-1', big),
      toolUseMsg('tu-2', 'http_request'),
      toolResultMsg('tu-2', big + 'tail'),
    ];

    const { handles } = store.collapseIn(messages, T, 2);

    expect(handles).toHaveLength(1);
    expect(resultTextOf(messages[1]!)).not.toContain(big);
    // The last pair is the exchange the model is reasoning about right now.
    expect(resultTextOf(messages[3]!)).toBe(big + 'tail');
  });

  it('leaves payloads at or below the threshold alone', () => {
    const store = new ToolResultBlobStore();
    const messages: BetaMessageParam[] = [
      toolUseMsg('tu-1', 'read_file'),
      toolResultMsg('tu-1', 'y'.repeat(1_000)),
      toolUseMsg('tu-2', 'read_file'),
      toolResultMsg('tu-2', 'small'),
    ];

    const { handles, freedChars } = store.collapseIn(messages, T, 2);

    expect(handles).toHaveLength(0);
    expect(freedChars).toBe(0);
    expect(resultTextOf(messages[1]!)).toBe('y'.repeat(1_000));
  });

  it('collapses BOTH copies of a duplicate payload onto one blob', () => {
    const store = new ToolResultBlobStore();
    const big = 'd'.repeat(40_000);
    const messages: BetaMessageParam[] = [
      toolUseMsg('tu-1', 'http_request', { url: 'https://a.example/x' }),
      toolResultMsg('tu-1', big),
      toolUseMsg('tu-2', 'http_request', { url: 'https://b.example/x' }),
      toolResultMsg('tu-2', big),
      toolUseMsg('tu-3', 'read_file'),
      toolResultMsg('tu-3', 'small'),
    ];

    const { handles } = store.collapseIn(messages, T, 2);

    // One stored blob, but BOTH resident copies must shrink — freeing only the
    // first would leave the duplicate bytes riding every subsequent turn.
    expect(store.size).toBe(1);
    expect(handles).toHaveLength(2);
    expect(resultTextOf(messages[1]!)).not.toContain(big);
    expect(resultTextOf(messages[3]!)).not.toContain(big);
  });

  it('mints handles through the same path as evictFrom (shared dedup index)', () => {
    const store = new ToolResultBlobStore();
    const big = 's'.repeat(30_000);
    const collapsed: BetaMessageParam[] = [
      toolUseMsg('tu-1', 'http_request'),
      toolResultMsg('tu-1', big),
      toolUseMsg('tu-2', 'read_file'),
      toolResultMsg('tu-2', 'small'),
    ];
    const { handles: first } = store.collapseIn(collapsed, T, 2);

    // The same payload arriving again at compaction time must reuse the blob
    // rather than mint a second one — the two entry points share `park`.
    const later: BetaMessageParam[] = [
      toolUseMsg('tu-9', 'http_request'),
      toolResultMsg('tu-9', big),
    ];
    const second = store.evictFrom(later, T);

    expect(second[0]!.id).toBe(first[0]!.id);
    expect(store.size).toBe(1);
  });
});
