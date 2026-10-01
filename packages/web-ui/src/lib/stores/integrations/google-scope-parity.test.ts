import { describe, it, expect } from 'vitest';
import { SCOPES } from '../../../../../../src/integrations/google/google-auth.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

	it('the tool and the card agree on which Drive grants are WIDE', () => {
		// `google-drive.ts › withScopeNote` and `google-scope-labels.ts ›
		// driveIsAppFilesOnly` each list the scopes that reach beyond what lynox
		// created. Two lists, one meaning: if they drift, the card promises a
		// coverage limit the tool does not state, or the reverse. Two comments
		// saying "kept in step" is not a mechanism; this is.
		const tool = readFileSync(
			fileURLToPath(new URL('../../../../../../src/integrations/google/google-drive.ts', import.meta.url)), 'utf8');
		const card = readFileSync(
			fileURLToPath(new URL('./google-scope-labels.ts', import.meta.url)), 'utf8');

		const noteFn = tool.slice(tool.indexOf('function withScopeNote'));
		const toolWide = new Set([...noteFn.slice(0, noteFn.indexOf('\n}')).matchAll(/SCOPES\.(DRIVE[A-Z_]*)/g)].map(m => m[1]!));
		const predFn = card.slice(card.indexOf('export function driveIsAppFilesOnly'));
		const cardBody = predFn.slice(0, predFn.indexOf('\n}'));
		const cardWide = new Set([...cardBody.matchAll(/!held\.has\(S\.(DRIVE[A-Z_]*)\)/g)].map(m => m[1]!));

		// Positive control: both scans found something, so an empty-vs-empty
		// match cannot pass for agreement.
		expect(toolWide.size, 'the tool scan found no scopes').toBeGreaterThanOrEqual(3);
		expect(cardWide.size, 'the card scan found no scopes').toBeGreaterThanOrEqual(3);
		expect([...cardWide].sort()).toEqual([...toolWide].sort());
	});

	it('and the comparison can fail — positive control', () => {
		// Without this the loop above would pass on an empty object.
		expect(Object.keys(GOOGLE_SCOPE_IDS).length).toBeGreaterThanOrEqual(15);
		expect((SCOPES as Record<string, string>)['DRIVE_FILE']).not.toBe(
			(SCOPES as Record<string, string>)['DRIVE'],
		);
	});
});
