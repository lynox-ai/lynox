/**
 * Credential shapes the web UI recognises in chat input and masks in display.
 *
 * A copy of the engine's shared list (`src/core/secret-store.ts` `SECRET_SHAPES`)
 * restricted to the kinds that are a credential wherever they appear — `vendor`,
 * `jwt`, `key-block`. The web UI is a separate package and cannot import the
 * engine, so it keeps this copy; `tests/secret-shapes-parity.test.ts` holds it
 * equal to the engine's list for those kinds, in both directions. Edit the
 * engine list first, then mirror the change here.
 */
export type SecretShapeKind = 'vendor' | 'jwt' | 'key-block';
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
 * JWTs are not built this way; they keep `\b`. A copy of the engine's helper; the parity
 * test compares the resulting pattern sources.
 */
const CREDENTIAL_GLUE = String.raw`(?<=_|\\[a-z]|\\u[0-9A-Fa-f]{4}|%[0-9A-Fa-f]{2})`;
function credentialShape(prefix: string, body: string, flags?: string, end = String.raw`\b`): RegExp {
  return new RegExp(
    String.raw`(?:(?<![A-Za-z0-9_])` + prefix + '|' + CREDENTIAL_GLUE + prefix + String.raw`(?=[A-Za-z0-9]{0,128}[0-9]))` + body + end,
    flags,
  );
}

export const SECRET_SHAPES: ReadonlyArray<SecretShape> = [
  { label: 'Anthropic API key', kind: 'vendor', pattern: credentialShape(String.raw`sk-ant-`, String.raw`[A-Za-z0-9_-]{20,}`) },
  { label: 'OpenAI API key', kind: 'vendor', pattern: credentialShape(String.raw`sk-(?:proj|svcacct|admin)-`, String.raw`[A-Za-z0-9_-]{20,}`) },
  { label: 'OpenAI-style API key', kind: 'vendor', pattern: credentialShape(String.raw`sk-`, String.raw`[A-Za-z0-9]{20,}`) },
  { label: 'Stripe API key', kind: 'vendor', pattern: credentialShape(String.raw`[sr]k_(live|test)_`, String.raw`[A-Za-z0-9]{10,}`) },
  { label: 'GitHub token', kind: 'vendor', pattern: credentialShape(String.raw`(ghp|gho|ghs|ghr|ghu|github_pat)_`, String.raw`[A-Za-z0-9_]{10,}`) },
  { label: 'AWS access key', kind: 'vendor', pattern: credentialShape(String.raw`AKIA`, String.raw`[A-Z0-9]{16}`) },
  { label: 'Google API key', kind: 'vendor', pattern: credentialShape(String.raw`AIza`, String.raw`[A-Za-z0-9_-]{35}`) },
  { label: 'Slack token', kind: 'vendor', pattern: credentialShape(String.raw`xox[bpoasr]-`, String.raw`[A-Za-z0-9-]{10,}`) },
  { label: 'Shopify token', kind: 'vendor', pattern: credentialShape(String.raw`shp(at|ss|pa|ca)_`, String.raw`[A-Fa-f0-9]{20,}`) },
  { label: 'JWT token', kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\b/ },
  { label: 'Google OAuth token', kind: 'vendor', pattern: credentialShape(String.raw`ya29\.`, String.raw`[A-Za-z0-9_-]{20,}`) },
  { label: 'private key', kind: 'key-block', pattern: /-----BEGIN\s+(?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED)\s+)?PRIVATE\s+KEY-----/ },
];

/**
 * Chat input guard: true when a paste contains a credential shape, so the input
 * is rejected with `chat.secret_warning`. The trailing word boundary is dropped
 * so a key followed directly by a word character is still caught.
 */
const SECRET_INPUT_PATTERNS: ReadonlyArray<RegExp> = SECRET_SHAPES.map(
  (s) => new RegExp(s.pattern.source.replace(/\\b$/, ''), s.pattern.flags),
);

export function looksLikeSecret(text: string): boolean {
  return SECRET_INPUT_PATTERNS.some((p) => p.test(text));
}
