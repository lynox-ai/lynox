/**
 * The harness is a measuring instrument, so the thing worth testing is not
 * "does it classify a block correctly" — it is "does it stay silent when it
 * is broken". Before this module, it did: a broken gate call threw, the catch
 * turned the message into the tool result, and the judge read every channel as
 * blocked. A perfect score, measured from nothing.
 *
 * Case 4 is therefore the load-bearing one. Cases 1-3 exist so the fix cannot
 * be "abort on everything", which would trade a silent instrument for one that
 * dies on ordinary adversarial input.
 */
import { describe, it, expect, vi } from 'vitest';
import type { HostPolicyContext } from '../../../src/core/network-guard.js';

const assertHostPolicy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/core/network-guard.js', () => ({ assertHostPolicy }));

const { probeHostPolicy, HarnessInstrumentError } = await import('./host-policy-probe.js');

const CTX: HostPolicyContext = {
  networkPolicy: 'guarded',
  allowedHosts: undefined,
  allowedWildcards: [],
  enforceHttps: false,
};

describe('probeHostPolicy', () => {
  it('reports allowed when the gate does not throw', () => {
    assertHostPolicy.mockImplementation(() => undefined);
    expect(probeHostPolicy('https://ok.example', 'discovery', CTX)).toEqual({ kind: 'allowed' });
  });

  it('reports blocked, with the real message, on a policy rejection', () => {
    assertHostPolicy.mockImplementation(() => {
      throw new Error('Blocked: hostname "evil.example" not permitted under guarded egress policy');
    });
    const out = probeHostPolicy('https://evil.example', 'full-control', CTX);
    expect(out.kind).toBe('blocked');
    expect(out.kind === 'blocked' && out.message).toContain('not permitted under guarded');
  });

  it('treats a malformed URL as blocked, not as breakage', () => {
    // A model under injection will emit an unparseable URL sooner or later.
    // Nothing can egress to a URL that does not exist, so this is a block —
    // aborting here would kill a run on an ordinary adversarial input.
    assertHostPolicy.mockImplementation(() => {
      const e = new TypeError('Invalid URL') as NodeJS.ErrnoException;
      e.code = 'ERR_INVALID_URL';
      throw e;
    });
    const out = probeHostPolicy('http://[bad', 'discovery', CTX);
    expect(out.kind).toBe('blocked');
  });

  it('THROWS when the gate fails in a way that is not a policy decision', () => {
    // This is what a changed signature looks like from in here. The old shape
    // returned this as the tool result and the judge scored it as "blocked".
    assertHostPolicy.mockImplementation(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'has')");
    });
    expect(() => probeHostPolicy('https://ok.example', 'discovery', CTX))
      .toThrow(HarnessInstrumentError);
  });

  it('names the cause in the abort, so the next reader is not left guessing', () => {
    assertHostPolicy.mockImplementation(() => { throw new TypeError('surface is not a string'); });
    expect(() => probeHostPolicy('https://ok.example', 'discovery', CTX))
      .toThrow(/signature changed|surface is not a string/);
  });
});
