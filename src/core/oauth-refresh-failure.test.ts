import { describe, it, expect } from 'vitest';
import { classifyRefreshFailure, reclassifyForeignGrant, revokedGrantMessage, tokenFingerprint } from './oauth-refresh-failure.js';

describe('classifyRefreshFailure — the three kinds, by token-endpoint error code', () => {
  it.each([
    [400, { error: 'invalid_grant' }, 'grant-revoked'],
    [401, { error: 'invalid_client' }, 'client-misconfigured'],
    [400, { error: 'unauthorized_client' }, 'client-misconfigured'],
    [401, { error: 'deleted_client' }, 'client-misconfigured'],
    [400, { error: 'invalid_request' }, 'transient'],
    [400, { error: 'unsupported_grant_type' }, 'transient'],
    [400, { message: 'no error field' }, 'transient'],
  ] as const)('HTTP %i %j → %s', (status, body, kind) => {
    expect(classifyRefreshFailure(status, JSON.stringify(body))).toBe(kind);
  });

  it('reads the status before the body: a 5xx or 429 is transient even if it names invalid_grant', () => {
    expect(classifyRefreshFailure(503, JSON.stringify({ error: 'invalid_grant' }))).toBe('transient');
    expect(classifyRefreshFailure(500, JSON.stringify({ error: 'invalid_client' }))).toBe('transient');
    expect(classifyRefreshFailure(429, JSON.stringify({ error: 'invalid_grant' }))).toBe('transient');
    // The boundary below 500 is not transient by status alone.
    expect(classifyRefreshFailure(499, JSON.stringify({ error: 'invalid_grant' }))).toBe('grant-revoked');
  });

  it('never declares a grant dead on a body it cannot parse', () => {
    expect(classifyRefreshFailure(400, '<html>proxy error</html>')).toBe('transient');
  });
});

describe('reclassifyForeignGrant — revocation or the wrong client', () => {
  it('keeps a revocation when the presenting client minted the token', () => {
    expect(reclassifyForeignGrant('grant-revoked', 'client-1', 'client-1')).toBe('grant-revoked');
  });
  it('turns it into a client problem when a different client minted the token', () => {
    expect(reclassifyForeignGrant('grant-revoked', 'client-OLD', 'client-1')).toBe('client-misconfigured');
  });
  it.each([
    [undefined, 'client-1'],
    ['client-1', undefined],
    ['', 'client-1'],
  ])('keeps a revocation when either id is unknown (%j, %j)', (minted, presented) => {
    expect(reclassifyForeignGrant('grant-revoked', minted, presented)).toBe('grant-revoked');
  });
  it('leaves every other kind alone', () => {
    expect(reclassifyForeignGrant('transient', 'a', 'b')).toBe('transient');
    expect(reclassifyForeignGrant('client-misconfigured', 'a', 'a')).toBe('client-misconfigured');
  });
});

describe('tokenFingerprint', () => {
  it('is 16 hex characters, stable for a token and different between tokens', () => {
    const fp = tokenFingerprint('rt-1');
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(tokenFingerprint('rt-1')).toBe(fp);
    expect(tokenFingerprint('rt-2')).not.toBe(fp);
    expect(fp).not.toContain('rt-1');
  });
});

describe('revokedGrantMessage', () => {
  it('names the profile, the slot to refill, and that fetching again cannot help', () => {
    const text = revokedGrantMessage('crm-api', 'CRM_API_REFRESH_TOKEN', '2026-09-22T00:00:00.000Z');
    expect(text).toContain('api_profile "crm-api"');
    expect(text).toContain('(recorded 2026-09-22T00:00:00.000Z)');
    expect(text).toContain('"CRM_API_REFRESH_TOKEN" with ask_secret');
    expect(text).toContain('fetch_token will not resend it');
  });
});
