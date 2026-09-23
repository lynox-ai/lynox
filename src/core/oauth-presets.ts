/**
 * Where an OAuth authorization may send the user — as code, not as data.
 *
 * The authorize host is the security boundary of the redirect flow: whoever
 * sets it decides which site receives the user and their consent. So it comes
 * from here, a frozen constant compiled into the engine, and from nothing else.
 * A profile names a preset id and its parameters; it does NOT name a host.
 *
 * ⚠ Deliberately NOT like its neighbour. The suggested-APIs catalogue is read
 * at runtime from `data/suggested-apis.json` in the package root and can be
 * switched off with an env var (`api-store.ts`, `formatSuggestedApis`). That is
 * right for a list of hints the model may read, and wrong here: a file is an
 * operator-editable input, and on a compromised instance an attacker-editable
 * one. There is no file, no env var and no registration function for presets —
 * if you are adding one, you are moving the boundary, and that belongs in a
 * decision, not in a patch.
 *
 * Every function here takes the register as a parameter with the constant as
 * its default, so tests can hand in their own. That is a test seam, not an
 * extension point: production callers pass nothing.
 */

/** One value a preset needs from the profile, e.g. Shopify's shop name. */
export interface OAuthPresetParam {
  /** Field name inside `auth.oauth.preset_params`. */
  readonly name: string;
  /**
   * What the value may look like. Anchored on both ends, because an unanchored
   * pattern accepts a prefix — and a host built from `evil.com#` + a matching
   * tail is a different site than the one the pattern describes.
   */
  readonly pattern: RegExp;
  /** Said to the user when the value is missing or refused. */
  readonly describe: string;
}

/**
 * How the provider's host is decided. Two shapes, both anchored in code:
 * a constant, or a template with exactly ONE parameter substituted into it.
 */
export type OAuthPresetHost =
  | { readonly kind: 'constant'; readonly host: string }
  | {
    readonly kind: 'template';
    /** Name of the parameter substituted for `{param}` in `template`. */
    readonly param: string;
    /** e.g. `{shop}.myshopify.com` — one placeholder, nothing else variable. */
    readonly template: string;
  };

export interface OAuthPreset {
  readonly id: string;
  /** Shown to the user and the model; never parsed. */
  readonly label: string;
  readonly host: OAuthPresetHost;
  /** Path on the derived host, leading slash included. */
  readonly authorizePath: string;
  readonly tokenPath: string;
  readonly params: readonly OAuthPresetParam[];
}

/**
 * What a caller may ask of the register: two questions, no answers written back.
 *
 * NOT a `ReadonlyMap`. That type is a compile-time promise over a runtime `Map`,
 * and one cast re-opens it — `(OAUTH_PRESETS as Map<string, OAuthPreset>).set(…)`
 * would have added a provider at runtime, from any module, with the type system
 * satisfied. The backing map stays private here, and the only way to a different
 * register is to pass one, which is what the tests do.
 */
export interface PresetRegister {
  get(id: string): OAuthPreset | undefined;
  ids(): string[];
}

/**
 * The register itself.
 *
 * It ships empty until the first provider is decided — a preset is a statement
 * about which sites we send users to, and that is a product decision, not a
 * build one. `connect` refuses every profile while it is empty, which is the
 * honest behaviour: nothing can be connected that nobody has vouched for.
 */
const REGISTER_ENTRIES: readonly OAuthPreset[] = Object.freeze([]);
const BACKING = new Map(REGISTER_ENTRIES.map((p) => [p.id, Object.freeze(p)] as const));

export const OAUTH_PRESETS: PresetRegister = Object.freeze({
  get: (id: string): OAuthPreset | undefined => BACKING.get(id),
  ids: (): string[] => [...BACKING.keys()].sort(),
});

/** What a derivation refused, in a form the caller can turn into a message. */
export type PresetDerivationError =
  | { readonly kind: 'unknown-preset'; readonly presetId: string }
  | { readonly kind: 'missing-param'; readonly param: OAuthPresetParam }
  | { readonly kind: 'bad-param'; readonly param: OAuthPresetParam; readonly value: string };

export interface PresetEndpoints {
  readonly host: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
}

/**
 * Derive the two URLs from the register — at every use, not once at save time.
 *
 * A profile can enter the store without passing a save (the boot load, a JSON
 * dropped into the apis directory, a migration), so a check that only runs on
 * save is not a boundary. What the REDIRECT flow uses is derived here every
 * time; the stored `token_url` is still read by `fetch_token`'s own exchange,
 * which is the pre-existing path and not one of these.
 */
export function derivePresetEndpoints(
  presetId: string,
  params: Readonly<Record<string, unknown>> | undefined,
  register: PresetRegister = OAUTH_PRESETS,
): PresetEndpoints | PresetDerivationError {
  const preset = register.get(presetId);
  if (!preset) return { kind: 'unknown-preset', presetId };

  const values = new Map<string, string>();
  for (const spec of preset.params) {
    const raw: unknown = params?.[spec.name];
    // An empty string is missing, whatever the pattern would make of it: a
    // preset whose pattern happens to accept `''` must not build a host from
    // nothing.
    if (typeof raw !== 'string' || raw === '') return { kind: 'missing-param', param: spec };
    // Anchored here as well as in the pattern: a preset author who forgets the
    // anchors should not be able to widen the host by accident. The flags come
    // along — `u` and `v` change what the source MEANS, so re-compiling without
    // them is a different pattern — minus the stateful ones, which would make
    // `test` depend on how often it has been called.
    const flags = spec.pattern.flags.replace(/[gy]/g, '');
    let anchored: RegExp;
    try {
      anchored = new RegExp(`^(?:${spec.pattern.source})$`, flags);
    } catch {
      // A source that only compiles under its own flags, or a `v`-mode set the
      // wrapper breaks: refuse rather than throw, because every caller here is
      // promised a refusal and one of them is a route.
      return { kind: 'bad-param', param: spec, value: raw };
    }
    if (!anchored.test(raw)) return { kind: 'bad-param', param: spec, value: raw };
    values.set(spec.name, raw);
  }

  let host: string;
  if (preset.host.kind === 'constant') {
    host = preset.host.host;
  } else {
    // The substituted parameter has to be one the preset DECLARED, or the
    // template's placeholder stays unfilled and the host ends up with an empty
    // label — `.shops.example.com`, which a URL parser still accepts. Found by
    // mutating the `?? ''` that used to paper over it.
    const value = values.get(preset.host.param);
    if (value === undefined) {
      return { kind: 'bad-param', param: { name: preset.host.param, pattern: /$^/, describe: 'the host parameter, which this preset does not declare' }, value: preset.host.template };
    }
    // A function replacement, not a string: `String.replace` scans a replacement
    // STRING for `$&`, `$'` and friends, so a parameter value carrying them would
    // splice parts of the template back into the host. The pattern would have to
    // allow `$` for that, which no sane preset does — but the preset author is the
    // one who decides that, and this is the line that would pay for it.
    host = preset.host.template.replace(`{${preset.host.param}}`, () => value);
  }

  // The derived host goes through the URL parser, so a template that somehow
  // produced a userinfo, a port or a path is caught here rather than trusted.
  let parsed: URL;
  try {
    parsed = new URL(`https://${host}`);
  } catch {
    return { kind: 'bad-param', param: preset.params[0] ?? { name: 'host', pattern: /.*/, describe: 'the provider host' }, value: host };
  }
  if (parsed.hostname !== host || parsed.username !== '' || parsed.password !== '') {
    return { kind: 'bad-param', param: preset.params[0] ?? { name: 'host', pattern: /.*/, describe: 'the provider host' }, value: host };
  }

  // The paths are appended and the result parsed AGAIN, so `host` is read off the
  // URL the user will actually be sent to rather than off the string that went
  // into it. NOT because a path can move the host — ten shapes were measured
  // (`//host`, `/@host`, `\\host`, `/:80@host`, a tab, a fragment) and none does,
  // since the origin is written first and the parser commits the authority there.
  // It is so that the host the ack is decided on and the host the user is told
  // about are the same object rather than two strings that agree today.
  const authorizeUrl = `https://${parsed.hostname}${preset.authorizePath}`;
  const tokenUrl = `https://${parsed.hostname}${preset.tokenPath}`;
  const badPath = { kind: 'bad-param', param: { name: 'path', pattern: /$^/, describe: 'the provider path, which this preset states' }, value: preset.authorizePath } as const;
  let authorizeParsed: URL;
  let tokenParsed: URL;
  try {
    authorizeParsed = new URL(authorizeUrl);
    tokenParsed = new URL(tokenUrl);
  } catch {
    return badPath;
  }
  if (authorizeParsed.hostname !== parsed.hostname || tokenParsed.hostname !== parsed.hostname) {
    return badPath;
  }

  return {
    host: authorizeParsed.hostname,
    authorizeUrl,
    tokenUrl,
  };
}

/** The ids a profile may name, for a message that lists what exists. */
export function presetIds(register: PresetRegister = OAUTH_PRESETS): string[] {
  return register.ids();
}

/**
 * Build a register for a test. Exported so a test never needs a cast to reach
 * the real one — the seam is a parameter, and this is the thing you pass into
 * it. It carries no path back into {@link OAUTH_PRESETS}.
 */
export function presetRegisterOf(entries: readonly OAuthPreset[]): PresetRegister {
  const map = new Map(entries.map((p) => [p.id, Object.freeze(p)] as const));
  return Object.freeze({
    get: (id: string): OAuthPreset | undefined => map.get(id),
    ids: (): string[] => [...map.keys()].sort(),
  });
}
