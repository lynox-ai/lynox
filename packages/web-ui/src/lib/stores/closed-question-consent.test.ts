import { describe, expect, it } from 'vitest';
import { isConsentCard } from './closed-question.js';

describe('isConsentCard', () => {
	it('is the engine\'s marker alone', () => {
		expect(isConsentCard('guard')).toBe(true);
		expect(isConsentCard('deep')).toBe(true);
	});

	it('is never read from option texts: a model\'s "Allow" / "Deny" is an ordinary question', () => {
		for (const v of [['Allow', 'Deny'], ['Run on balanced', 'Cancel'], ['allow', 'deny'], undefined, null, '', 'Allow', 'permission']) {
			expect(isConsentCard(v), JSON.stringify(v)).toBe(false);
		}
	});
});
