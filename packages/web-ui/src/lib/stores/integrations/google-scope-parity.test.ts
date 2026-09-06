import { describe, it, expect } from 'vitest';
import { SCOPES } from '../../../../../../src/integrations/google/google-auth.js';
import { GOOGLE_SCOPE_IDS } from './google-scope-labels.js';

/**
 * The card has to recognise scope strings, and `google-auth.ts` reaches for
 * `node:http`/`node:crypto` — it cannot ship to a browser, so the strings are
 * re-declared rather than imported. That is a fork, and a fork with no test is
 * a drift waiting to happen: a typo in either copy is invisible until a
 * customer's card labels the wrong thing.
 *
 * This is a Node-side test, so importing core here is fine. It pins every id
 * the card knows to the value the engine requests.
 */
describe('the card and the engine agree on what each scope IS', () => {
	it('every scope id the card knows is the engine\'s value', () => {
		for (const [key, value] of Object.entries(GOOGLE_SCOPE_IDS)) {
			expect(SCOPES, `core has no SCOPES.${key}`).toHaveProperty(key);
			expect(value, `SCOPES.${key} drifted`).toBe((SCOPES as Record<string, string>)[key]);
		}
	});

	it('and the comparison can fail — positive control', () => {
		// Without this the loop above would pass on an empty object.
		expect(Object.keys(GOOGLE_SCOPE_IDS).length).toBeGreaterThanOrEqual(15);
		expect((SCOPES as Record<string, string>)['DRIVE_FILE']).not.toBe(
			(SCOPES as Record<string, string>)['DRIVE'],
		);
	});
});
