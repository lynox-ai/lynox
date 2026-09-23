import { describe, it, expect } from 'vitest';

import { checkRedirectTarget } from './oauth-redirect-guard.js';

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

    // The ack would have said yes — it names the host the endpoints claim. What
    // decides is the address the browser would actually be sent to, and there
    // isn't one.
    expect(decision?.kind).toBe('inside-network');
  });
});
