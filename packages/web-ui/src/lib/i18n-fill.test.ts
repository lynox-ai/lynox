import { describe, it, expect } from 'vitest';
import { fillTemplate } from './i18n-fill.js';

/**
 * `fillTemplate` exists for one reason: a value carrying a `$`-substitution pattern must
 * not be able to rewrite the message it is placed into. That matters most in a confirmation
 * dialog — the one place the text has to be exactly what the user is agreeing to — and the
 * values that reach one (a remembered fact, a typed erase pattern) are free text.
 */
describe('fillTemplate — substitution-safe placeholder fill', () => {
	const TPL = 'Remove this entry? lynox will stop using it.\n\n{text}\n\nThis cannot be undone.';

	it('places a plain value verbatim', () => {
		expect(fillTemplate(TPL, { text: 'Company: Nordberg AG' })).toContain('Company: Nordberg AG');
	});

	// The set that is special in a replacement STRING. `$1` is NOT among them: with a string
	// pattern there are no capture groups, so it survives the naive form too — asserting
	// otherwise would be claiming a hazard that does not exist.
	for (const pattern of ['$&', "$'", '$`', '$$']) {
		it(`keeps ${pattern} literal instead of letting it rewrite the message`, () => {
			const value = `Firma: A${pattern}B`;
			const out = fillTemplate(TPL, { text: value });
			expect(out).toContain(value);
			// Pin that the naive form really does differ, or the test could pass for a reason
			// unrelated to the fix.
			expect(out).not.toBe(TPL.replace('{text}', value));
		});
	}

	it('leaves $1 alone, which the naive form also does — no false claim of a hazard', () => {
		const value = 'Firma: A$1B';
		expect(fillTemplate(TPL, { text: value })).toContain(value);
		expect(TPL.replace('{text}', value)).toContain(value);
	});

	it("$' does not truncate what follows the slot", () => {
		const out = fillTemplate(TPL, { text: "Preis: 100$'" });
		expect(out).toContain("Preis: 100$'");
		expect(out).toContain('This cannot be undone.'); // the naive replace ate this
	});

	it('fills every occurrence, not only the first', () => {
		expect(fillTemplate('{a} und {a}', { a: 'X' })).toBe('X und X');
	});

	it('leaves an unknown placeholder standing rather than blanking it', () => {
		// A typo should be visible, not silently delete text.
		expect(fillTemplate(TPL, { wrong: 'X' })).toContain('{text}');
	});

	it('fills an empty value without disturbing the rest', () => {
		expect(fillTemplate('a {x} b', { x: '' })).toBe('a  b');
	});
});
