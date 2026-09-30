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

export const SECRET_SHAPES: ReadonlyArray<SecretShape> = [
  { label: 'Anthropic API key', kind: 'vendor', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { label: 'OpenAI API key', kind: 'vendor', pattern: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}\b/ },
  { label: 'OpenAI-style API key', kind: 'vendor', pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { label: 'Stripe API key', kind: 'vendor', pattern: /\b[sr]k_(live|test)_[A-Za-z0-9]{10,}\b/ },
  { label: 'GitHub token', kind: 'vendor', pattern: /\b(ghp|gho|ghs|ghr|ghu|github_pat)_[A-Za-z0-9_]{10,}\b/ },
  { label: 'AWS access key', kind: 'vendor', pattern: /\bAKIA[A-Z0-9]{16}\b/ },
  { label: 'Google API key', kind: 'vendor', pattern: /\bAIza[A-Za-z0-9_-]{35}\b/ },
  { label: 'Slack token', kind: 'vendor', pattern: /\bxox[bpoasr]-[A-Za-z0-9-]{10,}\b/ },
  { label: 'Shopify token', kind: 'vendor', pattern: /\bshp(at|ss|pa|ca)_[A-Fa-f0-9]{20,}\b/ },
  { label: 'JWT token', kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\b/ },
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
