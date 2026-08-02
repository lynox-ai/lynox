import { describe, it, expect } from 'vitest';
import { QUOTES } from './quotes.js';

/**
 * Guard against an ASCII-fold regression in the quote attributions.
 *
 * These names render on the empty-chat screen — a DE-first surface and one of
 * the first things a user sees — and two of them shipped stripped
 * (`Saint-Exupery`, `Dali`). The file carries non-ASCII throughout (em-dashes,
 * umlauts in the time-of-day lines), so the cause was a typo, not an encoding
 * limit, and the same typo is easy to reintroduce: a careless `sed`, an editor
 * saving as Latin-1, or someone hand-adding a quote from a plaintext source.
 *
 * Deliberately a NAME-SHAPED check rather than three string equalities. Asserting
 * `authors.includes('Antoine de Saint-Exupéry')` passes the moment someone adds
 * a SECOND, stripped entry for the same person — which is exactly how the file
 * got into this state (one of the two Saint-Exupéry lines was correct at some
 * point in its history). Asserting the stripped forms are ABSENT catches that.
 */

const ALL_AUTHORS = Object.values(QUOTES).flat().map((q) => q.author);

/** Names whose ASCII fold is a known, silent corruption of a real person. */
const MUST_CARRY_DIACRITICS: ReadonlyArray<{ stripped: string; correct: string }> = [
	{ stripped: 'Antoine de Saint-Exupery', correct: 'Antoine de Saint-Exupéry' },
	{ stripped: 'Salvador Dali', correct: 'Salvador Dalí' },
];

describe('quote attributions', () => {
	it('parses the catalogue at all', () => {
		// A guard that silently sees zero authors asserts nothing.
		expect(ALL_AUTHORS.length).toBeGreaterThan(100);
	});

	for (const { stripped, correct } of MUST_CARRY_DIACRITICS) {
		it(`never carries the ASCII fold "${stripped}"`, () => {
			expect(ALL_AUTHORS.filter((a) => a === stripped)).toEqual([]);
		});

		it(`still attributes "${correct}"`, () => {
			// The pair matters: deleting the entry outright would satisfy the
			// absence check above on its own.
			expect(ALL_AUTHORS).toContain(correct);
		});
	}
});
