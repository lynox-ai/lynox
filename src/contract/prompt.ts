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
export type ConsentKind = 'guard' | 'deep' | 'send' | 'google' | 'merge' | 'apply' | 'retire' | 'plan' | 'formula' | 'formula-text';

/** The fixed keys each kind offers, in the order they are shown. */
export const CONSENT_KEYS = {
  guard: ['allow', 'deny'],
  deep: ['deep', 'balanced', 'cancel'],
  /** A mail to send or a reply. */
  send: ['send', 'cancel'],
  /** A write in a Google service; its button names the action (`ConsentAction`). */
  google: ['confirm', 'cancel'],
  /** Subjects merged into one. */
  merge: ['merge', 'cancel'],
  /** A change to what lynox knows. */
  apply: ['apply', 'cancel'],
  /** Something lynox knows, retired. */
  retire: ['retire', 'cancel'],
  /** A plan to run; text typed instead is a change the person asks for (`consentTakesText`). */
  plan: ['proceed', 'adjust', 'cancel'],
  /** Sheets cells that start like a formula, after content from outside: written as text, as formulas, or not at all. */
  formula: ['as-text', 'as-formulas', 'cancel'],
  /**
   * The same question when some formulas are only counted: writing formulas the person was not
   * shown is not offered. A kind of its own, not a subset, since an answer is read against all
   * of its kind's keys. (Not `text`: that word is how `decideConsent` reports a plan's typed change.)
   */
  'formula-text': ['as-text', 'cancel'],
} as const;

export type ConsentKey = (typeof CONSENT_KEYS)[ConsentKind][number];

const CONSENT_KINDS: readonly ConsentKind[] = ['guard', 'deep', 'send', 'google', 'merge', 'apply', 'retire', 'plan', 'formula', 'formula-text'];

/** The code the reply route answers with when a consent got an answer that is none of its keys. */
export const CONSENT_UNRECOGNISED = 'unrecognised_answer';

export function isConsentKind(value: unknown): value is ConsentKind {
  return typeof value === 'string' && (CONSENT_KINDS as readonly string[]).includes(value);
}

/** The key `answer` is, exactly, among `kind`'s keys; anything else is no key at all. */
export function consentAnswer(kind: ConsentKind, answer: unknown): ConsentKey | undefined {
  if (typeof answer !== 'string') return undefined;
  const keys: readonly ConsentKey[] = CONSENT_KEYS[kind];
  return keys.find((key) => key === answer);
}

/**
 * Whether text typed instead of a key is a message of its own rather than an unrecognised
 * answer. Only for a plan: there it is the change the person asks for. It never approves.
 */
export function consentTakesText(kind: ConsentKind): boolean {
  return kind === 'plan';
}

/**
 * What a confirmation is about to do, for the kinds whose button names it (a Google write):
 * the client words the confirming key by it. It decides nothing — the key alone approves.
 */
export type ConsentAction = 'upload' | 'create' | 'move' | 'share' | 'overwrite' | 'append' | 'format' | 'update' | 'delete';

const CONSENT_ACTIONS: readonly ConsentAction[] = ['upload', 'create', 'move', 'share', 'overwrite', 'append', 'format', 'update', 'delete'];

export function isConsentAction(value: unknown): value is ConsentAction {
  return typeof value === 'string' && (CONSENT_ACTIONS as readonly string[]).includes(value);
}
