/**
 * Engine ↔ web-ui wire contract for the engine's own confirmation questions.
 *
 * VENDORED DOWNSTREAM — edit ONLY here (`core/src/contract/`); see `README.md`.
 * The web-ui carries a byte-identical copy (`packages/web-ui/src/lib/contract/`).
 *
 * A confirmation the engine asks for itself (the permission guard, the deep-tier
 * consent, a tool's consent to send or store) is marked with its `ConsentKind` and
 * offers fixed keys, never words. The client decides how the card looks from the
 * marker alone, never from the option texts, and shows each key in its own words.
 * An answer approves only when it is exactly one of the kind's keys: any other text
 * — a label, a word in another language, an older client's `y`, typed text that is
 * not exactly a key — approves nothing.
 *
 * DEPENDENCY-FREE: pure literals, types, and functions.
 */

/** Which of the engine's own confirmations a question is. */
export type ConsentKind = 'guard' | 'deep';

/** The fixed keys each kind offers, in the order they are shown. */
export const CONSENT_KEYS = {
  guard: ['allow', 'deny'],
  deep: ['deep', 'balanced', 'cancel'],
} as const;

export type ConsentKey = (typeof CONSENT_KEYS)[ConsentKind][number];

/** The code the reply route answers with when a consent got an answer that is none of its keys. */
export const CONSENT_UNRECOGNISED = 'unrecognised_answer';

export function isConsentKind(value: unknown): value is ConsentKind {
  return value === 'guard' || value === 'deep';
}

/** The key `answer` is, exactly, among `kind`'s keys; anything else is no key at all. */
export function consentAnswer(kind: ConsentKind, answer: unknown): ConsentKey | undefined {
  if (typeof answer !== 'string') return undefined;
  const keys: readonly ConsentKey[] = CONSENT_KEYS[kind];
  return keys.find((key) => key === answer);
}
