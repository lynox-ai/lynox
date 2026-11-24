// === The value a link to the rule form carries: a fixed rule from a mail's sender or subject ===
//
// The server refuses a fixed rule whose value holds a character a reader does not see, a line
// break or a tab, more than FIXED_VALUE_MAX characters, a sender that is not one address, or a
// subject phrase under SUBJECT_MIN characters (`src/integrations/inbox/rule-text.ts`). A link
// that prefills such a value would end in that refusal, so the reading pane offers only a value
// the server takes. The pane reads the subject and sender as the inbox stored them, and the rule
// match compares both the mail and the rule value in that stored form, so the stored subject
// (cut to the cap) matches the mail it came from. A subject that still holds a character the
// server refuses is not offered at all: a piece of it would be a broader rule than the owner chose.
// `tests/inbox-rule-prefill-drift.test.ts` holds these checks against the server's.

import { hiddenCharIndexes } from './hidden-chars.js';

/** A subject fragment shorter than this would file almost every mail (as the server counts). */
export const SUBJECT_MIN = 3;
/** The longest value of a fixed rule, in characters (code points), as the server counts. */
export const FIXED_VALUE_MAX = 200;

const LINE_BREAKS = new Set(['\t', '\n', '\r']);

/** True when the value is one bare sender address, as the server compares it with the sender. */
export function isOneSenderAddress(value: string): boolean {
	return /^[^\s@<>()[\]{},;:"`]+@[^\s@<>()[\]{},;:"`]+$/.test(value);
}

/** True when the server would take `value` as stored: nothing hidden, one line, within the cap. */
function readsAsStored(value: string): boolean {
	return hiddenCharIndexes(value).length === 0 && ![...value].some((c) => LINE_BREAKS.has(c)) && Array.from(value).length <= FIXED_VALUE_MAX;
}

/** The sender a fixed rule may be made from, or null when it is not one address. */
export function senderRulePrefill(fromAddress: string): string | null {
	const value = fromAddress.trim();
	return value.length > 0 && readsAsStored(value) && isOneSenderAddress(value.toLowerCase()) ? value : null;
}

/**
 * The subject phrase a fixed rule may be made from: the whole subject, trimmed and cut to the
 * cap; null when it holds a character a reader does not see or a line break, or is shorter than
 * SUBJECT_MIN characters.
 */
export function subjectRulePrefill(subject: string): string | null {
	const whole = subject.trim();
	// The whole subject, not only the part within the cap.
	if (hiddenCharIndexes(whole).length > 0 || [...whole].some((c) => LINE_BREAKS.has(c))) return null;
	// A cut can end between the parts of an emoji, which then reads as hidden: checked again.
	const value = Array.from(whole).slice(0, FIXED_VALUE_MAX).join('').trim();
	if (Array.from(value).length < SUBJECT_MIN || !readsAsStored(value)) return null;
	return value;
}
