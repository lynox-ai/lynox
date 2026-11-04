/**
 * The scopes lynox's Google client asks for (`GOOGLE_BROKER_SCOPES`,
 * `src/contract/http.ts`) and the engine's standard set it is judged against.
 *
 * The control plane holds its broker list equal to the vendored copy in its own
 * repo; this side holds `STANDARD_SCOPES` to it, so a change on either side
 * fails a test instead of turning new brokered grants into `legacy`.
 */
import { describe, it, expect } from 'vitest';
import { GOOGLE_BROKER_SCOPES } from '../src/contract/http.js';
import { STANDARD_SCOPES, RESTRICTED_SCOPES, computeScopeMode } from '../src/integrations/google/google-auth.js';

describe('the Google broker scopes in the contract', () => {
  it('are the five Stage 1 scopes, in the order the broker sends them', () => {
    expect([...GOOGLE_BROKER_SCOPES]).toEqual([
      'openid',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.freebusy',
      'https://www.googleapis.com/auth/drive.file',
    ]);
  });

  it('are exactly the engine\'s standard set, so a brokered grant reads as standard', () => {
    expect([...STANDARD_SCOPES]).toEqual([...GOOGLE_BROKER_SCOPES]);
    expect(computeScopeMode([...GOOGLE_BROKER_SCOPES])).toBe('standard');
  });

  it('hold no restricted scope', () => {
    const restricted = new Set<string>(RESTRICTED_SCOPES);
    expect(GOOGLE_BROKER_SCOPES.filter((s) => restricted.has(s))).toEqual([]);
  });
});
