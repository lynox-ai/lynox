import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:dns/promises', () => ({
  default: {
    lookup: vi.fn(),
  },
}));

import dns from 'node:dns/promises';
import { httpRequestTool } from './http.js';
import { createToolContext } from '../../core/tool-context.js';
import { setPinnedTransportForTests } from '../../core/network-guard.js';
import { OWNER_PRINCIPAL } from '../../core/request-principal.js';
import type { LynoxUserConfig } from '../../types/index.js';

// An IPv6 address that carries a private IPv4 reaches that IPv4 on a network that routes the form
// (a NAT64 gateway, a 6to4 relay). `http_request` refuses it before anything is sent.
describe('http_request refuses an IPv6 address that carries a private IPv4', () => {
  const sent: string[] = [];
  let restore: () => void;

  beforeEach(() => {
    sent.length = 0;
    vi.mocked(dns.lookup).mockReset();
    restore = setPinnedTransportForTests(async (input) => {
      sent.push(input.url);
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    });
  });

  afterEach(() => {
    restore();
  });

  function agent(): never {
    return {
      governingContract: () => ({ contract: undefined, withheld: 'none' }),
      toolContext: createToolContext({} as LynoxUserConfig),
      sessionCounters: { httpRequests: 0, writeBytes: 0 },
      principal: OWNER_PRINCIPAL,
    } as never;
  }

  it.each([
    ['a NAT64 literal', 'http://[64:ff9b::7f00:1]/'],
    ['a 6to4 literal', 'http://[2002:a9fe:a9fe::1]/'],
  ])('refuses %s', async (_label, url) => {
    await expect(httpRequestTool.handler({ url }, agent())).rejects.toThrow('internal network');
    expect(sent).toEqual([]);
  });

  it('refuses a name whose AAAA record is a NAT64 form of loopback', async () => {
    vi.mocked(dns.lookup).mockResolvedValue(
      [{ address: '64:ff9b::7f00:1', family: 6 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>,
    );
    await expect(httpRequestTool.handler({ url: 'http://nat64.example.test/' }, agent())).rejects.toThrow('internal network');
    expect(sent).toEqual([]);
  });

  it('sends to the NAT64 form of a public IPv4 (control)', async () => {
    await httpRequestTool.handler({ url: 'http://[64:ff9b::808:808]/' }, agent());
    expect(sent).toHaveLength(1);
  });
});
