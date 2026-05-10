// === Sensitive content detection (pre-classifier) ===
//
// Scans subject + body for patterns that should not reach the LLM by
// default: OTPs, password reset tokens, API keys, IBAN / credit-card
// numbers. The watcher hook decides what to do based on the configured
// mode:
//
//   skip  — block entirely; insert as requires_user, no LLM call
//   mask  — redact matched substrings, send the masked version to the LLM
//   allow — send raw to the LLM (only for trusted providers / DPAs)
//
// Pattern detection is conservative on purpose. False-positive cost is
// small (one extra Needs-You item, one click to archive). False-negative
// in `skip`/`mask` modes leaks the secret to a third-party LLM.
//
// Masking is defense-in-depth, NOT a guarantee — a cleverly-formatted
// OTP that doesn't match the patterns slips through. The audit log
// records what was matched + which mode applied so the user can verify.

export type SensitiveCategory =
  | 'otp_or_2fa'
  | 'password_reset'
  | 'api_key_or_secret'
  | 'credit_card'
  | 'iban';

export type SensitiveMode = 'skip' | 'mask' | 'allow';

export interface SensitiveDetection {
  isSensitive: boolean;
  /** Categories that fired — use the first one for the user-facing reason. */
  categories: SensitiveCategory[];
}

export interface MaskedContent {
  subject: string;
  body: string;
  /** Total replacement count across all categories — surfaces in audit. */
  redactionCount: number;
}

export interface SensitiveAnalysis extends SensitiveDetection {
  masked: MaskedContent;
}

function emptyAnalysis(subject: string, body: string): SensitiveAnalysis {
  return {
    isSensitive: false,
    categories: [],
    masked: { subject, body, redactionCount: 0 },
  };
}

// ── Patterns ───────────────────────────────────────────────────────────────

/**
 * OTP / 2FA / TAN keyword variants in DE / EN. `code` alone is included
 * — false positive on a "source code" mail also containing a 4-digit
 * number is acceptable (extra item in Needs-You is one click) compared
 * to a real OTP slipping through to the LLM.
 */
const OTP_KEYWORD_RE = /\b(?:otp|tan|code|verification|sicherheitscode|bestätigungscode|einmalcode|einmalkennwort|2fa|two[-\s]?factor|authentication\s*code|auth\s*code)\b/i;

/** A 4–8 digit run, optionally with a single dash or space splitter. */
const OTP_DIGIT_RE = /\b\d{4}(?:[-\s]?\d{2,4})?\b/;

const PASSWORD_RESET_RE = /\b(?:reset\s*(?:your)?\s*password|passwort\s*zurücksetzen|password\s*reset|magic\s*link|sign[-\s]?in\s*link|login\s*link|anmelde[-\s]?link)\b/i;

/**
 * Secret-prefix patterns from common providers. Exported (read-only) so
 * `scrubErrorMessage` in `runner.ts` can reuse the same set when sanitising
 * SDK error strings.
 */
export const SECRET_PREFIX_RES: ReadonlyArray<RegExp> = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,                  // Anthropic / OpenAI dash-style
  /\b(?:sk|rk|whsec|pk|live)_(?:live|test)_[A-Za-z0-9]{16,}\b/, // Stripe-style underscore keys
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,           // Slack
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/,             // GitHub PATs
  /\bAKIA[0-9A-Z]{16}\b/,                       // AWS access key
  /\bya29\.[A-Za-z0-9_-]{20,}\b/,               // Google OAuth refresh token
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/,           // Generic bearer tokens
  /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b/, // JWT (3 segments)
];

/**
 * Global variants of every SECRET_PREFIX_RES pattern — precomputed at
 * module load so the hot-path mask loop does not allocate a fresh
 * RegExp per inbound mail.
 */
const SECRET_PREFIX_RES_G: ReadonlyArray<RegExp> = SECRET_PREFIX_RES.map(
  (re) => new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`),
);

/**
 * Loose IBAN shape (country code + 2 check digits + 11..30 alnum).
 * Case-insensitive (`i` flag) — lowercase IBANs in body text are common
 * and the older case-sensitive variant let them through.
 */
const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/gi;

/** Plausible credit-card digit groups (13..19 digits w/ optional spaces/dashes). */
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;

/** URLs whose path or query mentions reset / verify / token / magic — likely sensitive. */
const RESET_LINK_RE = /https?:\/\/[^\s<>"]+(?:reset|verify|token|magic|otp|signin|sign-in)[^\s<>"]*/gi;

/** Standalone digit run for OTP redaction (only run after keyword + digit confirmed). */
const DIGIT_RUN_RE = /\b\d{4}(?:[-\s]?\d{2,4})?\b/g;

// ── Helpers ────────────────────────────────────────────────────────────────

/** Luhn check for credit-card validation. Reduces false positives on order numbers. */
function luhnValid(rawDigits: string): boolean {
  const digits = rawDigits.replace(/[ -]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    const d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    let v = alt ? d * 2 : d;
    if (v > 9) v -= 9;
    sum += v;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface DetectInput {
  subject: string;
  body: string;
}

/**
 * Run detection AND build a masked version of subject + body in one pass.
 * Use this when the configured `mode` is 'mask'; for 'skip' or 'allow'
 * the caller can ignore the `masked` field.
 */
export function analyzeSensitiveContent(input: DetectInput): SensitiveAnalysis {
  if ((input.subject + input.body).trim().length === 0) {
    return emptyAnalysis(input.subject, input.body);
  }

  const found = new Set<SensitiveCategory>();
  let maskedSubject = input.subject;
  let maskedBody = input.body;
  let redactions = 0;

  // OTP — keyword + digit-run anywhere in the haystack. When detected we
  // strip every standalone 4–8 digit run (over-redaction here is safe;
  // legitimate digit-runs in OTP-keyword mails are rare).
  const haystack = `${input.subject}\n${input.body}`;
  if (OTP_KEYWORD_RE.test(haystack) && OTP_DIGIT_RE.test(haystack)) {
    found.add('otp_or_2fa');
    maskedSubject = maskedSubject.replace(DIGIT_RUN_RE, () => {
      redactions++;
      return '[REDACTED:OTP]';
    });
    maskedBody = maskedBody.replace(DIGIT_RUN_RE, () => {
      redactions++;
      return '[REDACTED:OTP]';
    });
  }

  if (PASSWORD_RESET_RE.test(haystack)) {
    found.add('password_reset');
    // Redact reset/magic-link URLs — the keyword phrase itself is fine.
    maskedSubject = maskedSubject.replace(RESET_LINK_RE, () => {
      redactions++;
      return '[REDACTED:RESET-LINK]';
    });
    maskedBody = maskedBody.replace(RESET_LINK_RE, () => {
      redactions++;
      return '[REDACTED:RESET-LINK]';
    });
  }

  for (let i = 0; i < SECRET_PREFIX_RES.length; i++) {
    if (!SECRET_PREFIX_RES[i]!.test(haystack)) continue;
    found.add('api_key_or_secret');
    maskedSubject = maskedSubject.replace(SECRET_PREFIX_RES_G[i]!, () => {
      redactions++;
      return '[REDACTED:SECRET]';
    });
    maskedBody = maskedBody.replace(SECRET_PREFIX_RES_G[i]!, () => {
      redactions++;
      return '[REDACTED:SECRET]';
    });
  }

  // IBAN: shape match + at least one letter to avoid pure-digit false positives.
  const ibanMatches = [...haystack.matchAll(IBAN_RE)].filter((m) => /[A-Za-z]/.test(m[0]));
  if (ibanMatches.length > 0) {
    found.add('iban');
    for (const m of ibanMatches) {
      const inSubject = maskedSubject.split(m[0]).length - 1;
      const inBody = maskedBody.split(m[0]).length - 1;
      redactions += inSubject + inBody;
      maskedSubject = maskedSubject.split(m[0]).join('[REDACTED:IBAN]');
      maskedBody = maskedBody.split(m[0]).join('[REDACTED:IBAN]');
    }
  }

  // Credit card: shape + Luhn-valid.
  const cardCandidates = [...haystack.matchAll(CARD_RE)].filter((m) => luhnValid(m[0]));
  if (cardCandidates.length > 0) {
    found.add('credit_card');
    for (const m of cardCandidates) {
      const inSubject = maskedSubject.split(m[0]).length - 1;
      const inBody = maskedBody.split(m[0]).length - 1;
      redactions += inSubject + inBody;
      maskedSubject = maskedSubject.split(m[0]).join('[REDACTED:CARD]');
      maskedBody = maskedBody.split(m[0]).join('[REDACTED:CARD]');
    }
  }

  if (found.size === 0) {
    return emptyAnalysis(input.subject, input.body);
  }
  return {
    isSensitive: true,
    categories: [...found],
    masked: { subject: maskedSubject, body: maskedBody, redactionCount: redactions },
  };
}

/** Detection-only convenience for callers that don't need the masked text. */
export function detectSensitiveContent(input: DetectInput): SensitiveDetection {
  const out = analyzeSensitiveContent(input);
  return { isSensitive: out.isSensitive, categories: out.categories };
}

/**
 * Sanitize a free-text error message before persisting it to the audit
 * log or forwarding it to Bugsink. Strips every secret-prefix pattern
 * (Stripe, OpenAI, Slack, AWS, JWT, etc.) plus URL query strings, then
 * caps at 200 chars. SDK errors usually do not echo the request body,
 * but a chatty future SDK cannot leak prompt content into audit logs
 * or downstream Bugsink reports through this path.
 *
 * Lives next to SECRET_PREFIX_RES so the pattern set and the scrubber
 * cannot drift — and both the runner and the Mistral caller can import
 * it without creating a module cycle.
 */
export function scrubErrorMessage(input: string): string {
  if (!input) return '';
  let out = input;
  // Strip every known secret prefix BEFORE truncating so a 200-char cap
  // never accidentally clips off the redaction marker.
  for (let i = 0; i < SECRET_PREFIX_RES.length; i++) {
    out = out.replace(SECRET_PREFIX_RES_G[i]!, '[REDACTED:SECRET]');
  }
  return out
    .replace(/\?[^\s]+/g, '?[REDACTED-QUERY]')
    .slice(0, 200);
}

/** German user-facing reason for the audit-log + UI. */
export function reasonForCategories(categories: ReadonlyArray<SensitiveCategory>): string {
  const parts: string[] = [];
  for (const cat of categories) {
    switch (cat) {
      case 'otp_or_2fa': parts.push('OTP/2FA-Code'); break;
      case 'password_reset': parts.push('Passwort-Reset'); break;
      case 'api_key_or_secret': parts.push('API-Key/Secret'); break;
      case 'credit_card': parts.push('Kreditkarten-Nummer'); break;
      case 'iban': parts.push('IBAN'); break;
    }
  }
  const tag = parts.join(', ') || 'sensible Daten';
  return `Mail enthält ${tag} — nicht an Klassifizierer gesendet, manuell prüfen.`;
}
