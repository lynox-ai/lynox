import { describe, it, expect } from 'vitest';
import { noteAnsweredBy, runInCallSlot, type CallSlot } from './call-connection.js';
import {
  BatchSources, FOREIGN, approvalKey, approvalOrigin, bumpNow, currentEpoch, isApproved, recordApproval,
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

  it.each([
    ['https://API.Example.Test./a', H],
    ['https://api.example.test:443/a', H],
    ['http://api.example.test/a', `http://${H}`],
    ['http://api.example.test:80/a', `http://${H}`],
    ['http://API.example.test.:8080/a', `http://${H}:8080`],
    ['https://api.example.test:8443/a', `https://${H}:8443`],
    ['http://[::1]:3000/a', 'http://[::1]:3000'],
  ])('names the service of %s as %s', (url, origin) => {
    expect(approvalOrigin(new URL(url))).toBe(origin);
  });

  it('keeps no approval of the host that answered, on any port or scheme', () => {
    const c = approvedAt(2, `POST https://${H}:8443`, `PUT http://${H}`, 'POST http://other.test:8443');
    const b = new BatchSources();
    b.add({ kind: 'host', host: H });
    b.resolve(c);
    expect(isApproved(c, `POST https://${H}:8443`, 3)).toBe(false);
    expect(isApproved(c, `PUT http://${H}`, 3)).toBe(false);
    expect(isApproved(c, 'POST http://other.test:8443', 3)).toBe(false);
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
    new BatchSources().resolve(c);
    expect(currentEpoch(c)).toBe(2);
    expect(isApproved(c, `POST ${H}`, 2)).toBe(true);
  });

  // The approved host's own answer is content a third party may have written: it voids that
  // host's approvals like any other content, for every write method.
  it.each(['POST', 'PATCH', 'PUT'])('keeps no %s approval when only the approved host answered', (method) => {
    const c = approvedAt(2, `${method} ${H}`);
    const b = new BatchSources();
    b.add({ kind: 'host', host: H });
    b.resolve(c);
    expect(currentEpoch(c)).toBe(3);
    expect(isApproved(c, `${method} ${H}`, 3)).toBe(false);
  });

  it('keeps nothing once foreign content is in the batch, whatever the order', () => {
    for (const order of [[{ kind: 'host' as const, host: H }, FOREIGN], [FOREIGN, { kind: 'host' as const, host: H }]]) {
      const c = approvedAt(2, `POST ${H}`);
      const b = new BatchSources();
      for (const s of order) b.add(s);
      b.resolve(c);
      expect(isApproved(c, `POST ${H}`, currentEpoch(c))).toBe(false);
    }
  });

  it('keeps nothing when two hosts answered', () => {
    const c = approvedAt(2, `POST ${H}`);
    const b = new BatchSources();
    b.add({ kind: 'host', host: H });
    b.add({ kind: 'host', host: 'other.test' });
    b.resolve(c);
    expect(isApproved(c, `POST ${H}`, currentEpoch(c))).toBe(false);
  });

  it('keeps nothing when the epoch moved during the batch (a sub-agent sharing the counters)', () => {
    const c = approvedAt(2, `POST ${H}`);
    const b = new BatchSources();
    b.add({ kind: 'host', host: H });
    bumpNow(c);
    b.resolve(c);
    expect(currentEpoch(c)).toBe(4);
    expect(isApproved(c, `POST ${H}`, 4)).toBe(false);
  });

  it('does not revive an approval that was stale before the batch', () => {
    const c: EpochCounters = { untrustedEpoch: 5 };
    recordApproval(c, `POST ${H}`, 4);
    const b = new BatchSources();
    b.add({ kind: 'host', host: H });
    b.resolve(c);
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
