import { describe, it, expect } from 'vitest';
import { REPORT_MAX_DEPTH, TargetAnswerTooSlow, TargetDidNotAnswer, askTarget, isConnectionFailure, capText, discardBody, durationText, readTargetBody, readTargetJson, relayedReport, relayedText } from './migration-target-reply.js';

/** A response whose body is `parts`, then either ends or stays open; `cancelled` says whether it was let go. */
function streamed(parts: string[], end = true): { res: Response; state: { cancelled: boolean } } {
  const state = { cancelled: false };
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) { for (const p of parts) c.enqueue(enc.encode(p)); if (end) c.close(); },
    cancel() { state.cancelled = true; },
  });
  return { res: new Response(body), state };
}

describe('the source reads a target answer up to its cap and its deadline', () => {
  it('returns a body at the cap, and null one byte over it, letting go of the rest', async () => {
    expect(await readTargetBody(streamed(['ab', 'cd']).res, 4)).toBe('abcd');
    const over = streamed(['ab', 'cde'], false);
    expect(await readTargetBody(over.res, 4)).toBeNull();
    expect(over.state.cancelled).toBe(true);
  });

  it('reads an answer without a body as an empty text', async () => {
    expect(await readTargetBody(new Response(null, { status: 204 }), 4)).toBe('');
  });

  it('gives up on a body that does not finish within the deadline', async () => {
    const slow = streamed(['ab'], false);
    await expect(readTargetBody(slow.res, 1024, 50)).rejects.toThrow('did not finish its answer within 0.05 seconds');
    expect(slow.state.cancelled).toBe(true);
    // Control: the same body, finished, is read.
    expect(await readTargetBody(streamed(['ab']).res, 1024, 50)).toBe('ab');
  });

  it('reads JSON, or fails with the caller\'s words for a body too large, too slow or not JSON', async () => {
    const fail = (w: string): string => `failed: ${w}`;
    expect(await readTargetJson(streamed(['{"a":', '1}']).res, 64, fail)).toEqual({ a: 1 });
    await expect(readTargetJson(streamed(['{"a":1}']).res, 3, fail)).rejects.toThrow(/^failed: large$/);
    await expect(readTargetJson(streamed(['{"a"'], false).res, 64, fail, 50)).rejects.toThrow(/^failed: slow$/);
    await expect(readTargetJson(streamed(['nope \u202e']).res, 64, fail)).rejects.toThrow(/^failed: format$/);
    await expect(readTargetBody(streamed(['a'], false).res, 64, 50)).rejects.toBeInstanceOf(TargetAnswerTooSlow);
  });

  it('names a cap in KiB below 1 MiB and in MiB from there', () => {
    expect(capText(64 * 1024)).toBe('64 KiB');
    expect(capText(8 * 1024 * 1024)).toBe('8 MiB');
  });

  it('reads an unneeded small answer to its end, and lets go of one that does not end', async () => {
    const small = streamed(['{"ok":true}']);
    await discardBody(small.res, 50);
    expect(small.res.bodyUsed).toBe(true);
    expect(small.state.cancelled).toBe(false);
    const endless = streamed(['{}'], false);
    await discardBody(endless.res, 50);
    expect(endless.state.cancelled).toBe(true);
  });

  it('counts a read that rejects once the deadline cancelled it as too slow, not as broken', async () => {
    // A body whose pending read rejects on cancel, as some transports do, instead of ending.
    let rejectRead: (e: Error) => void = () => undefined;
    const res = { body: { getReader: () => ({
      read: () => new Promise((_resolve, reject) => { rejectRead = reject; }),
      cancel: async () => { rejectRead(new Error('cancelled')); },
    }) } } as unknown as Response;
    await expect(readTargetBody(res, 64, 50)).rejects.toBeInstanceOf(TargetAnswerTooSlow);
  });

  it('calls a read that the connection breaks off broken, not slow and not format', async () => {
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{"a"')); c.error(new Error('other side closed')); } });
    await expect(readTargetJson(new Response(body), 64, (w) => `failed: ${w}`)).rejects.toThrow(/^failed: broken$/);
  });

  it('gives up on a target that does not start answering within the request\'s deadline', async () => {
    const silent = (_url: string, init: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    await expect(askTarget(silent, 'https://t.example/x', {}, 50)).rejects.toBeInstanceOf(TargetDidNotAnswer);
    // Control: an answer in time is returned, and its body is not cut by that deadline.
    const quick = async (): Promise<Response> => new Response('ok');
    expect(await (await askTarget(quick, 'https://t.example/x', {}, 50)).text()).toBe('ok');
    // Another failure stays what it is.
    await expect(askTarget(async () => { throw new Error('refused'); }, 'https://t.example/x', {}, 50)).rejects.toThrow('refused');
  });

  it('tells a failing connection from the network guard\'s own refusal', () => {
    expect(isConnectionFailure(Object.assign(new Error('connect ECONNREFUSED 203.0.113.7:443'), { code: 'ECONNREFUSED' }))).toBe(true);
    expect(isConnectionFailure(new Error('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }) }))).toBe(true);
    expect(isConnectionFailure(new Error('socket hang up'))).toBe(true);
    expect(isConnectionFailure(new Error('Blocked: private address'))).toBe(false);
    expect(isConnectionFailure('ECONNRESET')).toBe(false);
  });

  it('names a deadline in seconds below two minutes and in minutes from there', () => {
    expect(durationText(30_000)).toBe('30 seconds');
    expect(durationText(119_000)).toBe('119 seconds');
    expect(durationText(15 * 60_000)).toBe('15 minutes');
  });
});

describe('the target\'s words are shown without what would not display as itself', () => {
  const hidden: Array<[string, string]> = [
    ['C0 and DEL', '\u0000\u0007\u001b\u007f'],
    ['C1', '\u0085\u009b'],
    ['bidi embeddings, overrides, isolates and marks', '‪‫‬‭‮⁦⁧⁨⁩‎‏؜'],
    ['zero-width characters and the byte order mark', '​‌‍⁠﻿'],
    ['invisible operators and deprecated format characters', '⁡⁢⁣⁤⁪⁯'],
    ['soft hyphen, Mongolian vowel separator, interlinear annotation', '­᠎￹￺￻'],
    ['tag characters', '\u{e0001}\u{e0041}\u{e007f}'],
    ['variation selectors and fillers', '️\u{e0100}͏ᅟㅤﾠ'],
  ];
  for (const [what, chars] of hidden) {
    it(`removes ${what}`, () => {
      expect(relayedText(`a${chars}b`)).toBe('ab');
    });
  }

  it('turns line breaks, tabs and the line and paragraph separators into spaces', () => {
    expect(relayedText('a\r\nb\tc d e')).toBe('a  b c d e');
  });

  it('keeps ordinary text in any script as it is', () => {
    const text = 'Zürich — 東京 — Ελλάδα — مرحبا — The target instance refused: "x" <y> & z';
    expect(relayedText(text)).toBe(text);
  });

  it('cuts at the given number of characters and marks the cut, counting characters, not code units', () => {
    expect(relayedText('😀'.repeat(3), 2)).toBe('😀😀…');
    expect(relayedText('😀'.repeat(2), 2)).toBe('😀😀');
  });

  it('follows a restore report only to a fixed depth, so a nested one cannot exhaust the stack', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 2_000_000; i++) deep = [deep];
    expect(() => relayedReport(deep)).not.toThrow();
    let at = relayedReport(deep);
    for (let i = 0; i < REPORT_MAX_DEPTH; i++) { expect(Array.isArray(at)).toBe(true); at = (at as unknown[])[0]; }
    expect(at).toBeNull();
    // Control: a real report, two levels deep, comes through whole.
    expect(relayedReport({ a: { b: ['c'] } })).toEqual({ a: { b: ['c'] } });
  });

  it('cleans every string of a restore report, its keys included, and leaves the rest as it is', () => {
    expect(relayedReport({ secretsImported: 3, configApplied: true, portableDirSkipped: ['work‮space/a\nb'], 'k​': null }))
      .toEqual({ secretsImported: 3, configApplied: true, portableDirSkipped: ['workspace/a b'], k: null });
  });
});
