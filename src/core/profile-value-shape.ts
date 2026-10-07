/**
 * Profile-controlled values, made safe to put in a sentence the model or an operator
 * reads. Shared by every renderer of such a sentence, so a new one does not have to
 * rediscover which values need it.
 */

/**
 * One line of a log, sanitised the way every other line out of `http.ts` is.
 *
 * `migrateV1Profile` says why in `api-store.ts`: a profile can arrive from a
 * hand-edited or imported JSON, which no validator re-reads, so a field of it
 * reaching stderr raw can forge `[lynox:…]` lines or carry terminal escapes.
 * `writeRenewalFailure` in `http.ts` strips the same class. This is that rule, named
 * once, because it was applied in one of the two places that needed it.
 */
export function oneLineForLog(value: unknown, max: number): string {
  // `unknown`, not `string`, and that is the point. The profile fields this
  // formats are typed `string | undefined` and arrive from `JSON.parse(raw) as
  // ApiProfile` with no schema check — `_admit` validates the id, the derived
  // vault slot and the host, and nothing else. `(5).replace` is a TypeError, and
  // the credential attach in `http.ts` is not inside a try/catch, so the result
  // would be every request to that profile failing: the same defect as the
  // `oauth_grant.written` read there, which was fixed by reaching for a tolerant
  // reader. This one has no tolerant reader to reach for, so the tolerance is here.
  if (typeof value !== 'string') return `<non-string: ${typeof value}>`;
  return value.replace(/[\r\n\t\u0000-\u001f\u007f]+/g, ' ').slice(0, max);
}

/**
 * A profile-controlled value, rendered only if it has the SHAPE it claims.
 *
 * `oneLineForLog` strips control characters and truncates, which is enough to
 * stop a forged log LINE and nothing else: a vault key only has to satisfy
 * `/^[A-Z][A-Z0-9_]{0,63}$/` to be written through `api_setup update`, and the
 * free-text variant arrives whole from a boot-loaded JSON that no validator
 * re-reads. Both reach a sentence an operator reads. So the quoted values are
 * checked against their own pattern and replaced when they do not fit, rather
 * than quoted as-is — a name that is not a name is a fact worth stating, and
 * stating it is cheaper than reasoning about what prose can do inside quotes.
 *
 * It is written for the operator's line, where the harm is a misleading name, but
 * it is not only there: in `attachEngineManagedAuth`, the bearer/header 401 hint
 * and the refusals print vault-key names through it too, and the model reads those.
 * There a value that does not fit becomes `<unprintable>` rather than a line of its
 * own (http.test.ts, "a profile-authored key name with line breaks is not printed
 * into the 401 hint"). The other 401 hints use `safeToken` (in `http.ts`).
 */
export function shapedForLog(value: unknown, pattern: RegExp, max: number): string {
  if (typeof value !== 'string') return `<non-string: ${typeof value}>`;
  const oneLine = oneLineForLog(value, max);
  return pattern.test(oneLine) ? oneLine : '<unprintable>';
}

export const VAULT_NAME_SHAPE = /^[A-Z][A-Z0-9_]{0,63}$/;
/**
 * The DERIVED refresh-slot name's own domain, which is wider than a vault key's.
 *
 * `refreshTokenKey` is `id.toUpperCase().replace(/-/g,'_') + '_REFRESH_TOKEN'`,
 * and `_admit` admits an id of 64 — so the name it builds runs to 78 characters
 * and does NOT fit `VAULT_NAME_SHAPE`. It also admits a DIGIT-LEADING id
 * (`PROFILE_ID_PATTERN` is `/^[a-z0-9][a-z0-9_-]{0,63}$/`), so `360-crm` derives
 * `360_CRM_REFRESH_TOKEN` — a real shape, `1password` and `3cx` likewise. The
 * first version of this constant closed the LENGTH axis and left the
 * FIRST-CHARACTER axis open, because every id in its fixtures began with a
 * letter: the axis the fix was keyed on was swept and its sibling was not. Shaping it against the vault bound made
 * the engine report its own slot as `<unprintable>` for any id over 50, which is
 * the one fact that clause exists to deliver. A value gets the bound of what it
 * actually is; the alternative — printing it unchecked because "it is
 * engine-built" — is an assumption the renderer cannot enforce, and the test
 * that enumerates every inhabitant of a fact caught exactly that.
 */
export const DERIVED_NAME_SHAPE = /^[A-Z0-9][A-Z0-9_]{0,77}$/;
/** `new Date().toISOString()`, which is what the engine writes into `revoked_at`. */
export const ISO_TIMESTAMP_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const GRANT_TYPE_SHAPE = /^[A-Za-z0-9_:.\-]{1,40}$/;

/**
 * A header name as HTTP defines one (a `token`), at most 64 characters. Deliberately the
 * protocol's rule and not a narrower house style: a stored profile with `X_Api_Key` is valid
 * HTTP, and a narrower check would turn every later `refine` of it into a refusal.
 */
export const HTTP_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;

/** A query parameter name the engine will name to the model and the model can put in a URL as is. */
export const QUERY_PARAM_NAME = /^[A-Za-z0-9._~-]{1,64}$/;

/**
 * A vault slot name a profile resolves, as it may appear in a sentence: under the
 * bound of what it is. The engine-derived name gets `DERIVED_NAME_SHAPE`, any other
 * name — one the profile itself named — `VAULT_NAME_SHAPE`.
 */
export function slotNameForModel(name: unknown, derived: string): string {
  return shapedForLog(name, name === derived ? DERIVED_NAME_SHAPE : VAULT_NAME_SHAPE, 80);
}

/**
 * A profile's `auth.type`, as it may appear in a sentence. A profile loaded from a file
 * can carry any text there, and a refusal names the type it found; a lowercase word
 * prints (an unknown one is a fact worth stating), anything else does not.
 */
export function authTypeForModel(type: unknown): string {
  return type === undefined ? 'none' : wordForModel(type, 20);
}

/**
 * A profile value that should be one lowercase word of at most `max` characters,
 * printed only if it is one. Measured on one character more than `max`, so an
 * over-long value is refused rather than cut down to something that looks valid.
 */
export function wordForModel(value: unknown, max: number): string {
  return shapedForLog(value, new RegExp(`^[a-z0-9_]{1,${max}}$`), max + 1);
}
