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

/**
 * The words around a preset's customer text on the consent page, in the text's language. Each
 * one is binding customer text like the paragraphs, so it comes from here as approved. Absent,
 * the page keeps its English frame and lists the raw scope ids.
 */
export interface ConsentFrame {
  /** The page title. */
  readonly title: string;
  /** The line before the list of write access. */
  readonly scopesIntro: string;
  /**
   * The line right after that list, saying what a write access covers. Required: the names
   * follow the provider's own breadth ("contacts: write access"), and only this line says
   * what that means.
   */
  readonly scopesNote: string;
  /** The button; clicking it is the confirmation. */
  readonly button: string;
  /** A line after the button, when there is one. */
  readonly afterButton?: string;
}

/** A preset's customer text before a connect that asks for write access. */
export interface ConsentNotice {
  readonly lang: string;
  readonly writeScopes: readonly string[];
  readonly paragraphs: readonly string[];
  readonly frame?: ConsentFrame;
  /**
   * A readable name for each of `writeScopes`, shown in the list instead of the id. Comes
   * with `frame`: a frame in the text's language over raw ids, or names under an English
   * frame, would mix the two (a test holds every preset to that).
   */
  readonly scopeNames?: Readonly<Record<string, string>>;
}

/**
 * What is wrong with a customer text's frame, empty when nothing is: a frame without names or
 * names without a frame, a write scope without a readable name, a name for a scope the text does
 * not cover, two scopes under one name, an empty title, line or button. A test holds every
 * preset to it.
 */
export function consentFrameProblems(notice: ConsentNotice): string[] {
  if (!notice.frame || !notice.scopeNames) {
    return notice.frame || notice.scopeNames ? ['frame and scopeNames come together'] : [];
  }
  const names = notice.scopeNames;
  const frame = notice.frame;
  const named = notice.writeScopes.map((s) => names[s]?.trim()).filter((n): n is string => !!n);
  return [
    ...notice.writeScopes.filter((s) => !names[s]?.trim()).map((s) => `no readable name for ${s}`),
    ...Object.keys(names).filter((s) => !notice.writeScopes.includes(s)).map((s) => `a name for ${s}, which is no write scope of this text`),
    ...(new Set(named).size === named.length ? [] : ['two write scopes share a name']),
    ...(['title', 'scopesIntro', 'scopesNote', 'button'] as const)
      .filter((field) => !frame[field].trim())
      .map((field) => `the frame's ${field} is empty`),
  ];
}

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
  /**
   * The provider reads the value without regard to case. Saving a profile then writes it in
   * lower case, so a name typed as the person sees it is kept rather than refused. The
   * derivation still refuses anything `pattern` does not match.
   */
  readonly caseInsensitive?: true;
}

/**
 * `params` with each value its preset reads without regard to case in lower case. Other names and
 * values are returned as they are; the derivation decides whether they are acceptable.
 */
export function normalizedPresetParams<T extends Readonly<Record<string, unknown>>>(preset: OAuthPreset, params: T): T {
  const out: Record<string, unknown> = { ...params };
  for (const spec of preset.params) {
    const value = out[spec.name];
    // ASCII only: `toLowerCase` maps some non-ASCII letters onto ASCII ones (the Kelvin sign onto
    // `k`), which would turn a value the pattern refuses into one it accepts.
    if (spec.caseInsensitive === true && typeof value === 'string') out[spec.name] = value.replace(/[A-Z]/g, (c) => c.toLowerCase());
  }
  return out as T;
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
  /**
   * The hosts of the provider's API, where its accounts are read and written. A profile on one
   * of them that does not go through this preset is refused when it is saved, and its writes are
   * refused (`presetNotFollowed`): the customer text and the write gate are the preset's, and a
   * profile with a pasted token would write to the same account past both. Required, so a
   * provider added later names its hosts or names none.
   */
  readonly apiHosts: readonly string[];
  /**
   * The provider's API runs on the host the preset derives, one per account (Shopify: the
   * store's `{shop}.myshopify.com`), so every host the template can build is an API host of the
   * provider, and a profile's `base_url` has to be the host its own parameter derives
   * ({@link presetStoreHost}). Only for a `template` host. The store hosts are not in `apiHosts`
   * and `presetNotFollowed` does not claim them: while Shopify is closed, a profile on a store
   * gets the closed text, not a pointer to this preset.
   */
  readonly apiOnDerivedHost?: true;
  /**
   * The path every request carrying the token has to start with, on the store host
   * ({@link apiOnDerivedHost}). Shopify serves more than its Admin API there: `/apps/…` is passed on
   * to a third party's app server, so the token goes to `/admin/` only. Read for a provider on
   * its derived host.
   */
  readonly apiPathPrefix?: string;
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
   * The OpenID Connect issuer of the provider, for a preset whose token endpoint answers with an
   * `id_token`. Set, the connect callback reads the account the person signed in with from that
   * token (`oauth-account.ts`), and only when the token names this issuer. Absent: the account
   * comes from somewhere else or is not known.
   */
  readonly oidcIssuer?: string;
  /**
   * The scopes a profile may add, as an enumerated allowlist. Anything not named here or in
   * `requiredScopes` is refused, including a scope the provider introduces later: a profile is
   * written by the agent, so this list, not the profile, is the limit of what can be asked for.
   */
  readonly allowedScopes: readonly string[];
  /**
   * Scopes a profile must name alongside others: when it names any scope in `when`, it must
   * also name one of `oneOf`. A profile that does not is refused when it is saved, with `why`.
   */
  readonly scopeNeeds?: readonly { readonly when: readonly string[]; readonly oneOf: readonly string[]; readonly why: string }[];
  /**
   * A customer text the person reads before being sent to the provider, when the link asks for
   * any of `writeScopes`. It is binding, so it is shown from here, as approved, and nowhere
   * else: on a page of the connect route, which sends the person on only after they confirm it
   * there (`server/http-api.ts`). Not in the answer to the model, because the model retells.
   */
  readonly consentNotice?: ConsentNotice;
  // The four fields below describe how a provider wants its requests shaped.
  /**
   * How the scopes are to be joined on the authorize link. Absent: a space, as OAuth 2.0 says
   * and as bexio takes them; a provider that documents commas says so here. Read through
   * {@link presetScopeParam}.
   */
  readonly scopeSeparator?: ' ' | ',';
  /**
   * The header the provider reads the access token from, carrying the bare token. Absent:
   * `Authorization: Bearer`. A preset profile cannot choose a header itself: one that names its
   * own `auth.header_name` gets no token attached (`attachEngineManagedAuth` in `http.ts`), so a
   * save cannot point the token at another header. Read through {@link presetTokenHeaderName}.
   */
  readonly tokenHeaderName?: string;
  /**
   * The body of every request to the token endpoint: the code exchange and each refresh.
   * Absent: whatever the profile says, `form` unless it says `json`, as for a profile without a
   * preset. Set by the preset, it wins over the profile: what the provider's token endpoint
   * accepts is a fact about the provider, and the profile is written by the model. Read through
   * {@link presetTokenBodyFormat}.
   */
  readonly tokenBodyFormat?: 'form' | 'json';
  /**
   * A check the callback runs on the provider's redirect before it exchanges the code, on top
   * of the state cookie every preset already has. Absent: none. `shopify-hmac` is
   * {@link ./oauth-callback-hmac.ts}.
   */
  readonly callbackVerification?: 'shopify-hmac';
  /**
   * The provider grants exactly what the link asks for, or less, unless the app at the provider
   * holds more: a grant beyond the ask is then worth saying on the callback page. Absent for a
   * provider that adds scopes of its own to every answer (an identity provider's defaults), where
   * the comparison would say so on every connect.
   */
  readonly compareGrantedScope?: true;
  /**
   * The provider's API version the engine's own requests name, where the provider versions its
   * API in the path. Absent: none. A provider that answers an unknown version with another one
   * (Shopify falls forward to the oldest supported) makes this a pin, not a default.
   */
  readonly adminApiVersion?: string;
}

/** The scope parameter of the authorize link: the scopes, joined the way the preset says. */
export function presetScopeParam(preset: OAuthPreset, scopes: readonly string[]): string {
  return scopes.join(preset.scopeSeparator ?? ' ');
}

/**
 * The header the preset puts the bare token in, or `undefined` for `Authorization: Bearer`.
 */
export function presetTokenHeaderName(preset: OAuthPreset): string | undefined {
  return preset.tokenHeaderName;
}

/**
 * The body format of a request to the preset's token endpoint. The preset's own value first,
 * then the profile's, then `form`; for a preset that sets none this is exactly what a profile
 * without a preset gets.
 */
export function presetTokenBodyFormat(preset: OAuthPreset, profileFormat: 'form' | 'json' | undefined): 'form' | 'json' {
  return preset.tokenBodyFormat ?? profileFormat ?? 'form';
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
    apiHosts: ['api.bexio.com'],
    authorizePath: '/realms/bexio/protocol/openid-connect/auth',
    tokenPath: '/realms/bexio/protocol/openid-connect/token',
    // `issuer` of the same discovery document (read again 2026-10-20).
    oidcIssuer: 'https://auth.bexio.com/realms/bexio',
    params: [],
    // bexio issues a refresh token only for `offline_access`; without it the access token
    // cannot be renewed. `openid` is the protocol scope of its OpenID Connect endpoint.
    requiredScopes: ['openid', 'offline_access'],
    // Read access to business records, and only scopes the discovery document lists. Five
    // write scopes, for contacts, notes, tasks, offers and invoices, and no others. Accounting,
    // bank and payroll stay out entirely, reading included (bills, expenses, bank accounts,
    // payments, transactions, and the file archive, where their documents can lie): the customer text below says lynox does not ask for them, and a
    // test holds this list to it. A scope is asked for only when the profile names it
    // (`presetScopeRequest`), so a profile that names none stays read-only. A write to the
    // account is asked on its own (`http_request`), and no contract grants one, because one of
    // these scopes covers creating, changing, cancelling, booking a payment, issuing and sending
    // alike. That list is our reading: bexio documents each of these five scopes as "Write
    // access to <resource>", with read access to the same resource granted along (docs.bexio.com,
    // API Scopes, read 2026-10-21), and does not say what a write scope leaves out, deleting
    // included. The exception is a bulk run in one of its measured forms, which the person approves
    // as a whole before it starts (`bulk-external.ts`).
    allowedScopes: [
      'email', 'profile',
      'contact_show', 'lead_show', 'note_show', 'task_show', 'project_show', 'article_show',
      'kb_offer_show', 'kb_order_show', 'kb_delivery_show', 'kb_invoice_show', 'kb_credit_voucher_show',
      'kb_article_order_show',
      'contact_edit', 'note_edit', 'task_edit', 'kb_offer_edit', 'kb_invoice_edit',
    ],
    // The question before a write names the contact it concerns (`preset-write-context.ts`),
    // and reading a contact takes a contact scope: a write scope grants reading only its own
    // resource (bexio's scope documentation).
    scopeNeeds: [{
      when: ['note_edit', 'task_edit', 'kb_offer_edit', 'kb_invoice_edit'],
      oneOf: ['contact_show', 'contact_edit'],
      why: 'the question before each write names the contact it concerns, and reading a contact needs one of these',
    }],
    // Customer text, approved 2026-10-14. A change to a word needs a new approval; the test that
    // holds this text byte for byte is the reminder.
    consentNotice: {
      lang: 'de',
      writeScopes: ['contact_edit', 'note_edit', 'task_edit', 'kb_offer_edit', 'kb_invoice_edit'],
      paragraphs: [
        'lynox kann in bexio Kontakte, Notizen, Aufgaben, Offerten und Rechnungen anlegen und ändern, wenn du es beim Verbinden erlaubst. Ohne deine Erlaubnis liest lynox nur. Jeden Schreibschritt zeigt es dir vorher mit allem, was lynox an bexio schickt, und er geschieht erst nach deinem Ja. Das gilt auch, wenn lynox eine Zahlung auf einer Rechnung erfasst oder eine Rechnung storniert.',
        'Die eine Ausnahme ist ein Sammellauf: Du siehst vorher die Liste aller Änderungen und bestätigst den Lauf einmal. Ein Sammellauf ändert nur, was wir bei bexio vorher getestet haben, heute nur bestehende Kontakte. Löschen, verschicken oder ausstellen kann er nicht.',
        'Buchhaltung, Bank und Lohn fasst lynox nicht an; diese Rechte fragt es bei bexio gar nicht an.',
      ],
      // The page around the text, approved 2026-10-21 (reviewed first), under the same
      // rule: a changed word needs a new approval. The names follow bexio's own breadth, which
      // documents each of these scopes as write access to its resource and does not say what
      // that leaves out, so the line under the list says what it covers.
      frame: {
        title: 'Schreibrechte für bexio bestätigen',
        scopesIntro: 'Mit dieser Verbindung erlaubst du lynox in bexio:',
        scopesNote: 'Ein Schreibzugriff gilt bei bexio für den ganzen Bereich, also etwa anlegen, ändern und löschen, bei Offerten und Rechnungen auch ausstellen, verschicken und stornieren. Das Recht ist damit breiter als das, was lynox damit tut.',
        button: 'Zustimmen und weiter zu bexio',
        afterButton: 'Willst du nicht zustimmen, schliess diese Seite. Dann bekommt lynox keine neuen Rechte in bexio.',
      },
      scopeNames: {
        contact_edit: 'Kontakte: Schreibzugriff',
        note_edit: 'Notizen: Schreibzugriff',
        task_edit: 'Aufgaben: Schreibzugriff',
        kb_offer_edit: 'Offerten: Schreibzugriff',
        kb_invoice_edit: 'Rechnungen: Schreibzugriff',
      },
    },
  },
  {
    // An app the merchant creates in their store's organisation, authorised through lynox's
    // connect link (PRD shopify-preset, revision 9). Paths, comma-separated scopes, the token
    // header and the form-encoded exchange from shopify.dev's authorization-code grant and
    // access-scopes pages, read 2026-10-09 and 2026-10-18. No `expiring`: the token does not
    // expire, so there is no refresh.
    id: 'shopify',
    label: 'Shopify',
    host: { kind: 'template', param: 'shop', template: '{shop}.myshopify.com' },
    apiHosts: [],
    apiOnDerivedHost: true,
    apiPathPrefix: '/admin/',
    authorizePath: '/admin/oauth/authorize',
    tokenPath: '/admin/oauth/access_token',
    // The store's subdomain, as Shopify names it: lower-case letters, digits and hyphens, not
    // starting with a hyphen. Shopify itself admits upper case; the boundary does not.
    params: [{ name: 'shop', pattern: /^[a-z0-9][a-z0-9-]*$/, describe: 'the store\'s myshopify.com subdomain, e.g. "my-store" for my-store.myshopify.com, in lower case', caseInsensitive: true }],
    requiredScopes: [],
    // Read only. `read_all_orders` stays out: Shopify grants it only on request. Write scopes
    // come with the bulk form, not with the connection.
    allowedScopes: ['read_products', 'read_orders', 'read_customers', 'read_inventory', 'read_fulfillments'],
    scopeSeparator: ',',
    tokenHeaderName: 'X-Shopify-Access-Token',
    tokenBodyFormat: 'form',
    callbackVerification: 'shopify-hmac',
    compareGrantedScope: true,
    // "Latest stable" on shopify.dev when read on 2026-10-13, supported until 2027-10-16. The
    // bulk run's GraphQL reads name it (`shopify-graphql.ts`); moving it is a reviewed change.
    adminApiVersion: '2026-10',
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
 * save is not a boundary. The redirect flow and `fetch_token` both derive the
 * token endpoint here for a preset profile; its stored `token_url` is display
 * only.
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

/**
 * The first need of `preset` that the profile's scope leaves unmet, as a sentence for the
 * person saving it, or `null` when every need is met.
 */
export function presetScopeNeedUnmet(preset: OAuthPreset, profileScope: string | undefined): string | null {
  const asked = new Set((profileScope ?? '').split(/\s+/).filter((s) => s !== ''));
  for (const need of preset.scopeNeeds ?? []) {
    const named = need.when.filter((s) => asked.has(s));
    if (named.length > 0 && !need.oneOf.some((s) => asked.has(s))) {
      return `${named.join(', ')} needs ${need.oneOf.join(' or ')} as well: ${need.why}.`;
    }
  }
  return null;
}

/**
 * The built-in provider whose API host a profile points at, when the profile does not go
 * through it: anything but `auth.type` oauth2 with that provider's `preset_id`. Undefined when
 * no provider claims the host, or when the profile follows the one that does. Asked where a
 * profile is saved (`api_setup`) and where a request attaches a profile's credentials
 * (`http_request`, for a write), so a profile saved before the save refused it writes nothing.
 */
export function presetNotFollowed(
  profile: { readonly base_url: string; readonly auth?: { readonly type: string; readonly oauth?: { readonly preset_id?: string | undefined } | undefined } | undefined },
  register: PresetRegister = OAUTH_PRESETS,
): OAuthPreset | undefined {
  let host: string;
  try {
    host = new URL(profile.base_url).hostname.replace(/\.+$/, '');
  } catch {
    return undefined;
  }
  // Every provider that claims the host: a profile that follows any of them is in order.
  const claiming = register.ids().map((id) => register.get(id)).filter((p): p is OAuthPreset => p?.apiHosts.includes(host) === true);
  const follows = (preset: OAuthPreset): boolean => profile.auth?.type === 'oauth2' && profile.auth.oauth?.preset_id === preset.id;
  return claiming.some(follows) ? undefined : claiming[0];
}

/**
 * The host a profile of a preset whose API runs on its derived host ({@link
 * OAuthPreset.apiOnDerivedHost}) may reach: the host its own parameter derives, and only when its
 * `base_url` is https on exactly that host, with no port or credentials of its own. `null` for
 * any other profile, and for one whose `base_url` names another host — so a profile cannot mint
 * one store's token and attach it to another store. Pure: it reads no vault. The one definition
 * of a profile's store host, asked where the token is minted (the callback, `fetch_token`) and
 * where it is attached.
 */
export function presetStoreHost(
  profile: { readonly base_url: string; readonly auth?: { readonly type: string; readonly oauth?: { readonly preset_id?: string | undefined; readonly preset_params?: Readonly<Record<string, unknown>> | undefined } | undefined } | undefined },
  register: PresetRegister = OAUTH_PRESETS,
): string | null {
  if (profile.auth?.type !== 'oauth2') return null;
  const presetId = profile.auth.oauth?.preset_id;
  const preset = presetId === undefined ? undefined : register.get(presetId);
  if (preset?.apiOnDerivedHost !== true) return null;
  const derived = derivePresetEndpoints(preset.id, profile.auth.oauth?.preset_params, register);
  if ('kind' in derived) return null;
  let base: URL;
  try {
    base = new URL(profile.base_url);
  } catch {
    return null;
  }
  if (base.protocol !== 'https:' || base.port !== '' || base.username !== '' || base.password !== '') return null;
  return base.hostname === derived.host ? derived.host : null;
}

/**
 * The vault names a built-in provider's OAuth client is meant to live under: one pair per provider
 * and instance, derived from the preset's id the way a profile's token slots are derived from its
 * own (`BEXIO_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`). Derived rather than chosen, so the secret's name
 * is known before any profile names it. A save of a profile on the provider fills these names in
 * and refuses any other (`api_setup`), and the profile's connection form writes only these.
 */
export function presetClientKeys(presetId: string): { readonly id: string; readonly secret: string } {
  const base = presetId.toUpperCase().replace(/-/g, '_');
  return { id: `${base}_CLIENT_ID`, secret: `${base}_CLIENT_SECRET` };
}

/**
 * Whether `name` is the client secret of a built-in provider ({@link presetClientKeys}). The set
 * is the register's, so it is finite and fixed at build time; a name an operator chose for an OAuth
 * client of their own (`MY_APP_CLIENT_SECRET`) is not in it.
 */
export function isPresetClientSecretName(name: string, register: PresetRegister = OAUTH_PRESETS): boolean {
  return register.ids().some((id) => presetClientKeys(id).secret === name);
}

/**
 * What the model is told about a built-in provider's client secret wherever it would otherwise be
 * told to collect or reference a vault name: the owner enters it in the profile's connection form,
 * the one place that writes it (the free secret write refuses the name). What uses it from there is
 * a profile that names it as its client secret.
 */
export function presetClientSecretGuidance(name: string): string {
  return `"${name}" is the OAuth client secret of a built-in provider. The owner of this lynox instance enters it in the connection form of the profile under Settings → API Profiles — not in the chat and not through ask_secret, and it is not referenced in a request. The engine sends it to the provider itself, for a profile that names "${name}" as its client secret and may read it.`;
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

/**
 * The scopes a token answer's `scope` names (comma- or space-separated there), in its order, or
 * `undefined` when the answer names none, an empty `scope` included. The connect callback and a
 * renewal both record this as the grant's `granted_scope`.
 */
export function scopesOfAnswer(scope: unknown): string[] | undefined {
  if (typeof scope !== 'string') return undefined;
  const named = scope.split(/[\s,]+/).filter((s) => s !== '');
  return named.length > 0 ? named : undefined;
}

/**
 * The scopes a connection asks for, for a built-in provider whose grants are worth comparing
 * ({@link OAuthPreset.compareGrantedScope}): the provider's required scopes plus the profile's
 * own, possibly none. `undefined` when there is nothing to compare a grant with: any other
 * profile, whose provider may add scopes of its own, and a scope the provider refuses, which
 * never made a link.
 */
export function askedScopes(oauth: { readonly preset_id?: string | undefined; readonly scope?: string | undefined }): string[] | undefined {
  const preset = OAUTH_PRESETS.get(oauth.preset_id ?? '');
  if (preset?.compareGrantedScope !== true) return undefined;
  const requested = presetScopeRequest(preset, oauth.scope);
  return 'scopes' in requested ? [...requested.scopes] : undefined;
}

/** What `granted` holds that `asked` does not, in the order granted, each once. */
export function scopesBeyondAsked(granted: readonly string[], asked: readonly string[]): string[] {
  const known = new Set(asked);
  return [...new Set(granted.filter((s) => !known.has(s)))];
}
