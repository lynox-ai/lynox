import { describe, expect, it } from 'vitest';
import { inArrivalOrder } from './thread-key.js';
import type { MailEnvelope } from './provider.js';

function env(name: string, uid: number, arrivedAt: Date | undefined, date: Date = new Date('2026-11-20T09:00:00Z')): MailEnvelope {
  return {
    uid, messageId: `<${name}@x>`, folder: 'INBOX', threadKey: 'gmail:t', inReplyTo: undefined,
    from: [{ address: 'a@example.org' }], to: [], cc: [], replyTo: [], subject: name, date,
    ...(arrivedAt !== undefined ? { arrivedAt } : {}),
    flags: [], snippet: '', hasAttachments: false, attachmentCount: 0, sizeBytes: 0, isAutoReply: false,
  };
}
const names = (list: ReadonlyArray<MailEnvelope>): string[] => list.map((e) => e.subject);
const at = (minute: number): Date => new Date(Date.UTC(2026, 10, 20, 9, minute));

describe('inArrivalOrder', () => {
  it('orders a newest-first list by server arrival, oldest first, on a copy', () => {
    const list = [env('c', 3, at(3)), env('b', 2, at(2)), env('a', 1, at(1))];
    expect(names(inArrivalOrder(list))).toEqual(['a', 'b', 'c']);
    expect(names(list), 'the input is not changed').toEqual(['c', 'b', 'a']);
  });

  it('ignores the Date header: a mail its sender dated back does not move ahead', () => {
    const backdated = env('late', 9, at(5), new Date('2020-01-01T00:00:00Z'));
    const early = env('early', 8, at(1), at(1));
    expect(names(inArrivalOrder([backdated, early]))).toEqual(['early', 'late']);
  });

  it('breaks a tie of the same arrival by uid', () => {
    expect(names(inArrivalOrder([env('b', 12, at(1)), env('a', 11, at(1))]))).toEqual(['a', 'b']);
  });

  it('same arrival: a mail held from an earlier poll (uid 0) comes before one listed now (uid > 0)', () => {
    const held = env('held', 0, at(1));
    const listed = env('listed', 42, at(1));
    expect(names(inArrivalOrder([listed, held]))).toEqual(['held', 'listed']);
    expect(names(inArrivalOrder([held, listed]))).toEqual(['held', 'listed']);
  });

  it('a mail without an arrival keeps its place; the dated ones are sorted among the other places', () => {
    const list = [env('c', 3, at(3)), env('x', 9, undefined), env('a', 1, at(1)), env('b', 2, at(2))];
    expect(names(inArrivalOrder(list))).toEqual(['a', 'x', 'b', 'c']);
  });
});
