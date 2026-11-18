import { CONSENT_KEYS, consentAnswer, type ConsentKey, type ConsentKind } from '../contract/prompt.js';
import type { PromptMeta } from '../types/index.js';
import { UNATTENDED_BLOCK_ANSWER } from './prompt-store.js';

/**
 * How the engine asks for one of its own confirmations and reads the answer.
 *
 * The options are the kind's fixed keys (`src/contract/prompt.ts`), the question is marked
 * with the kind, and the answer counts only as exactly one of those keys. Nothing that reads
 * words decides here: a label, another language's word, text typed into the chat or an older
 * client's `y` approves nothing — and is told apart from a plain "no", so the person learns
 * their answer was not recognised.
 */

/** The options to offer: the kind's keys, and nothing to type in. */
export function consentOptions(kind: ConsentKind): string[] {
  return [...CONSENT_KEYS[kind]];
}

/** The question's meta, marked as the engine's own confirmation of `kind`. */
export function consentMeta(kind: ConsentKind, meta?: PromptMeta): PromptMeta {
  return { ...meta, consent: kind };
}

/**
 * What the answer decided: one of the kind's keys, `dismissed` when nobody answered (closed,
 * timed out, withdrawn, refused unattended), or `unrecognised` for any other text.
 */
export type ConsentOutcome = ConsentKey | 'dismissed' | 'unrecognised';

export function decideConsent(kind: ConsentKind, answer: string): ConsentOutcome {
  const key = consentAnswer(kind, answer);
  if (key !== undefined) return key;
  if (answer === '' || answer === '__dismissed__' || answer === UNATTENDED_BLOCK_ANSWER) return 'dismissed';
  return 'unrecognised';
}

/** Said to the model after a refusal, so it can tell the person why nothing happened. */
export const CONSENT_UNRECOGNISED_SENTENCE = 'The answer was not one of the offered choices, so nothing was allowed. An outdated page sends answers this version no longer reads: the person should reload it and ask again.';

/**
 * The refusal as said to the model: `refusal` as it is, and after an answer that was none of
 * the keys, the sentence that says so. Appended as a sentence of its own, so a refusal the person
 * decided ("— user declined.") still reads as one, and one they did not does not.
 */
export function consentRefusal(outcome: ConsentOutcome, refusal: string): string {
  return outcome === 'unrecognised' ? `${refusal} ${CONSENT_UNRECOGNISED_SENTENCE}` : refusal;
}
