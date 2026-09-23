import { describe, it, expect } from 'vitest';

import { checkRedirectTarget } from './oauth-redirect-guard.js';
import type { CustomEndpointAck } from './llm/endpoint-allowlist.js';

/**
 * One branch of this guard is unreachable from either of its two callers, and
 * that is the only reason this file exists: both of them pass endpoints that
 * came out of a successful parse, so the URL here cannot throw for them. The
 * type does not promise that — `PresetEndpoints` is a shape, not a proof — and
 * a fail-closed default nobody can reach is indistinguishable from one that
 * fails open until something asks it.
 *
 * Everything else the guard decides is exercised through the route decision and
 * through `api_setup connect`, where it is the real path rather than a third
 * copy of the same table.
 */
describe('a target the URL parser refuses is treated as inside the network', () => {
  it('refuses an unparseable authorize URL rather than reading an empty host as public', () => {
    const decision = checkRedirectTarget(
      { host: 'provider.example.com', authorizeUrl: 'not-an-address', tokenUrl: 'not-an-address' },
      { accepted: true, hosts: ['provider.example.com'], accepted_at: '2026-09-22T00:00:00.000Z' },
    );

    // What decides is the address the browser would actually be sent to, and
    // there isn't one. The fixture carries an ack naming the host the endpoints
    // CLAIM, which is the shape a caller would hand in — but measured, that ack
    // cannot influence this outcome either way: the acceptance check parses the
    // same unparseable URL and returns false. An earlier version of this comment
    // said "the ack would have said yes", which is the kind of sentence that
    // reads as a measurement and is not one. The mutant still dies here —
    // deleting the empty-host arm turns this into `no-egress-ack`.
    expect(decision?.kind).toBe('inside-network');
  });

  it.each([
    ['loopback', 'https://localhost./authorize'],
    ['an on-premise name', 'https://shop.local./authorize'],
  ])('reads %s with a root dot as the host it actually is', (_label, authorizeUrl) => {
    // The derivation refuses this spelling too, so neither caller can reach
    // here with one. This function is exported and its argument is a shape, not
    // a proof — and the dot is the one spelling `new URL` preserves byte for
    // byte, so `=== 'localhost'` and `/\.local$/` both miss it. Tested here
    // rather than only through a caller, because the two fixes would otherwise
    // hide each other: delete either one alone and something still stays red.
    const decision = checkRedirectTarget(
      { host: 'provider.example.com', authorizeUrl, tokenUrl: authorizeUrl },
      { accepted: true, hosts: [], redirect_hosts: ['localhost.', 'shop.local.'], accepted_at: '2026-09-22T00:00:00.000Z' },
    );

    // The acceptance names the host exactly, which is what makes this a test of
    // the network rule rather than of the consent rule.
    expect(decision?.kind).toBe('inside-network');
  });

  it('refuses an acceptance whose own flag says it was not given', () => {
    // `accepted` is typed as the literal `true`, so this shape cannot be
    // written by hand — but the ack is stored, rides a migration and is read
    // back from disk, where a type promises nothing. Nothing covered the check
    // until a mutation removed it and the whole suite stayed green.
    const decision = checkRedirectTarget(
      { host: 'shops.example.com', authorizeUrl: 'https://shops.example.com/authorize', tokenUrl: 'https://shops.example.com/token' },
      { accepted: false, hosts: [], redirect_hosts: ['shops.example.com'], accepted_at: '2026-09-22T00:00:00.000Z' } as unknown as CustomEndpointAck,
    );

    expect(decision?.kind).toBe('no-egress-ack');
  });

  it.each([
    ['one root dot', 'https://localhost./authorize'],
    ['two of them', 'https://localhost../authorize'],
    ['an on-premise name with two', 'https://shop.local../authorize'],
  ])('reads a host with %s as the host it actually is', (_label, authorizeUrl) => {
    // The first version stripped ONE dot, which turned `localhost..` into
    // `localhost.` — precisely the spelling the strip exists to remove. A
    // measurement, not a guess: the URL parser hands `localhost..` back
    // unchanged, so nothing downstream normalises it either.
    const decision = checkRedirectTarget(
      { host: 'provider.example.com', authorizeUrl, tokenUrl: authorizeUrl },
      { accepted: true, hosts: [], redirect_hosts: ['localhost.', 'localhost..', 'shop.local..'], accepted_at: '2026-09-22T00:00:00.000Z' },
    );

    expect(decision?.kind).toBe('inside-network');
  });

  it.each([
    ['a string where a list belongs', 'shop.example.com'],
    ['a number', 7],
    ['an object', { 0: 'shop.example.com' }],
  ])('refuses when redirect_hosts is %s', (_label, redirectHosts) => {
    // A stored ack is JSON, not a type: profiles are read back as
    // `JSON.parse(…) as ApiProfile` with nothing checking the shape. The string
    // case is the dangerous one and it fails OPEN without this — `includes` on
    // a string is a SUBSTRING test, so an ack naming `shop.example.com` answers
    // yes for `p.example.com`. The number case threw a TypeError out of the
    // guard, which is neither an allow nor a refusal.
    const decision = checkRedirectTarget(
      { host: 'p.example.com', authorizeUrl: 'https://p.example.com/authorize', tokenUrl: 'https://p.example.com/token' },
      { accepted: true, hosts: [], redirect_hosts: redirectHosts, accepted_at: '2026-09-22T00:00:00.000Z' } as unknown as CustomEndpointAck,
    );

    expect(decision?.kind).toBe('no-egress-ack');
  });

  it('lets an ordinary public host through, so the dot is what decides', () => {
    const decision = checkRedirectTarget(
      { host: 'shops.example.com', authorizeUrl: 'https://shops.example.com/authorize', tokenUrl: 'https://shops.example.com/token' },
      { accepted: true, hosts: [], redirect_hosts: ['shops.example.com'], accepted_at: '2026-09-22T00:00:00.000Z' },
    );

    expect(decision).toBeNull();
  });
});
