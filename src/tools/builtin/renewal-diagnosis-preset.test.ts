import { describe, it, expect } from 'vitest';
import { OAUTH_PRESETS, builtInPresetOf, presetNotFollowed, presetRegisterOf } from '../../core/oauth-presets.js';
import { declinedFacts, oauthGrantIsUserDelegated, oauthRenewalDeclinedDiagnosis } from './http.js';
import type { ApiProfile } from '../../core/api-store.js';

/** A profile on bexio's API host; `auth` is what each case varies. */
function onBexio(auth: ApiProfile['auth'], over: Partial<ApiProfile> = {}): ApiProfile {
  return { id: 'books', name: 'Books', base_url: 'https://api.bexio.com/2.0', description: 'd', auth, ...over };
}

describe('builtInPresetOf: the one answer to "which built-in provider does this profile go through"', () => {
  it('pins bexio in the real register, so the cases below are about the rule and not a missing preset', () => {
    expect(OAUTH_PRESETS.get('bexio')?.id).toBe('bexio');
  });

  it('answers the provider for an oauth2 profile that names a preset the register knows', () => {
    expect(builtInPresetOf({ auth: { type: 'oauth2', oauth: { preset_id: 'bexio' } } })?.id).toBe('bexio');
  });

  it('answers none for a static-credential profile that still carries a preset_id', () => {
    // The shape the three copies disagreed on: two checked auth.type, the renewal gate did not.
    expect(builtInPresetOf({ auth: { type: 'bearer', oauth: { preset_id: 'bexio' } } })).toBeUndefined();
    expect(builtInPresetOf({ auth: { oauth: { preset_id: 'bexio' } } })).toBeUndefined();
  });

  it('answers none for an id the register does not know, and for one that is not a string', () => {
    expect(builtInPresetOf({ auth: { type: 'oauth2', oauth: { preset_id: 'not-a-provider' } } })).toBeUndefined();
    expect(builtInPresetOf({ auth: { type: 'oauth2', oauth: { preset_id: 5 as never } } })).toBeUndefined();
    expect(builtInPresetOf({ auth: { type: 'oauth2', oauth: {} } })).toBeUndefined();
    expect(builtInPresetOf({})).toBeUndefined();
  });

  it('asks the register it is handed, not the built-in one', () => {
    const bexio = OAUTH_PRESETS.get('bexio')!;
    const own = presetRegisterOf([{ ...bexio, id: 'own-books' }]);
    expect(builtInPresetOf({ auth: { type: 'oauth2', oauth: { preset_id: 'own-books' } } }, own)?.id).toBe('own-books');
    expect(builtInPresetOf({ auth: { type: 'oauth2', oauth: { preset_id: 'bexio' } } }, own)).toBeUndefined();
  });
});

describe('the three places that ask it give one answer', () => {
  it('the renewal gate reads a static-credential profile with a stray preset_id as no user\'s grant', () => {
    expect(oauthGrantIsUserDelegated({ auth: { type: 'bearer', oauth: { preset_id: 'bexio' } } })).toBe(false);
    expect(oauthGrantIsUserDelegated({ auth: { type: 'oauth2', oauth: { preset_id: 'bexio' } } })).toBe(true);
    // The engine-written record still counts on its own.
    expect(oauthGrantIsUserDelegated({ auth: { type: 'bearer' }, oauth_grant: { origin: 'callback' } })).toBe(true);
  });

  it('presetNotFollowed still finds a static-credential profile on a provider\'s host, preset_id or not', () => {
    expect(presetNotFollowed(onBexio({ type: 'bearer', oauth: { preset_id: 'bexio' } } as never))?.id).toBe('bexio');
    expect(presetNotFollowed(onBexio({ type: 'oauth2', oauth: { preset_id: 'bexio' } }))).toBeUndefined();
  });
});

describe('the declined-renewal diagnosis names the provider when that is the reason', () => {
  const appOnly = (over: Partial<ApiProfile> = {}): ApiProfile => onBexio(
    { type: 'oauth2', vault_keys: [], oauth: { preset_id: 'bexio', grant_type: 'client_credentials' } },
    over,
  );

  it('a built-in provider\'s profile without a callback record: the consent fact carries the provider', () => {
    expect(declinedFacts(appOnly(), 'empty')[0]).toEqual({ kind: 'consent', consent: 'preset', preset: 'bexio' });
    expect(oauthRenewalDeclinedDiagnosis(appOnly(), 'empty')).toMatch(
      /^no consent flow is recorded behind it, but it goes through the built-in provider "bexio", whose tokens only a user's authorization issues; /,
    );
  });

  it('a callback record outranks the preset: a user authorized it', () => {
    expect(declinedFacts(appOnly({ oauth_grant: { origin: 'callback' } }), 'empty')[0])
      .toEqual({ kind: 'consent', consent: 'callback', preset: undefined });
  });

  it('neither: an id the register does not know names no provider, and the clause stays as it was', () => {
    const unknown = onBexio({ type: 'oauth2', vault_keys: [], oauth: { preset_id: 'not-a-provider' } });
    expect(declinedFacts(unknown, 'empty')[0]).toEqual({ kind: 'consent', consent: 'none', preset: undefined });
    expect(oauthRenewalDeclinedDiagnosis(unknown, 'empty')).toMatch(/^no consent flow is recorded behind it; /);
    expect(oauthRenewalDeclinedDiagnosis(unknown, 'empty')).not.toContain('not-a-provider');
  });
});
