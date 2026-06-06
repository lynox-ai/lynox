import { describe, it, expect, vi } from 'vitest';
import { RunBuffer, RunBufferManager, DEFAULT_RUN_BUFFER_CAP } from './run-buffer.js';
import type { StreamEvent } from '../types/tools.js';

function textEvent(text: string): StreamEvent {
  return { type: 'text', text, agent: 'main' };
}

describe('RunBuffer', () => {
  it('append assigns monotonic seqs starting at 1 and returns them', () => {
    const buf = new RunBuffer();
    expect(buf.append(textEvent('a'))).toBe(1);
    expect(buf.append(textEvent('b'))).toBe(2);
    expect(buf.currentSeq()).toBe(2);
  });

  it('replaySince returns only events strictly newer than `since`', () => {
    const buf = new RunBuffer();
    buf.append(textEvent('a')); // seq 1
    buf.append(textEvent('b')); // seq 2
    buf.append(textEvent('c')); // seq 3
    expect(buf.replaySince(1).map((e) => e.seq)).toEqual([2, 3]);
    expect(buf.replaySince(0).map((e) => e.seq)).toEqual([1, 2, 3]); // since=0 → whole ring
    expect(buf.replaySince(3)).toEqual([]); // since>=tip → nothing to replay
  });

  it('ring drops oldest past capacity but keeps seqs monotonic', () => {
    const buf = new RunBuffer(3);
    for (let i = 0; i < 5; i++) buf.append(textEvent(`e${i}`)); // seqs 1..5, cap 3
    expect(buf.replaySince(0).map((e) => e.seq)).toEqual([3, 4, 5]); // oldest two dropped
    expect(buf.oldestSeq()).toBe(3);
    expect(buf.currentSeq()).toBe(5);
  });

  it('subscribe fans out future appends and unsubscribe stops them', () => {
    const buf = new RunBuffer();
    const seen: number[] = [];
    const unsub = buf.subscribe((e) => seen.push(e.seq));
    buf.append(textEvent('a')); // seq 1 → delivered
    buf.append(textEvent('b')); // seq 2 → delivered
    unsub();
    buf.append(textEvent('c')); // seq 3 → NOT delivered (unsubscribed)
    expect(seen).toEqual([1, 2]);
    expect(buf.subscriberCount).toBe(0);
  });

  it('replay-then-subscribe yields the full ordered stream with no gap or dupe', () => {
    const buf = new RunBuffer();
    buf.append(textEvent('a')); // seq 1 (already buffered before subscribe)
    buf.append(textEvent('b')); // seq 2
    const delivered: number[] = [];
    // Endpoint pattern: replay since 0, then subscribe for the tail.
    for (const e of buf.replaySince(0)) delivered.push(e.seq);
    buf.subscribe((e) => delivered.push(e.seq));
    buf.append(textEvent('c')); // seq 3 → live tail
    expect(delivered).toEqual([1, 2, 3]);
  });

  it('end() notifies end-subscribers, stops appends, and clears subscribers', () => {
    const buf = new RunBuffer();
    const onEnd = vi.fn();
    const onEvent = vi.fn();
    buf.subscribe(onEvent, onEnd);
    buf.end();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(buf.ended).toBe(true);
    expect(buf.subscriberCount).toBe(0);
    // A late append after completion is dropped (no resurrection).
    const seqBefore = buf.currentSeq();
    expect(buf.append(textEvent('late'))).toBe(seqBefore);
    expect(buf.currentSeq()).toBe(seqBefore);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('subscribing to an already-ended buffer fires onEnd asynchronously', async () => {
    const buf = new RunBuffer();
    buf.end();
    const onEnd = vi.fn();
    buf.subscribe(() => {}, onEnd);
    expect(onEnd).not.toHaveBeenCalled(); // queued, not sync
    await Promise.resolve();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('a throwing subscriber does not break the fan-out to others', () => {
    const buf = new RunBuffer();
    const good: number[] = [];
    buf.subscribe(() => { throw new Error('boom'); });
    buf.subscribe((e) => good.push(e.seq));
    buf.append(textEvent('a'));
    expect(good).toEqual([1]);
  });

  it('default capacity is large enough not to drop a typical run', () => {
    const buf = new RunBuffer();
    for (let i = 0; i < DEFAULT_RUN_BUFFER_CAP; i++) buf.append(textEvent('x'));
    expect(buf.oldestSeq()).toBe(1); // nothing dropped at exactly cap
    expect(buf.replaySince(0)).toHaveLength(DEFAULT_RUN_BUFFER_CAP);
  });

  // S1/D-S1: the buffer only ever holds StreamEvents. secret_prompt/ask_secret
  // are NOT StreamEvents (separate value-free handler path), so a secret value
  // is unrepresentable here. This test documents the type-level invariant by
  // asserting every buffered entry is a known safe StreamEvent type.
  it('only buffers StreamEvent types — never a secret-bearing prompt', () => {
    const buf = new RunBuffer();
    buf.append({ type: 'tool_call', name: 'http_request', input: { url: 'x' }, agent: 'main' });
    buf.append({ type: 'tool_result', name: 'http_request', result: 'ok', agent: 'main' });
    const types = buf.replaySince(0).map((e) => e.event.type);
    expect(types).toEqual(['tool_call', 'tool_result']);
    expect(types).not.toContain('secret_prompt');
  });
});

describe('RunBufferManager', () => {
  it('create/get/remove manage per-run buffers', () => {
    const mgr = new RunBufferManager();
    const a = mgr.create('run-a');
    const b = mgr.create('run-b');
    expect(mgr.get('run-a')).toBe(a);
    expect(mgr.size).toBe(2);
    mgr.remove('run-a');
    expect(mgr.get('run-a')).toBeUndefined();
    expect(a.ended).toBe(true); // remove ends the buffer
    expect(b.ended).toBe(false);
    expect(mgr.size).toBe(1);
  });

  it('remove is idempotent', () => {
    const mgr = new RunBufferManager();
    mgr.create('run-a');
    mgr.remove('run-a');
    expect(() => mgr.remove('run-a')).not.toThrow();
    expect(mgr.size).toBe(0);
  });
});
