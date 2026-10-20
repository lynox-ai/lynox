import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn() },
}));

import dns from 'node:dns/promises';
import { fetchPinned, setPinnedTransportForTests } from './network-guard.js';
import { runInCallSlot, type CallSlot } from './call-connection.js';

// `CallSlot.contactedNetwork` decides whether a call's grant enters the conversation's set
// (PRD connection-attribution A5): set only once a request is past every refusal that sends
// nothing, so a request refused there adds nothing.

const lookupAs = (address: string): void => {
  vi.mocked(dns.lookup).mockResolvedValue([{ address, family: 4 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>);
};

let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });

async function contacted(url: string): Promise<{ slot: CallSlot; sent: number }> {
  let sent = 0;
  restore = setPinnedTransportForTests(async () => { sent++; return new Response('ok'); });
  const slot: CallSlot = {};
  await runInCallSlot(slot, () => fetchPinned(url)).catch(() => undefined);
  return { slot, sent };
}

describe('fetchPinned marks the call as one that reached the network', () => {
  it('a request that goes out', async () => {
    lookupAs('93.184.216.34');
    const { slot, sent } = await contacted('https://api.example.com/v1');
    expect(sent).toBe(1);
    expect(slot.contactedNetwork).toBe(true);
  });

  it('not a request refused for its protocol', async () => {
    const { slot, sent } = await contacted('ftp://api.example.com/file');
    expect(sent).toBe(0);
    expect(slot.contactedNetwork).toBeUndefined();
  });

  it('not a request to a Shopify store, which this engine never sends', async () => {
    lookupAs('93.184.216.34');
    const { slot, sent } = await contacted('https://some-shop.myshopify.com/admin/api/orders.json');
    expect(sent).toBe(0);
    expect(slot.contactedNetwork).toBeUndefined();
  });

  it('not a request whose host resolves to a private address', async () => {
    lookupAs('10.0.0.5');
    const { slot, sent } = await contacted('https://intranet.example.com/');
    expect(sent).toBe(0);
    expect(slot.contactedNetwork).toBeUndefined();
  });
});
