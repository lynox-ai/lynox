import { domainToASCII, domainToUnicode } from 'node:url';
import { LinearJwtRegExp, JWT_SHAPE, JWT_EGRESS_WIDE, withFlags } from './jwt-scan.js';
import type { SecretScope, SecretStoreLike, LynoxUserConfig } from '../types/index.js';
import { channels } from './observability.js';
import type { SecretVault } from './secret-vault.js';
import { PROVIDER_KEY_SLOTS } from './llm/provider-keys.js';
import { isPresetClientSecretName } from './oauth-presets.js';
import { ENV_REGISTRY } from '../contract/env-registry.js';

export const SECRET_REF_PATTERN = /\bsecret:([A-Z_][A-Z0-9_]*)\b/g;

/**
 * Infrastructure / engine-internal secret names that the agent must NOT see
 * or resolve. These are channel/engine credentials (mail-account blobs, OAuth
 * tokens, SMTP and IMAP, engine-internal LYNOX_ and MANAGED_) — managed by the
 * platform and the dedicated integration UIs, never authored or referenced by
 * the agent. Single source of truth: the same set the secrets-write API uses
 * to reject non-admin writes (`isAdminOnlySecret` in http-api).
 *
 * Why agent-invisible: a vault-backed secret is auto-consented (see
 * `_loadFromVault`), so without this gate `secret:MAIL_ACCOUNT_<id>` in a tool
 * input expands to the full `{user,pass}` credential and is sent to whatever
 * host the tool targets — a credential-exfil handle reachable via prompt
 * injection. These names are excluded from the session briefing AND left
 * unresolved in tool inputs. They remain in `maskSecrets` so a value that
 * does surface is still redacted.
 */
export const INFRA_SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /^LYNOX_/,
  /^MANAGED_/,
  /^MAIL_ACCOUNT_/,
  /^GOOGLE_OAUTH_/,
  // The Microsoft grant (`microsoft/vault-keys.ts`): an access token and the
  // control plane's sealed handle. Same class as the Google grant above.
  /^MICROSOFT_OAUTH_/,
  // GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are the OAuth *app* credentials. They
  // are resolved engine-internally — never an agent tool-input ref, which is what
  // keeps them on this list. Operators supply them per deployment.
  //
  // The original note here read "OAuth hijacking if a tenant could repoint them".
  // That threat is per-INSTANCE, and each tenant runs its own container and its own
  // vault: repointing changes which Google app THAT tenant's engine authenticates
  // as, against THAT tenant's own data. It is what BYO means, and it is a supported
  // state since 2026-08-23. So the customer-facing write path carves this prefix out
  // (http-api.ts CUSTOMER_WRITABLE_INFRA_PATTERNS) while the agent-prompt path does
  // not — the agent must never be able to raise a credential dialog for it.
  /^GOOGLE_CLIENT_/,
  /^SMTP_/,
  /^IMAP_/,
  // A calendar feed URL whose SECRECY is the credential (Google/Outlook/Apple "secret
  // address"). Same class as the mail credentials above: the engine resolves it inside
  // `calendar_read`, and the model has no reason to hold it. Keeping it agent-invisible
  // means a prompt-injected turn cannot put `secret:CALENDAR_FEED_…` into an outbound
  // request body — the URL alone grants read access to someone's whole calendar, and it
  // matches none of the vendor-prefixed shapes the egress body scan looks for.
  /^CALENDAR_FEED_/,
];

/** True if writing `name` would clobber a credential the tenant cannot recover — either an
 *  infrastructure secret or a vault slot holding their own LLM provider key. For WRITE gates;
 *  read visibility is still {@link isInfraSecret}'s question.
 *
 *  The provider slots are deliberately NOT in {@link INFRA_SECRET_PATTERNS}: they are
 *  agent-VISIBLE by design — the setup wizard writes them and the engine resolves them. What
 *  they must never be is agent-OVERWRITABLE: `api_setup fetch_token` picks its own output
 *  name, and writing an OAuth token over a provider key destroys the tenant's access to their
 *  own provider. There is no second copy — the wizard stored it once.
 *
 *  The slot set is the one derived from the model catalog (`llm/provider-keys.ts`), not a list
 *  kept here: a catalog preset that adds a slot is protected without an edit in this file. */
export function isProtectedSecretWrite(name: string): boolean {
  return isInfraSecret(name) || PROVIDER_KEY_SLOTS.has(name);
}

/** True if `name` is an infrastructure/engine-internal secret (agent-invisible). */
export function isInfraSecret(name: string): boolean {
  return INFRA_SECRET_PATTERNS.some(p => p.test(name));
}

/**
 * Every `secret:NAME` name written in `input`, in order, deduplicated.
 *
 * A pure text scan: it reads no value and needs no store, which is what lets
 * `secret-scope.ts` derive a spawn's default scope from the spawn order alone.
 */
export function extractSecretRefNames(input: unknown): string[] {
  const text = JSON.stringify(input);
  const names: string[] = [];
  const pattern = new RegExp(SECRET_REF_PATTERN.source, 'g');
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (!names.includes(match[1]!)) names.push(match[1]!);
  }
  return names;
}

/**
 * Resolve every `secret:NAME` reference in `input` through `resolve`.
 *
 * Extracted from {@link SecretStore.resolveSecretRefs} so a SCOPED view of a
 * store (see `secret-scope.ts`) can reuse this exact walk with a narrower
 * resolver instead of re-implementing it. A second implementation would be the
 * bypass: `resolveSecretRefs` is the path tool input actually travels, so a
 * scoped store that delegated this one method to the unscoped inner store
 * would hand the child every secret while every other method looked correct.
 *
 * `resolve` returning null leaves the literal `secret:NAME` in place — which is
 * what makes an out-of-scope reference visible to `findUnresolvedSecretRefs`
 * and thus to the fail-loud pre-tool gate, rather than silently empty.
 */
export function resolveSecretRefsWith(
  input: unknown,
  resolve: (name: string) => string | null,
): unknown {
  const text = JSON.stringify(input);
  const pattern = new RegExp(SECRET_REF_PATTERN.source, 'g');
  const resolved = text.replace(pattern, (_match, name: string) => {
    // Infrastructure secrets are never resolved into agent tool input — leave
    // the literal `secret:NAME` so the credential cannot be exfiltrated to an
    // external host (the value stays in the vault / credStore path only).
    if (isInfraSecret(name)) return `secret:${name}`;
    const value = resolve(name);
    // Escape for JSON string context
    return value !== null ? value.replace(/["\\\n\r\t]/g, c => {
      if (c === '"') return '\\"';
      if (c === '\\') return '\\\\';
      if (c === '\n') return '\\n';
      if (c === '\r') return '\\r';
      if (c === '\t') return '\\t';
      return c;
    }) : `secret:${name}`;
  });
  try {
    return JSON.parse(resolved) as unknown;
  } catch {
    return input;
  }
}

/**
 * The known shapes of a credential, kept in one place. The detect/mask helpers
 * below and the http tool's outbound scan read this list rather than keeping
 * their own copies: copies drift, and a copy that lags misses the newest key
 * format.
 *
 * - `vendor`: a provider's prefixed key format.
 * - `key-block` / `jwt`: structural credentials with an unmistakable shape.
 * - `contextual`: a credential recognisable only by what surrounds it (URL
 *   userinfo, a `Bearer` header) — ordinary in some places, a leak in others.
 * - `egress-wide`: a wider spelling of a vendor or JWT form that the outbound
 *   scan has always used. Kept for that scan only — narrowing it would let
 *   through something it refuses today, and the detect/mask helpers keep their
 *   word-bounded forms because the wide ones fire inside ordinary words.
 * - `generic`: any long token. Last on purpose: callers drop it for short text.
 */
export type SecretShapeKind = 'vendor' | 'key-block' | 'jwt' | 'contextual' | 'egress-wide' | 'generic';
export interface SecretShape {
  readonly label: string;
  readonly kind: SecretShapeKind;
  readonly pattern: RegExp;
}

/**
 * Where a `vendor` shape may start. `\b` alone missed a key glued to an identifier —
 * `LYNOX_sk-ant-…` came back whole from an API error (2026-10-06) — because `\b` counts `_`
 * as part of a word. Dropping the bound would match inside ordinary words (`task-…` for the
 * `sk-` rule, `has_github_pat_configured` after a `_`).
 *
 * So a shape starts where `\b` let it start, OR right after `_`, a JSON escape (`\n`,
 * `\u003e`) or a URL escape (`%3D`) — and then only if the first letters-and-digits run of
 * its body holds a digit, which a name like `use_ghp_token_for_auth` does not. The end
 * stays `\b`.
 * JWTs are not built this way; they keep `\b`.
 */
export const CREDENTIAL_GLUE = String.raw`(?<=_|\\[a-z]|\\u[0-9A-Fa-f]{4}|%[0-9A-Fa-f]{2})`;
export function credentialShape(prefix: string, body: string, flags?: string, end = String.raw`\b`): RegExp {
  return new RegExp(
    String.raw`(?:(?<![A-Za-z0-9_])` + prefix + '|' + CREDENTIAL_GLUE + prefix + String.raw`(?=[A-Za-z0-9]{0,128}[0-9]))` + body + end,
    flags,
  );
}

export const SECRET_SHAPES: ReadonlyArray<SecretShape> = [
  // Anthropic
  { label: 'Anthropic API key', kind: 'vendor', pattern: credentialShape(String.raw`sk-ant-`, String.raw`[A-Za-z0-9_-]{20,}`) },
  // OpenAI. Two rules on purpose: the plain `sk-` form is alnum-only, but the
  // prefixed forms (`sk-proj-`, `sk-svcacct-`) carry `-` and `_` INSIDE the
  // token, so the alnum rule stops at the first dash and matches four
  // characters. Measured 2026-08-24: a real `sk-proj-…` key passed the masker
  // untouched while the test fixture (`sk-ant-` + 40×A) was caught — the fixture
  // was the reason it looked covered.
  { label: 'OpenAI API key', kind: 'vendor', pattern: credentialShape(String.raw`sk-(?:proj|svcacct|admin)-`, String.raw`[A-Za-z0-9_-]{20,}`) },
  { label: 'OpenAI-style API key', kind: 'vendor', pattern: credentialShape(String.raw`sk-`, String.raw`[A-Za-z0-9]{20,}`) },
  // A credential embedded in a URL's userinfo (`scheme://user:pass@host`).
  // Narrow by construction — it needs the `:`…`@` shape — so it does not touch
  // ordinary URLs, and it catches the database and basic-auth strings that
  // routinely end up in connection errors.
  // Two deliberate departures from the obvious form, both measured.
  //
  // `{0,32}` instead of `*`: unbounded, this rule is quadratic in a long dotted
  // run — 40 KB cost ~500 ms of blocked event loop, and a regex cannot be
  // interrupted.
  //
  // NO leading `\b[a-z]` anchor: the quantifier does not govern the SCHEME, it
  // governs everything since the last word boundary. Anchored, a bound of 32
  // silently stops matching as soon as 34+ alphanumerics are glued in front of
  // the URL — and text immediately before an error's URL is exactly what a
  // caller can control. Without the anchor the same bound keeps the match
  // (verified: 40 and 200 characters of glued prefix both match) while ordinary
  // URLs still do not (`https://api.example.com/…`, `host:8443/…`,
  // `redis://cache:6379/0` — none has the `user:pass@` shape this needs).
  { label: 'credential in URL', kind: 'contextual', pattern: /[a-z0-9+.-]{0,32}:\/\/[^\s:@/]+:[^\s:@/]+@/i },
  // Stripe
  { label: 'Stripe API key', kind: 'vendor', pattern: credentialShape(String.raw`[sr]k_(live|test)_`, String.raw`[A-Za-z0-9]{10,}`) },
  // GitHub (ghu_ added 2026-05-18 — user installation tokens missed previously)
  { label: 'GitHub token', kind: 'vendor', pattern: credentialShape(String.raw`(ghp|gho|ghs|ghr|ghu|github_pat)_`, String.raw`[A-Za-z0-9_]{10,}`) },
  // AWS
  { label: 'AWS access key', kind: 'vendor', pattern: credentialShape(String.raw`AKIA`, String.raw`[A-Z0-9]{16}`) },
  // Google
  { label: 'Google API key', kind: 'vendor', pattern: credentialShape(String.raw`AIza`, String.raw`[A-Za-z0-9_-]{35}`) },
  // Slack (xoxo + xoxr added — webhook + refresh-token prefixes)
  { label: 'Slack token', kind: 'vendor', pattern: credentialShape(String.raw`xox[bpoasr]-`, String.raw`[A-Za-z0-9-]{10,}`) },
  // Shopify (admin / app-secret / partner / custom — added 2026-05-18 after
  // a Shopify integration flow leaked the prefix into the agent transcript)
  { label: 'Shopify token', kind: 'vendor', pattern: credentialShape(String.raw`shp(at|ss|pa|ca)_`, String.raw`[A-Fa-f0-9]{20,}`) },
  // JWT (three base64-url segments) — catches OAuth ID tokens etc. Matched in linear time,
  // see `jwt-scan.ts`; the regex it equals is `JWT_SHAPE.regex`.
  { label: 'JWT token', kind: 'jwt', pattern: new LinearJwtRegExp(JWT_SHAPE) },
  // Google OAuth access token
  { label: 'Google OAuth token', kind: 'vendor', pattern: credentialShape(String.raw`ya29\.`, String.raw`[A-Za-z0-9_-]{20,}`) },
  // Private key blocks (PEM / OpenSSH) — any key type, not only RSA.
  { label: 'private key', kind: 'key-block', pattern: /-----BEGIN\s+(?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED)\s+)?PRIVATE\s+KEY-----/ },
  // The outbound scan's own wider forms: not word-bounded, and a JWT whose
  // payload segment need not start with `eyJ`. See `egress-wide` above.
  { label: 'Anthropic API key', kind: 'egress-wide', pattern: /sk-ant-[a-zA-Z0-9_-]{20,}/ },
  { label: 'OpenAI-style API key', kind: 'egress-wide', pattern: /sk-[a-zA-Z0-9]{20,}/ },
  { label: 'GitHub token', kind: 'egress-wide', pattern: /gh[po]_[a-zA-Z0-9]{36,}/ },
  { label: 'JWT token', kind: 'egress-wide', pattern: new LinearJwtRegExp(JWT_EGRESS_WIDE) },
  // Generic Bearer tokens (long base64-ish)
  { label: 'bearer token', kind: 'contextual', pattern: /\bBearer\s+[A-Za-z0-9_\-.]{20,}\b/ },
  // Generic long hex/base64 secrets (40+ chars, likely tokens)
  { label: 'long token', kind: 'generic', pattern: /\b[A-Za-z0-9_-]{40,}\b/ },
];

/**
 * Common secret patterns — regex-based detection for accidental secret leaks.
 * Used by ask_user guard and chat input warning.
 */
const SECRET_PATTERNS: RegExp[] = SECRET_SHAPES.filter((s) => s.kind !== 'egress-wide').map((s) => s.pattern);

/**
 * Check if text likely contains a secret based on common key patterns.
 * Returns the first match or null.
 */
export function matchesSecretPattern(text: string): string | null {
  // Skip the generic long-string pattern (last one) for short texts to reduce false positives
  const patterns = text.length < 100 ? SECRET_PATTERNS.slice(0, -1) : SECRET_PATTERNS;
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return null;
}

/**
 * Like {@link matchesSecretPattern} but ALWAYS applies the generic 40+ char token
 * catcher, even for short text. `matchesSecretPattern` skips that catcher under 100
 * chars to avoid false positives in ordinary prose — a fine trade-off when scanning
 * free text, but wrong when the field should hold NO credential at all (an onboarding
 * business-fact answer). There a bare 40-99 char token is far more likely a pasted
 * credential than a company/role/goal, so bias toward rejection. Does NOT close the
 * sub-40-char class (short app-passwords, TOTP seeds): treat this as a filter that
 * raises the cost of a mistake, never as a guarantee that a field holds no credential.
 */
export function matchesSecretPatternStrict(text: string): string | null {
  for (const pattern of SECRET_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return null;
}

/**
 * Mask text that matches common secret patterns.
 * Replaces detected secrets with their mask (`maskMatch`: `***<last4>`, or `***` for a short match or a credential in a URL).
 */
export function maskSecretPatterns(text: string, opts?: { includeGeneric?: boolean }): string {
  let result = text;
  // The generic 40+ char catcher is skipped by default to avoid over-masking
  // ordinary prose. Callers that are scrubbing a machine-read sink rather than
  // something a person reads (error reports) pass `includeGeneric` — there,
  // masking a long opaque token that turns out to be a hash costs a little
  // diagnostic detail, while missing one that is a credential costs the
  // credential.
  const patterns = opts?.includeGeneric === true ? SECRET_PATTERNS : SECRET_PATTERNS.slice(0, -1);
  for (const pattern of patterns) {
    const globalPattern = withFlags(pattern, 'g');
    result = result.replace(globalPattern, (match) => maskMatch(match));
  }
  return result;
}

/**
 * The shapes that are a credential wherever they appear, read the way the web UI's chat input
 * check reads them: without the trailing word boundary, so a key followed directly by a word
 * character is still found.
 */
const INPUT_SHAPES: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = SECRET_SHAPES
  .filter((s) => s.kind === 'vendor' || s.kind === 'jwt')
  .map((s) => ({
    label: s.label,
    pattern: s.pattern instanceof LinearJwtRegExp
      ? new LinearJwtRegExp({
        ...s.pattern.spec,
        regex: new RegExp(s.pattern.spec.regex.source.replace(/\\b$/, ''), s.pattern.spec.regex.flags),
        s3: s.pattern.spec.s3 === null ? null : { ...s.pattern.spec.s3, wordEnd: false },
      }, 'g')
      : new RegExp(s.pattern.source.replace(/\\b$/, ''), 'g'),
  }));
/** A private key from its BEGIN line to its END line, or to the end of the text when the END line is missing. */
const KEY_BLOCK = /-----BEGIN\s+(?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED)\s+)?PRIVATE\s+KEY-----[\s\S]*?(?:-----END\s+(?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED)\s+)?PRIVATE\s+KEY-----|$)/g;

/**
 * Remove credential-shaped values from a message a person typed, before anything stores or
 * sends it. Same masking as `maskSecretPatterns` (`maskMatch`); a private key goes as a whole
 * block, not just its header. Returns the labels of what was removed, each once.
 */
export function maskCredentialInput(text: string): { text: string; labels: string[] } {
  const labels: string[] = [];
  const note = (label: string): void => { if (!labels.includes(label)) labels.push(label); };
  let result = text.replace(KEY_BLOCK, () => { note('private key'); return '***'; });
  for (const shape of INPUT_SHAPES) {
    result = result.replace(shape.pattern, (match) => {
      note(shape.label);
      return maskMatch(match);
    });
  }
  return { text: result, labels };
}

/**
 * A typed chat message with its credentials masked (`maskCredentialInput`), and a note to the
 * model appended when any were, so it collects them through `ask_secret` instead.
 */
export function withoutTypedCredentials(text: string): string {
  const { text: masked, labels } = maskCredentialInput(text);
  if (labels.length === 0) return text;
  return `${masked}\n\n[lynox: removed from this message before it was saved or sent on: ${labels.join(', ')}. ` +
    'If the user meant to give you a credential, collect it with ask_secret; do not ask for it in chat again.]';
}

/**
 * Mask known SHAPES and known VALUES in one pass, over the ORIGINAL text.
 *
 * Running the two maskers in sequence is unsafe in BOTH orders, and that is
 * measured, not cautious. Values first: a stored two-character value inside an
 * `sk-ant-…` key becomes `***`, `*` is in no pattern character class, the rule
 * stops matching and thirty characters of the key ship in cleartext. Shapes
 * first: a stored value straddling a shape boundary survives the same way.
 * Neither order dominates — each has a case where the other is safe.
 *
 * Sequencing is unsafe because each pass rewrites the text the next one reads.
 * So both passes read the ORIGINAL, contribute spans, and the union is redacted
 * once. A span the value pass finds cannot hide one the pattern pass would have
 * found, in either direction.
 *
 * (The docblock this replaces claimed masking "only shortens" the text, so the
 * exact pass could not hide a shape. It does not: a value of four characters or
 * fewer becomes `***` (today every value under 16), so `xx ab yy` grows by one.)
 */
export function maskSecretsAndPatterns(
  text: string,
  values: readonly string[],
  opts?: { includeGeneric?: boolean },
): string {
  // `suffix`: whether this span alone could show its last four. A merged span shows them only
  // if every span in it could, since the union's last four may belong to a short one.
  const spans: Array<{ start: number; end: number; suffix: boolean }> = [];

  const patterns = opts?.includeGeneric === true ? SECRET_PATTERNS : SECRET_PATTERNS.slice(0, -1);
  for (const pattern of patterns) {
    const global = withFlags(pattern, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    for (const m of text.matchAll(global)) {
      if (m.index !== undefined) spans.push({ start: m.index, end: m.index + m[0].length, suffix: matchShowsSuffix(m[0]) });
    }
  }

  for (const value of values) {
    // Single characters would match everywhere; the store applies the same floor.
    if (value.length < 2) continue;
    let from = 0;
    for (;;) {
      const at = text.indexOf(value, from);
      if (at === -1) break;
      spans.push({ start: at, end: at + value.length, suffix: value.length >= MASK_SUFFIX_MIN_LENGTH });
      from = at + value.length;
    }
  }

  if (spans.length === 0) return text;

  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number; suffix: boolean }> = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    // `<=`, not `<`: touching spans merge into one mask. That is presentation, because the
    // merged span shows its last four only when every span in it could (`suffix`); without
    // that, two touching 8-character values would show four characters of the second.
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
      last.suffix = last.suffix && span.suffix;
    } else merged.push({ ...span });
  }

  let out = '';
  let cursor = 0;
  for (const span of merged) {
    out += text.slice(cursor, span.start);
    const matched = text.slice(span.start, span.end);
    out += span.suffix ? maskValue(matched) : '***';
    cursor = span.end;
  }
  return out + text.slice(cursor);
}

interface InternalSecret {
  name: string;
  value: string;
  scope: SecretScope;
  loadedAt: number;
  ttlMs: number; // 0 = no expiry
}

/**
 * Env-registry secrets that are identities, not credentials. Masking them would hide the
 * owner's own address, or a public OAuth app id, in every tool result that names them.
 */
const ENV_SECRETS_NOT_MASKED: ReadonlySet<string> = new Set([
  'LYNOX_MANAGED_CUSTOMER_EMAIL',
  'GOOGLE_CLIENT_ID',
]);

const MIN_ENV_SECRET_LENGTH = 8;

/**
 * The values of the engine's own env secrets (the registry rows marked `secret`), read
 * from `process.env` at call time so a key the engine sets after this store exists (the
 * vault key, `engine-init.ts`) is still masked. Mask-only: they never enter `secrets`, so
 * nothing resolves, lists or advertises them.
 *
 * It covers the case without an attacker, where a value read once would otherwise stay in the
 * thread and go to the model provider in clear.
 *
 * A value under {@link MIN_ENV_SECRET_LENGTH} is skipped: an operator's `{}` or a word like
 * `lynox` would otherwise be masked in every text, and every text holding it refused by
 * the `containsSecret` gates. No real credential is that short.
 */
function engineEnvSecretValues(): string[] {
  const values: string[] = [];
  for (const row of ENV_REGISTRY) {
    if (!row.secret || ENV_SECRETS_NOT_MASKED.has(row.name)) continue;
    const value = process.env[row.name];
    if (value && value.length >= MIN_ENV_SECRET_LENGTH) values.push(value);
  }
  return values;
}

/**
 * Whether a parsed host name holds one of `values` the way a host is read. A host goes out
 * lower-cased (the URL parser folds it, DNS and TLS compare names without case), so a stored
 * `Sk-Live-Canary` in `sk-live-canary.h.example` is the same value on the wire while the exact
 * mask misses it. `host` is what the parser wrote, never the request's text: the parser's rules
 * (user info, a backslash read as a slash, a tab dropped) decide what goes out, and reading the
 * text instead rebuilds them one by one. The host is read as it goes out and with its labels as
 * Unicode (`domainToUnicode`): a value outside ASCII is found inside a longer punycode label, and a
 * value written into a punycode label as its ASCII part is found on the wire, where decoding would
 * break it up. A value
 * is compared lower-cased and as the parser maps it (`domainToASCII`, back to Unicode: a final
 * sigma, a full-width value); that form is taken only for a value a host name can hold, since the
 * parser cuts the rest at the first delimiter (`x/y` is `x`). A number the parser reads as an IPv4
 * address counts only as the whole host: its dotted form shares no characters with the value, and
 * as part of a host it would refuse names that send nothing stored. Only for a host: a path, a
 * query or a header keeps its case, and folding there would refuse writes that send nothing.
 */
export function holdsValueAsHost(host: string, values: readonly string[]): boolean {
  const onWire = host.toLowerCase();
  const asRead = domainToUnicode(host); // '' for a host that does not decode: read on the wire alone
  for (const value of values) {
    if (value.length < 2) continue; // the floor `containsSecret` keeps
    const folded = value.toLowerCase();
    if (onWire.includes(folded) || asRead.includes(folded)) return true;
    const asHostName = HOST_NAME_CHARS.test(value) ? domainToASCII(value) : '';
    if (asHostName.length < 2) continue;
    if (IPV4.test(asHostName)) {
      if (host === asHostName) return true;
      continue;
    }
    const mapped = domainToUnicode(asHostName);
    if (onWire.includes(asHostName) || (mapped.length >= 2 && asRead.includes(mapped))) return true;
  }
  return false;
}
/** Characters a value may hold to be read as a host name: no delimiter, space or escape. */
const HOST_NAME_CHARS = /^[^\s/\\?#@:%[\]]+$/u;
const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;

/**
 * The engine's own env secrets masked in `text`, for a caller that holds no store (a
 * headless workflow step): the values belong to the process, not to a store.
 */
export function maskEngineEnvSecrets(text: string): string {
  return maskValuesIn(text, engineEnvSecretValues());
}

/** Below this length the mask shows no character of the value: four of five, or half of eight,
 *  would be most of it. From it on, the last four identify a key the way a provider dashboard does. */
const MASK_SUFFIX_MIN_LENGTH = 16;

/** The one mask for a secret value, wherever one is shown: `***` + its last four characters,
 *  or `***` alone when the value is shorter than {@link MASK_SUFFIX_MIN_LENGTH}. */
function maskValue(value: string): string {
  if (value.length < MASK_SUFFIX_MIN_LENGTH) return '***';
  return `***${value.slice(-4)}`;
}

/** Whether a credential-shaped match may show its last four. A credential in a URL
 *  (`scheme://user:password@`) ends in the password, whatever the match's length. */
function matchShowsSuffix(match: string): boolean {
  return match.length >= MASK_SUFFIX_MIN_LENGTH && !match.includes('://');
}

/** The mask of a credential-shaped match: {@link maskValue}, except that a credential in a URL
 *  shows none of its characters (see {@link matchShowsSuffix}). */
function maskMatch(match: string): string {
  return matchShowsSuffix(match) ? maskValue(match) : '***';
}

/**
 * Replace every value in `values` that occurs in `text` with its mask. Longest first: a
 * shorter value inside a longer one would otherwise be replaced first, and the rest of the
 * longer one would no longer match and stay in clear.
 */
function maskValuesIn(text: string, values: readonly string[]): string {
  let result = text;
  for (const value of [...values].sort((a, b) => b.length - a.length)) {
    if (value.length < 2) continue;
    let masked = maskValue(value);
    // Guard against a degenerate mask that CONTAINS the raw value (a value made
    // of the mask's own '*' chars, like "***" → "***"): it
    // would both loop forever below AND leak the secret through its own
    // replacement. Fall back to a fixed token that cannot embed the value.
    if (masked.includes(value)) masked = '[redacted]';
    // Single global pass — split+join replaces every (non-overlapping)
    // occurrence at once (literal replacement, no regex special-char issues).
    // The previous `while (result.includes(...))` loop re-scanned the output
    // and hung whenever the mask re-introduced the pattern.
    if (result.includes(value)) {
      result = result.split(value).join(masked);
    }
  }
  return result;
}

export class SecretStore implements SecretStoreLike {
  private readonly secrets = new Map<string, InternalSecret>();
  private readonly consented = new Set<string>();
  /** Names whose value `_loadFromEnv` took from the process environment. */
  private readonly envNames = new Set<string>();
  private readonly vault: SecretVault | null;

  isEnvironmentSecret(name: string): boolean {
    return this.envNames.has(name);
  }

  constructor(config?: LynoxUserConfig | undefined, vault?: SecretVault | undefined) {
    this.vault = vault ?? null;
    this._loadFromEnv();
    if (this.vault) {
      this._loadFromVault();
    }
    if (config) {
      this._loadFromConfig(config);
    }
  }

  private _loadFromEnv(): void {
    // 1. LYNOX_SECRET_* prefix — explicit secret injection
    const prefix = 'LYNOX_SECRET_';
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith(prefix) && value) {
        const name = key.slice(prefix.length);
        if (name.length === 0) continue;
        this.envNames.add(name);
        this.secrets.set(name, {
          name,
          value,
          scope: 'any',
          loadedAt: Date.now(),
          ttlMs: 0,
        });
      }
    }

    // 2. Well-known env vars — explicit runtime env always overrides vault.
    //    Without this, vault.getAll() in _loadFromVault() would shadow the env var
    //    and secretStore.resolve() would return a stale vault value.
    const wellKnownEnv: Array<[string, string]> = [
      ['ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY'],
      ['GOOGLE_CLIENT_SECRET', 'GOOGLE_CLIENT_SECRET'],
      // SEARCH_API_KEY / TAVILY_API_KEY pairing removed 2026-05-24 with the
      // Tavily backend. The vault entry (if any) is no longer resolved as a
      // search credential; SearXNG (URL only, no key) is the supported path.
    ];
    for (const [secretName, envVar] of wellKnownEnv) {
      const value = process.env[envVar];
      if (!value) continue;
      if (this.secrets.has(secretName)) continue; // LYNOX_SECRET_* already set
      this.envNames.add(secretName);
      this.secrets.set(secretName, {
        name: secretName,
        value,
        scope: 'any',
        loadedAt: Date.now(),
        ttlMs: 0,
      });
    }
  }

  private _loadFromVault(): void {
    if (!this.vault) return;
    const entries = this.vault.getAll();
    for (const [name, entry] of entries) {
      // Don't overwrite env/file secrets (they take precedence)
      if (this.secrets.has(name)) continue;
      this.secrets.set(name, {
        name,
        value: entry.value,
        scope: entry.scope,
        loadedAt: Date.now(),
        ttlMs: entry.ttlMs,
      });
      // Auto-consent vault secrets — the user explicitly saved them
      this.consented.add(name);
    }
  }

  private _loadFromConfig(config: LynoxUserConfig): void {
    const wellKnown: Array<[string, string | undefined]> = [
      ['ANTHROPIC_API_KEY', config.api_key],
    ];

    for (const [name, value] of wellKnown) {
      if (!value) continue;
      // Don't overwrite if already loaded
      if (this.secrets.has(name)) continue;
      this.secrets.set(name, {
        name,
        value,
        scope: 'any',
        loadedAt: Date.now(),
        ttlMs: 0,
      });
    }
  }

  getMasked(name: string): string | null {
    const secret = this.secrets.get(name);
    if (!secret) return null;
    return maskValue(secret.value);
  }

  /**
   * A check every {@link resolve} asks before it hands a value out, set by the engine once the
   * stores it reads exist (`connectionTokenAllowed`: a token of a connection whose mandate has
   * ended). A guard that throws withholds the value.
   */
  private resolveGuard: ((name: string) => boolean) | null = null;

  setResolveGuard(guard: ((name: string) => boolean) | null): void {
    this.resolveGuard = guard;
  }

  /**
   * `hash` of the value stored under `name` (an environment value over the vault, as
   * {@link resolve} reads it), or `''` when nothing is stored. It identifies WHICH credential
   * sits under the name, for the connection grants (`ApiStore`), so it asks none of `resolve`'s
   * questions about whether the value may be used now — consent, expiry, the resolve guard: a
   * withheld credential is still the same credential. The value goes into `hash` and nowhere
   * else (the engine passes a keyed hash, so a stored fingerprint of a weak password cannot be
   * attacked from a copy of the record), and the read is announced as its own action.
   */
  fingerprint(name: string, hash: (value: string) => string): string {
    const secret = this.secrets.get(name);
    channels.secretAccess.publish({ name, action: 'fingerprint' });
    return secret === undefined || secret.value === '' ? '' : hash(secret.value);
  }

  resolve(name: string): string | null {
    const secret = this.secrets.get(name);
    if (!secret) return null;
    if (this.isExpired(name)) return null;
    if (!this.hasConsent(name)) return null;
    if (this.resolveGuard !== null) {
      try {
        if (!this.resolveGuard(name)) return null;
      } catch {
        return null;
      }
    }

    channels.secretAccess.publish({ name, action: 'resolve' });
    return secret.value;
  }

  listNames(): string[] {
    return [...this.secrets.keys()];
  }

  /**
   * Every name with a row in the vault FILE. Not the same set as `listNames()`: the
   * map behind that is filled from the vault once, at construction, and code that
   * holds the vault itself writes past it afterwards (mail credentials through
   * `MailCredentialBackend`, Google OAuth tokens). Those rows are in the file and
   * never in the map.
   */
  listVaultNames(): string[] {
    return this.vault?.list().map(e => e.name) ?? [];
  }

  /** Rows in the vault file, or 0 without a vault. */
  get vaultRowCount(): number {
    return this.vault?.size ?? 0;
  }

  /**
   * Secret names the agent may see + reference. Excludes infrastructure secrets
   * (mail-account / OAuth / SMTP/IMAP / engine-internal) so they are never
   * advertised in the session briefing. `listNames()` still returns everything
   * for masking + the settings UI. A built-in provider's client secret is left out
   * too (`isPresetClientSecretName`): the engine reads it for the exchange, the model
   * has no use for it, and the agent refuses a reference to it.
   */
  listAgentVisibleNames(): string[] {
    return [...this.secrets.keys()].filter(n => !isInfraSecret(n) && !isPresetClientSecretName(n));
  }

  /**
   * Agent-visible stored names that reconcile against `requested` — the two near-miss
   * classes that otherwise loop the agent through "not in vault":
   *  1. NORMALIZED collision (uppercased, non-alphanumerics stripped) — a spelling
   *     variant (`Z_AI_API_KEY` vs a stored `ZAI_API_KEY`, both → `ZAIAPIKEY`).
   *  2. VENDOR namespace — the same leading UPPER_SNAKE token (`DATAFORSEO_API_LOGIN`
   *     vs a stored `DATAFORSEO_B64`), guarded by a generic-token stoplist so a
   *     generic first token (API/KEY/TOKEN/…) never groups every `API_*` secret.
   * Exact matches are excluded (not a mismatch); infra names are never surfaced
   * (listAgentVisibleNames already filters them); values never surface. Exact-first.
   */
  findNameMatches(requested: string): string[] {
    const norm = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const firstToken = (s: string): string => s.toUpperCase().split('_')[0] ?? '';
    // Generic leading tokens carry no vendor identity — matching on them would group
    // every unrelated API_*/KEY_* secret. A vendor match needs a distinctive first token.
    const GENERIC_TOKENS = new Set([
      'API', 'KEY', 'TOKEN', 'SECRET', 'AUTH', 'LOGIN', 'PASSWORD', 'PASS',
      'URL', 'ID', 'CLIENT', 'ACCESS', 'APP', 'USER', 'ACCOUNT', 'PUBLIC', 'PRIVATE',
    ]);
    const target = norm(requested);
    if (!target) return [];
    const reqVendor = firstToken(requested);
    const vendorMatchable = reqVendor.length >= 3 && !GENERIC_TOKENS.has(reqVendor);
    const visible = this.listAgentVisibleNames().filter(n => n !== requested);
    const exact = visible.filter(n => norm(n) === target);
    const vendor = vendorMatchable
      ? visible.filter(n => norm(n) !== target && firstToken(n) === reqVendor)
      : [];
    return [...exact, ...vendor];
  }

  /** Every value the maskers hide: the stored secrets and the engine's own env secrets. */
  private _maskedValues(): string[] {
    const values: string[] = [];
    for (const secret of this.secrets.values()) values.push(secret.value);
    values.push(...engineEnvSecretValues());
    return values;
  }

  containsSecret(text: string): boolean {
    for (const value of this._maskedValues()) {
      if (value.length < 2) continue; // skip single-char values to avoid false positives
      if (text.includes(value)) return true;
    }
    return false;
  }

  /** {@link holdsValueAsHost} over the stored values. The values never leave this object. */
  containsSecretAsHost(host: string): boolean {
    return holdsValueAsHost(host, this._maskedValues());
  }

  /**
   * Both maskers at once, over the original text — see
   * {@link maskSecretsAndPatterns}. The values never leave this object.
   */
  maskAll(text: string, opts?: { includeGeneric?: boolean }): string {
    return maskSecretsAndPatterns(text, this._maskedValues(), opts);
  }

  maskSecrets(text: string): string {
    return maskValuesIn(text, this._maskedValues());
  }

  recordConsent(name: string): void {
    this.consented.add(name);
    channels.secretAccess.publish({ name, action: 'consent' });
  }

  hasConsent(name: string): boolean {
    return this.consented.has(name);
  }

  isExpired(name: string): boolean {
    const secret = this.secrets.get(name);
    if (!secret) return true;
    if (secret.ttlMs === 0) return false;
    return Date.now() - secret.loadedAt > secret.ttlMs;
  }

  /**
   * True when `set()` will persist rather than throw. Callers that want to write
   * a secret only opportunistically — a boot-time migration that has nothing to
   * migrate on a vault-less install — check this instead of catching the throw,
   * so a legitimately vault-less boot is not mistaken for a failure.
   */
  canPersist(): boolean {
    return this.vault !== null;
  }

  /**
   * True when the vault file holds a row under `name`, decryptable or not. A
   * write-once marker checks this rather than `resolve()`: under a different
   * LYNOX_VAULT_KEY the row exists and does not resolve.
   */
  hasVaultRow(name: string): boolean {
    return this.vault?.has(name) ?? false;
  }

  /**
   * Store a secret in the vault and in-memory cache.
   * Requires a vault to be configured.
   */
  set(name: string, value: string, scope?: SecretScope | undefined, ttlMs?: number | undefined): void {
    if (!this.vault) {
      throw new Error('Cannot set secrets without a vault. Set LYNOX_VAULT_KEY to enable the vault.');
    }
    this.vault.set(name, value, scope, ttlMs);
    this.secrets.set(name, {
      name,
      value,
      scope: scope ?? 'any',
      loadedAt: Date.now(),
      ttlMs: ttlMs ?? 0,
    });
    channels.secretAccess.publish({ name, action: 'store' });
    // A secret written through set() is one the caller already holds in
    // plaintext and just minted (e.g. fetch_token → store → resolve). Without
    // recording consent, resolve() returns null until the next process
    // restart re-loads the vault as consented — so the very next
    // engine-managed auth resolve fails ("mint one first") and the flow loops,
    // burning the OAuth grant. Consent-on-store keeps freshly stored secrets
    // resolvable in the same process.
    this.recordConsent(name);
  }

  /** Drop the vault's free pages and empty its WAL, if a vault is attached. */
  scrubFreedPages(): void {
    this.vault?.scrubFreedPages();
  }

  /**
   * Delete a secret from the vault and in-memory cache.
   * Returns true if the secret was deleted.
   */
  deleteSecret(name: string): boolean {
    const hadInMemory = this.secrets.delete(name);
    this.consented.delete(name);
    const hadInVault = this.vault?.delete(name) ?? false;
    if (hadInMemory || hadInVault) {
      channels.secretAccess.publish({ name, action: 'delete' });
    }
    return hadInMemory || hadInVault;
  }

  extractSecretNames(input: unknown): string[] {
    return extractSecretRefNames(input);
  }

  resolveSecretRefs(input: unknown): unknown {
    return resolveSecretRefsWith(input, (name) => this.resolve(name));
  }

  /**
   * Like extractSecretNames but returns only the names that DON'T resolve
   * (no in-memory match, no vault match). Used by the agent's pre-tool gate
   * to refuse-with-clear-error instead of silently sending literal
   * `secret:NAME` strings to the external service — staging 2026-05-18
   * incident: agent POSTed the unresolved `secret:` reference literal to
   * Shopify because the vault didn't have that name; Shopify echoed the
   * literal in the error message and the agent mis-diagnosed it as
   * "http_request tool limitation" and recommended self-host. With this
   * gate the agent gets "vault has no SHOPIFY_CLIENT_ID, store it via
   * ask_secret first" and can recover correctly.
   */
  findUnresolvedSecretRefs(input: unknown): string[] {
    const names = this.extractSecretNames(input);
    return names.filter((n) => this.resolve(n) === null);
  }

  /** Whether a vault is attached */
  get hasVault(): boolean {
    return this.vault !== null;
  }

  /** Number of loaded secrets */
  get size(): number {
    return this.secrets.size;
  }
}
