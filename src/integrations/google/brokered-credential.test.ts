import { describe, it, expect } from 'vitest';
import { GoogleAuth } from './google-auth.js';

/**
 * A brokered tenant holds no client pair — the control plane mints and refreshes
 * its tokens (PRD Stage 1 §3.2). The object still exists, because the claim
 * needs somewhere to put the tokens; what must not exist is a path that talks to
 * Google's OAuth endpoints AS this app without a credential.
 *
 * The pair is optional in the TYPE rather than behind a `brokered: true` flag,
 * which is why the compiler enumerated these sites instead of a grep: seven
 * uses across five methods, all of them self-host.
 */
function brokered(): GoogleAuth {
  return new GoogleAuth({});
}

describe('a brokered GoogleAuth refuses every self-host OAuth entry point', () => {
  it('startRedirectAuth refuses by name', () => {
    // MUTATION THIS KILLS: drop the requireOwnPair guard — the call would build
    // a consent URL carrying `client_id=undefined` and hand it to the user.
    expect(() => brokered().startRedirectAuth('https://x/cb')).toThrow(/own Google client pair/);
  });

  it('exchangeRedirectCode refuses by name', async () => {
    await expect(brokered().exchangeRedirectCode('code', 'https://x/cb')).rejects.toThrow(/own Google client pair/);
  });

  it('startLocalAuth refuses by name', async () => {
    await expect(brokered().startLocalAuth()).rejects.toThrow(/own Google client pair/);
  });

  it('startDeviceFlow refuses by name', async () => {
    await expect(brokered().startDeviceFlow()).rejects.toThrow(/own Google client pair/);
  });

  it('the refusal says what to do instead, not just what failed', () => {
    // The message is read by whoever is debugging a tenant, not by the model.
    // MUTATION THIS KILLS: replacing it with a bare `throw new Error('no pair')`.
    let msg = '';
    try { brokered().startRedirectAuth('https://x/cb'); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain('control plane');
    expect(msg).toContain('managed claim flow');
  });

  it('an instance WITH a pair still reaches those paths — the guard is not unconditional', () => {
    // MUTATION THIS KILLS: throwing regardless of the pair, which would make
    // every test above pass and self-host OAuth dead.
    const own = new GoogleAuth({ clientId: 'id', clientSecret: 'secret' });
    const { authUrl } = own.startRedirectAuth('https://x/cb');
    expect(authUrl).toContain('client_id=id');
  });
});
