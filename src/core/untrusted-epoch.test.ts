import { describe, it, expect } from 'vitest';
import { noteAnsweredBy, runInCallSlot, type CallSlot } from './call-connection.js';
import {
  BatchSources, FOREIGN, approvalKey, bumpNow, currentEpoch, isApproved, recordApproval,
  type EpochCounters,
} from './untrusted-epoch.js';

const H = 'api.example.test';

function approvedAt(epoch: number, ...keys: string[]): EpochCounters {
  const c: EpochCounters = { untrustedEpoch: epoch };
  for (const k of keys) recordApproval(c, k, epoch);
  return c;
}

describe('untrusted epoch', () => {
  it('keys an approval by method and normalized host', () => {
    expect(approvalKey('post', 'API.Example.Test.')).toBe(`POST ${H}`);
  });

  it('holds an approval only in the epoch it was given in', () => {
    const c = approvedAt(3, `POST ${H}`);
    expect(isApproved(c, `POST ${H}`, 3)).toBe(true);
    bumpNow(c);
    expect(currentEpoch(c)).toBe(4);
    expect(isApproved(c, `POST ${H}`, 4)).toBe(false);
  });

  it('moves nothing for a batch that saw nothing', () => {
    const c = approvedAt(2, `POST ${H}`);
    new BatchSources().resolve(c, 2);
    expect(currentEpoch(c)).toBe(2);
    expect(isApproved(c, `POST ${H}`, 2)).toBe(true);
  });

  it('keeps the approvals of the one host that answered', () => {
    const c = approvedAt(2, `POST ${H}`, 'PUT other.test');
    const b = new BatchSources();
    b.add({ kind: 'host', host: H });
    b.add({ kind: 'host', host: `${H.toUpperCase()}.` });
    b.resolve(c, 2);
    expect(currentEpoch(c)).toBe(3);
    expect(isApproved(c, `POST ${H}`, 3)).toBe(true);
    expect(isApproved(c, 'PUT other.test', 3)).toBe(false);
  });

  it('keeps nothing once foreign content is in the batch, whatever the order', () => {
    for (const order of [[{ kind: 'host' as const, host: H }, FOREIGN], [FOREIGN, { kind: 'host' as const, host: H }]]) {
      const c = approvedAt(2, `POST ${H}`);
      const b = new BatchSources();
      for (const s of order) b.add(s);
      b.resolve(c, 2);
      expect(isApproved(c, `POST ${H}`, currentEpoch(c))).toBe(false);
    }
  });

  it('keeps nothing when two hosts answered', () => {
    const c = approvedAt(2, `POST ${H}`);
    const b = new BatchSources();
    b.add({ kind: 'host', host: H });
    b.add({ kind: 'host', host: 'other.test' });
    b.resolve(c, 2);
    expect(isApproved(c, `POST ${H}`, currentEpoch(c))).toBe(false);
  });

  it('keeps nothing when the epoch moved during the batch (a sub-agent sharing the counters)', () => {
    const c = approvedAt(2, `POST ${H}`);
    const b = new BatchSources();
    b.add({ kind: 'host', host: H });
    bumpNow(c);
    b.resolve(c, 2);
    expect(currentEpoch(c)).toBe(4);
    expect(isApproved(c, `POST ${H}`, 4)).toBe(false);
  });

  it('does not revive an approval that was stale before the batch', () => {
    const c: EpochCounters = { untrustedEpoch: 5 };
    recordApproval(c, `POST ${H}`, 4);
    const b = new BatchSources();
    b.add({ kind: 'host', host: H });
    b.resolve(c, 5);
    expect(isApproved(c, `POST ${H}`, currentEpoch(c))).toBe(false);
  });

  it('counts an answer as foreign once two different hosts were reported in one call', () => {
    const slot: CallSlot = {};
    runInCallSlot(slot, () => { noteAnsweredBy(H); noteAnsweredBy(H); });
    expect(slot.answeredBy).toBe(H);
    runInCallSlot(slot, () => noteAnsweredBy('other.test'));
    expect(slot.answeredBy).toBeNull();
  });
});
