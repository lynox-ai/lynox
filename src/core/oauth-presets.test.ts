import { describe, it, expect } from 'vitest';
import {
  OAUTH_PRESETS,
  derivePresetEndpoints,
  presetIds,
  presetRegisterOf,
  type OAuthPreset,
} from './oauth-presets.js';

// Two presets that exercise both host rules. They live here, not in the
// shipped register: what the engine offers is a product decision, and a test
// that needs an entry brings its own.
const CONSTANT: OAuthPreset = {
  id: 'example-constant',
  label: 'Example',
  host: { kind: 'constant', host: 'auth.example.com' },
  authorizePath: '/oauth/authorize',
  tokenPath: '/oauth/token',
  params: [],
};

const TEMPLATED: OAuthPreset = {
  id: 'example-shop',
  label: 'Example Shop',
  host: { kind: 'template', param: 'shop', template: '{shop}.shops.example.com' },
  authorizePath: '/admin/oauth/authorize',
  tokenPath: '/admin/oauth/access_token',
  params: [{ name: 'shop', pattern: /[a-z0-9][a-z0-9-]{0,59}/, describe: 'the shop name' }],
};

const REGISTER = presetRegisterOf([CONSTANT, TEMPLATED]);

describe('the preset register is frozen, and the freeze is the boundary', () => {
  it('ships empty until a provider is decided', () => {
    // An empty register refuses every connect, which is the honest state while
    // nobody has vouched for a provider. If this ever fails, someone added a
    // preset — that is a decision, and it belongs in the register of decisions,
    // not in a passing test.
    expect(presetIds()).toEqual([]);
  });

  it('hands out no map, so no cast can add a provider at runtime', () => {
    // The hole this closes: `ReadonlyMap` is a compile-time promise over a real
    // Map, and `(OAUTH_PRESETS as Map<string, OAuthPreset>).set(…)` would have
    // registered a provider from any module with the type system satisfied.
    const asRecord = OAUTH_PRESETS as unknown as Record<string, unknown>;
    expect(typeof asRecord['set']).toBe('undefined');
    expect(typeof asRecord['delete']).toBe('undefined');
    expect(typeof asRecord['clear']).toBe('undefined');
  });

  it('refuses a property added to it', () => {
    expect(Object.isFrozen(OAUTH_PRESETS)).toBe(true);
    // ESM runs in strict mode, so the assignment throws rather than failing
    // silently — which is what makes this a boundary and not a hope.
    expect(() => {
      (OAUTH_PRESETS as unknown as Record<string, unknown>)['evil'] = { id: 'evil' };
    }).toThrow();
    expect(presetIds()).toEqual([]);
  });

  it('exports no way to register a preset at runtime', async () => {
    // Every export is a type, the frozen register, a pure derivation, or the
    // test-seam builder. A future `registerPreset(...)` would show up here and
    // has to be argued for, not slipped in.
    const module = await import('./oauth-presets.js');
    expect(Object.keys(module).sort()).toEqual(
      ['OAUTH_PRESETS', 'derivePresetEndpoints', 'presetIds', 'presetRegisterOf'].sort(),
    );
  });

  it('keeps a register a caller built to itself', () => {
    // The seam is a parameter. Passing one must not reach the shipped register
    // — otherwise a test would widen production.
    expect(presetIds(REGISTER)).toEqual(['example-constant', 'example-shop']);
    expect(presetIds()).toEqual([]);
  });
});

describe('derivation happens at use, from the register alone', () => {
  it('derives both URLs for a constant host', () => {
    expect(derivePresetEndpoints('example-constant', undefined, REGISTER)).toEqual({
      host: 'auth.example.com',
      authorizeUrl: 'https://auth.example.com/oauth/authorize',
      tokenUrl: 'https://auth.example.com/oauth/token',
    });
  });

  it('substitutes exactly one parameter into a templated host', () => {
    expect(derivePresetEndpoints('example-shop', { shop: 'acme' }, REGISTER)).toEqual({
      host: 'acme.shops.example.com',
      authorizeUrl: 'https://acme.shops.example.com/admin/oauth/authorize',
      tokenUrl: 'https://acme.shops.example.com/admin/oauth/access_token',
    });
  });

  it('refuses a preset id that is not in the register', () => {
    expect(derivePresetEndpoints('example-other', undefined, REGISTER)).toEqual({
      kind: 'unknown-preset',
      presetId: 'example-other',
    });
  });

  it('refuses a missing parameter instead of building half a host', () => {
    const out = derivePresetEndpoints('example-shop', {}, REGISTER);
    expect(out).toEqual({ kind: 'missing-param', param: TEMPLATED.params[0] });
  });

  it.each([
    ['a different site smuggled in', 'acme.evil.com'],
    ['a path', 'acme/../evil'],
    ['a port', 'acme:8443'],
    ['userinfo', 'user@evil.com'],
    ['an uppercase host', 'ACME'],
    ['a leading dot', '.acme'],
    ['a fragment', 'acme#x'],
    ['a query', 'acme?x=1'],
    ['a space', 'ac me'],
  ])('refuses %s as a parameter value', (_label, value) => {
    const out = derivePresetEndpoints('example-shop', { shop: value }, REGISTER);
    expect(out).toMatchObject({ kind: 'bad-param', value });
  });

  it('anchors the pattern even when the preset author forgot to', () => {
    // The register is code, but code is written by people. An unanchored
    // pattern accepts a prefix, and a prefix is a different site.
    const sloppy = presetRegisterOf([{
      ...TEMPLATED,
      params: [{ name: 'shop', pattern: /[a-z]+/, describe: 'the shop name' }],
    }]);
    expect(derivePresetEndpoints('example-shop', { shop: 'acme.evil.com' }, sloppy))
      .toMatchObject({ kind: 'bad-param' });
  });

  it('refuses a template that carries more than a host', () => {
    // The second reader of the derived host: a preset whose template holds a
    // path or a port builds a string that is not a hostname, and the URL parser
    // is what notices. The pattern above cannot — it only sees the parameter.
    const withPath = presetRegisterOf([{
      ...CONSTANT, host: { kind: 'template', param: 'shop', template: 'evil.example.com/{shop}' },
      params: [{ name: 'shop', pattern: /[a-z]+/, describe: 'the shop name' }],
    }]);
    expect(derivePresetEndpoints('example-constant', { shop: 'acme' }, withPath))
      .toMatchObject({ kind: 'bad-param' });
  });

  it('treats an empty parameter as missing, whatever the pattern would allow', () => {
    // A pattern that accepts `''` must not let a host be built from nothing.
    const permissive = presetRegisterOf([{
      ...TEMPLATED,
      params: [{ name: 'shop', pattern: /[a-z]*/, describe: 'the shop name' }],
    }]);
    expect(derivePresetEndpoints('example-shop', { shop: '' }, permissive))
      .toMatchObject({ kind: 'missing-param' });
  });

  it('refuses a preset whose host parameter it never declared', () => {
    // Found by mutation: with the placeholder unfilled the host became
    // `.shops.example.com`, and a URL parser accepts that hostname — so neither
    // the pattern nor the parser would have caught it.
    const undeclared = presetRegisterOf([{
      ...TEMPLATED,
      host: { kind: 'template', param: 'store', template: '{store}.shops.example.com' },
      params: [{ name: 'shop', pattern: /[a-z]+/, describe: 'the shop name' }],
    }]);
    expect(derivePresetEndpoints('example-shop', { shop: 'acme', store: 'acme' }, undeclared))
      .toMatchObject({ kind: 'bad-param' });
  });

  it('does not let a parameter value splice the template back into the host', () => {
    // `String.replace` reads `$&`, `$'` and `` $` `` in a replacement STRING as
    // instructions. A permissive preset plus such a value would have assembled a
    // host nobody wrote; a function replacement is not scanned at all.
    const permissive = presetRegisterOf([{
      ...TEMPLATED,
      params: [{ name: 'shop', pattern: /[a-z$'`&]+/, describe: 'the shop name' }],
    }]);
    const out = derivePresetEndpoints('example-shop', { shop: "a$'b" }, permissive);
    expect(out).toMatchObject({ host: "a$'b.shops.example.com" });
  });

  it('refuses a path that would join the authority instead of the path', () => {
    // Measured, and the first measurement was wrong: ten shapes WITH a leading
    // slash all keep the host, so the rule looked unnecessary. Without the slash
    // the appended text merges into the authority — `@evil.example/x` parses with
    // hostname `evil.example`, `:8080@evil.example/x` likewise. The sample had
    // answered a narrower question than the one being asked.
    for (const authorizePath of ['@evil.example/x', ':8080@evil.example/x', 'evil.example']) {
      const moved = presetRegisterOf([{ ...CONSTANT, authorizePath }]);
      expect(derivePresetEndpoints('example-constant', undefined, moved), authorizePath)
        .toMatchObject({ kind: 'bad-param' });
    }
  });

  it('reports the host of the URL it hands out, whatever the path looks like', () => {
    // The other half of the same measurement: WITH a leading slash, ten shapes
    // (`//host`, `/@host`, `\\host`, `/:80@host`, a tab, a fragment) all keep the
    // host, because the origin is written first and the parser commits the
    // authority there. So an odd-looking path is not refused — it is simply a
    // path — and `host` is read off the assembled URL either way.
    const odd = presetRegisterOf([{ ...CONSTANT, authorizePath: '//evil.example/authorize' }]);
    const out = derivePresetEndpoints('example-constant', undefined, odd);

    expect(out).toMatchObject({ host: 'auth.example.com' });
    if ('authorizeUrl' in out) {
      expect(new URL(out.authorizeUrl).hostname).toBe(out.host);
    }
  });

  it('keeps a pattern that only means what it means under its own flags', () => {
    // Re-anchoring used to drop the flags, so a `u`-mode source was re-compiled
    // as a different pattern — quietly, because most sources mean the same thing
    // either way.
    const unicode = presetRegisterOf([{
      ...TEMPLATED,
      params: [{ name: 'shop', pattern: /\p{Ll}+/u, describe: 'the shop name' }],
    }]);
    expect(derivePresetEndpoints('example-shop', { shop: 'acme' }, unicode))
      .toMatchObject({ host: 'acme.shops.example.com' });
    expect(derivePresetEndpoints('example-shop', { shop: 'ACME' }, unicode))
      .toMatchObject({ kind: 'bad-param' });
  });

  it('takes nothing from the profile but the parameters the preset names', () => {
    // A profile carrying its own host, token_url or authorize_url changes
    // nothing: the derivation never looks at them.
    const out = derivePresetEndpoints(
      'example-constant',
      { host: 'evil.com', token_url: 'https://evil.com/t', authorizeUrl: 'https://evil.com/a' },
      REGISTER,
    );
    expect(out).toEqual({
      host: 'auth.example.com',
      authorizeUrl: 'https://auth.example.com/oauth/authorize',
      tokenUrl: 'https://auth.example.com/oauth/token',
    });
  });
});
