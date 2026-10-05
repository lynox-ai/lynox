/**
 * Where an OAuth authorization may send the user — as code, not as data.
 *
 * The authorize host is the security boundary of the redirect flow: whoever
 * sets it decides which site receives the user and their consent. So it comes
 * from here, a frozen constant compiled into the engine, and from nothing else.
 * A profile names a preset id and its parameters; it does NOT name a host.
 *
 * ⚠ Deliberately NOT like its neighbour. The suggested-APIs catalogue can be
 * switched off with an env var (`api-store.ts`,
 * `formatSuggestedApisForSystemPrompt`). That is right for a list of hints the
 * model may read, and wrong here: a file is an operator-editable input, and on
 * a compromised instance an attacker-editable one. There is no file, no env var
 * and no registration function for presets — if you are adding one, you are
 * moving the boundary, and that belongs in a decision, not in a patch.
 *
 * ⚠ Until 2026-09-30 the sentence above named the catalogue's own file as the
 * contrast, because it had one: `data/suggested-apis.json`, read at boot. It is
 * a compiled constant now ({@link ./suggested-apis.ts}) — but it moved because
 * that file never reached the container, NOT because anyone showed a file was
 * unsafe for it. So do not read the move as this paragraph's argument winning a
 * second case. The argument itself is unchanged, and so is the ranking it
 * draws, which is the part that matters here: a preset decides which site a
 * user is sent to and hands consent to, enforced by host validation below; a
 * hint is text the model must ask about before acting on.
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
  /**
   * Scopes every authorization through this preset asks for, whatever the profile says —
   * e.g. the one a provider needs before it issues a refresh token.
   */
  readonly requiredScopes: readonly string[];
  /**
   * The scopes a profile may add, as an enumerated allowlist. Anything not named here or in
   * `requiredScopes` is refused, including a scope the provider introduces later: a profile is
   * written by the agent, so this list, not the profile, is the limit of what can be asked for.
   */
  readonly allowedScopes: readonly string[];
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
 * An entry is a statement about which sites we send users to, and that is a
 * product decision, not a build one: nothing here can be connected that nobody
 * has vouched for. Each entry names its source.
 */
const REGISTER_ENTRIES: readonly OAuthPreset[] = Object.freeze([
  {
    // Decided 2026-10-05 as the first provider. Endpoints from bexio's OpenID discovery
    // document (https://auth.bexio.com/realms/bexio/.well-known/openid-configuration, read
    // 2026-10-05): issuer https://auth.bexio.com/realms/bexio, PKCE S256 supported.
    id: 'bexio',
    label: 'bexio',
    host: { kind: 'constant', host: 'auth.bexio.com' },
    authorizePath: '/realms/bexio/protocol/openid-connect/auth',
    tokenPath: '/realms/bexio/protocol/openid-connect/token',
    params: [],
    // bexio issues a refresh token only for `offline_access`; without it the access token
    // cannot be renewed. `openid` is the protocol scope of its OpenID Connect endpoint.
    requiredScopes: ['openid', 'offline_access'],
    // Read access to business records only, and only scopes the discovery document lists.
    // Write scopes are a separate decision, and so are payroll records.
    allowedScopes: [
      'email', 'profile',
      'contact_show', 'lead_show', 'note_show', 'task_show', 'project_show', 'article_show',
      'kb_offer_show', 'kb_order_show', 'kb_delivery_show', 'kb_invoice_show', 'kb_credit_voucher_show',
      'kb_bill_show', 'kb_expense_show', 'kb_article_order_show',
      'bank_account_show', 'bank_payment_show', 'transaction_show', 'archive_show',
    ],
  },
]);
const BACKING = new Map(REGISTER_ENTRIES.map((p) => [p.id, Object.freeze(p)] as const));

export const OAUTH_PRESETS: PresetRegister = Object.freeze({
  get: (id: string): OAuthPreset | undefined => BACKING.get(id),
  ids: (): string[] => [...BACKING.keys()].sort(),
});

/** What a derivation refused, in a form the caller can turn into a message. */
/**
 * Why there are FOUR of these and not three: `bad-preset` names a defect in a
 * compiled preset, and it is a different failure from a profile whose value was
 * refused — different author, different way out, different sentence. While both
 * arrived as `bad-param` carrying a synthesised pseudo-parameter, every consumer
 * turned them into the same advice, and for a preset whose path lacks a leading
 * slash that advice read "set auth.oauth.preset_params.path" — a field that does
 * not exist, about a defect the operator cannot fix. A union member costs a
 * branch; a pseudo-parameter costs a sentence that cannot be followed.
 */
export type PresetDerivationError =
  | { readonly kind: 'unknown-preset'; readonly presetId: string }
  | { readonly kind: 'missing-param'; readonly param: OAuthPresetParam }
  | { readonly kind: 'bad-param'; readonly param: OAuthPresetParam; readonly value: string }
  | { readonly kind: 'bad-preset'; readonly detail: string };

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
      return { kind: 'bad-preset', detail: `its host template names the parameter "${preset.host.param}", which the preset does not declare` };
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
    return { kind: 'bad-preset', detail: 'the host it builds is not a valid host name' };
  }
  if (parsed.hostname !== host || parsed.username !== '' || parsed.password !== '') {
    return { kind: 'bad-preset', detail: 'the host it builds is not the host a URL parser reads back from it' };
  }
  // The FQDN root dot, refused separately because the identity check above
  // cannot see it. Every other odd spelling of a host dies there by being
  // NORMALISED — `127.1`, `2130706433`, `0177.0.0.1`, `LOCALHOST` and
  // `127.0.0.1.` all come back from the parser as something else, so they no
  // longer equal what went in. A trailing dot on a NAME is the exception: the
  // parser preserves `localhost.` and `shop.local.` byte for byte, and every
  // predicate downstream compares strings — `=== 'localhost'` misses it,
  // `/\.local$/` misses it. One spelling, one boundary, refused where the
  // others already die.
  if (host.endsWith('.')) {
    return { kind: 'bad-preset', detail: 'the host it builds ends in a root dot, which every check downstream reads as a different host' };
  }

  // The paths are appended and the result parsed AGAIN, so `host` is read off the
  // URL the user will actually be sent to rather than off the string that went
  // into it. A path CAN move the host, and the first measurement of this said it
  // could not — because it only tried shapes with a leading slash. Without one,
  // the appended text merges into the authority: `@evil.example/x` parses with
  // hostname `evil.example`, and `:8080@evil.example/x` does the same. So both
  // halves stay: the leading slash is required below, and the assembled URL is
  // re-parsed here, because a preset author is the one writing these strings.
  // A path that does not start with `/` is not a path — it joins the authority.
  if (!preset.authorizePath.startsWith('/') || !preset.tokenPath.startsWith('/')) {
    return { kind: 'bad-preset', detail: 'one of its paths does not start with a slash, so it would merge into the host instead of following it' };
  }
  const authorizeUrl = `https://${parsed.hostname}${preset.authorizePath}`;
  const tokenUrl = `https://${parsed.hostname}${preset.tokenPath}`;
  let authorizeParsed: URL;
  try {
    authorizeParsed = new URL(authorizeUrl);
  } catch {
    return { kind: 'bad-preset', detail: 'the authorize address it builds is not a valid URL' };
  }
  // No comparison against `parsed.hostname` here, and that is deliberate: with
  // the leading slash required above, the authority is already committed and the
  // two can no longer differ — a comparison would be a branch that cannot fire,
  // which is worse than no branch because it reads as a guard. The re-parse stays
  // because `host` should be read off the URL that is handed out.
  return {
    host: authorizeParsed.hostname,
    authorizeUrl,
    tokenUrl,
  };
}

/**
 * What a profile may write in `auth.oauth.preset_id`, as ONE definition.
 *
 * It lives here rather than beside the validator that enforces it, because two
 * places need to agree and a second copy is not an agreement: a test asserting
 * that every shipped id matches its own copy of this pattern stays green while
 * the validator tightens underneath it — and then every profile naming that
 * provider becomes unsaveable, which is the failure the test was written for.
 *
 * It also does a second job that is easy to lose: it refuses a vault reference
 * without mentioning one. A reference needs `secret:` followed by an uppercase
 * letter, and this class admits neither a colon nor an uppercase letter, so
 * loosening it reopens that hole silently. Two tests hold the line.
 */
export const PRESET_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/** The scopes to ask for, or the ones that are not allowed. */
export type PresetScopeResult =
  | { readonly scopes: readonly string[] }
  | { readonly refused: readonly string[] };

/**
 * The scopes an authorization through `preset` asks for: its required scopes, plus what the
 * profile names (`auth.oauth.scope`, space-separated). A named scope that is in neither of the
 * preset's two lists refuses the whole request rather than being dropped, so a profile cannot
 * hold a scope it will never get without being told. Used for the authorize link and for the
 * refresh, so both ask for the same set.
 */
export function presetScopeRequest(preset: OAuthPreset, profileScope: string | undefined): PresetScopeResult {
  const asked = (profileScope ?? '').split(/\s+/).filter((s) => s !== '');
  const refused = asked.filter((s) => !preset.requiredScopes.includes(s) && !preset.allowedScopes.includes(s));
  if (refused.length > 0) return { refused: [...new Set(refused)] };
  return { scopes: [...new Set([...preset.requiredScopes, ...asked])] };
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
