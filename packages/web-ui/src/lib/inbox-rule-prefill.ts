// === The value a link to the rule form carries: a fixed rule from a mail's sender or subject ===
//
// The server refuses a fixed rule whose value holds a character a reader does not see, a line
// break or a tab, more than FIXED_VALUE_MAX characters, a sender that is not one address, or a
// subject phrase under SUBJECT_MIN characters (`src/integrations/inbox/rule-text.ts`). A link
// that prefills such a value would end in that refusal, so the reading pane offers only a value
// the server takes. The rule compares the stored value with the mail's raw subject, so the
// subject phrase is a piece of the subject as it is: the longest run between hidden characters
// and line breaks, not the subject with them removed, which the subject would no longer contain.
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
 * The subject phrase a fixed rule may be made from: the longest run of the subject between
 * characters a reader does not see and line breaks, trimmed and cut to the cap; null when no run
 * holds SUBJECT_MIN characters.
 */
export function subjectRulePrefill(subject: string): string | null {
	const chars = Array.from(subject);
	const hidden = new Set(hiddenCharIndexes(subject));
	let best: string[] = [];
	let run: string[] = [];
	const close = (): void => {
		const piece = Array.from(run.join('').trim());
		if (piece.length > best.length) best = piece;
		run = [];
	};
	chars.forEach((c, i) => {
		if (hidden.has(i) || LINE_BREAKS.has(c)) close();
		else run.push(c);
	});
	close();
	const value = best.slice(0, FIXED_VALUE_MAX).join('').trim();
	if (Array.from(value).length < SUBJECT_MIN || !readsAsStored(value)) return null;
	return value;
}
