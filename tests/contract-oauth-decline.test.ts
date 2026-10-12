/**
 * The Google OAuth decline vocabulary (`src/contract/http.ts`).
 *
 * Pinned as exact lists because they cross a repo boundary: the control plane
 * sends these codes back to the instance, and the web-ui maps each one to a
 * message. A code added on one side only reaches the user as the generic text
 * for a case somebody thought they had explained.
 */
import { describe, it, expect } from 'vitest';
import {
  BROKER_START_FAILURES,
  OAUTH_DECLINE_CODES,
  isOAuthDeclineCode,
} from '../src/contract/http.js';

describe('the start-failure vocabulary', () => {
  it('is exactly the five codes the start route refuses with', () => {
    expect([...BROKER_START_FAILURES]).toEqual([
      'missing_token', 'expired', 'replayed', 'bad_signature', 'instance_unbound',
    ]);
  });
});

describe('the decline vocabulary', () => {
  it('is the start failures plus the two consent-path codes, in that order', () => {
    expect([...OAUTH_DECLINE_CODES]).toEqual([
      'missing_token', 'expired', 'replayed', 'bad_signature', 'instance_unbound',
      'access_denied', 'exchange_failed',
    ]);
  });

  it('has no duplicates: `expired` has two producers and is ONE code', () => {
    expect(new Set(OAUTH_DECLINE_CODES).size).toBe(OAUTH_DECLINE_CODES.length);
  });

  it('isOAuthDeclineCode accepts every member and nothing else', () => {
    for (const code of OAUTH_DECLINE_CODES) expect(isOAuthDeclineCode(code)).toBe(true);
    for (const other of ['admin_policy_enforced', 'ACCESS_DENIED', '', ' expired', undefined, null, 1]) {
      expect(isOAuthDeclineCode(other)).toBe(false);
    }
  });
});
