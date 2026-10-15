/**
 * The Microsoft OAuth decline vocabulary and the handle-only claim
 * (`src/contract/http.ts`).
 *
 * Pinned as exact lists for the reason `contract-oauth-decline.test.ts` gives:
 * the control plane sends these codes, the web-ui maps each to a message, and a
 * code added on one side only reaches the user as the generic text.
 */
import { describe, it, expect } from 'vitest';
import {
  BROKER_START_FAILURES,
  MICROSOFT_OAUTH_DECLINE_CODES,
  OAUTH_DECLINE_CODES,
  isMicrosoftOAuthDeclineCode,
} from '../src/contract/http.js';
import { MIGRATED } from '../src/contract/migrated.js';
import { handleClaimWelds } from '../src/core/oauth-handle-claim-welds.js';

describe('the Microsoft decline vocabulary', () => {
  it('is the start failures, then the address, consent, directory and fallback codes, in that order', () => {
    expect([...MICROSOFT_OAUTH_DECLINE_CODES]).toEqual([
      'missing_token', 'expired', 'replayed', 'bad_signature', 'instance_unbound',
      'no_tenant', 'consumer_domain',
      'access_denied', 'consent_required',
      'not_assigned', 'policy_blocked', 'wrong_tenant',
      'exchange_failed',
    ]);
  });

  it('carries every start failure, so the start route can refuse with one list for both providers', () => {
    for (const code of BROKER_START_FAILURES) expect(MICROSOFT_OAUTH_DECLINE_CODES).toContain(code);
  });

  it('has no duplicates', () => {
    expect(new Set(MICROSOFT_OAUTH_DECLINE_CODES).size).toBe(MICROSOFT_OAUTH_DECLINE_CODES.length);
  });

  it('isMicrosoftOAuthDeclineCode accepts every member and nothing else', () => {
    for (const code of MICROSOFT_OAUTH_DECLINE_CODES) expect(isMicrosoftOAuthDeclineCode(code)).toBe(true);
    for (const other of ['AADSTS50105', 'interaction_required', 'NOT_ASSIGNED', '', ' wrong_tenant', undefined, null, 1]) {
      expect(isMicrosoftOAuthDeclineCode(other)).toBe(false);
    }
  });

  it('leaves the Google vocabulary as it was', () => {
    // The Microsoft list is a superset of the Google one; the reverse must stay false,
    // or a Google card would route on a code its control plane never sends.
    for (const code of OAUTH_DECLINE_CODES) expect(MICROSOFT_OAUTH_DECLINE_CODES).toContain(code);
    for (const code of ['no_tenant', 'consumer_domain', 'consent_required', 'not_assigned', 'policy_blocked', 'wrong_tenant']) {
      expect(OAUTH_DECLINE_CODES as readonly string[]).not.toContain(code);
    }
  });
});

describe('the new symbols are registered as migrated', () => {
  it('names all four, owned by http.ts', () => {
    const rows = MIGRATED.filter((m) => m.contractFile === 'http.ts').map((m) => m.name);
    for (const name of ['OAuthHandleClaimResponse', 'MICROSOFT_OAUTH_DECLINE_CODES', 'MicrosoftOAuthDeclineCode', 'isMicrosoftOAuthDeclineCode']) {
      expect(rows, name).toContain(name);
    }
  });
});

describe('the handle-only claim', () => {
  it('has its compile welds in a file tsc reads', () => {
    // The welds are type-level; this import is what makes deleting their file fail.
    expect(typeof handleClaimWelds).toBe('function');
  });
});
