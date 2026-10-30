import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { privateToggleFailure, privateToggleOutcomeUnknown } from './private-toggle.js';

describe('privateToggleFailure — the page shows the state the server holds', () => {
	it('purge failed after the flag was stored: private mode stays ON, and the message says so', () => {
		// Rolling back here would show private mode OFF while it is on.
		expect(privateToggleFailure(false, { error: 'x', skip_extraction: true })).toEqual({
			skip: true,
			messageKey: 'threads.private_purge_incomplete',
		});
	});

	it('the server names a stored false: that wins over the previous value', () => {
		expect(privateToggleFailure(true, { skip_extraction: false })).toEqual({
			skip: false,
			messageKey: 'threads.error_extraction',
		});
	});

	it('no stored state in the answer (or no body at all): back to the previous value', () => {
		expect(privateToggleFailure(true, { error: 'Thread not found' })).toEqual({ skip: true, messageKey: 'threads.error_extraction' });
		expect(privateToggleFailure(false, null)).toEqual({ skip: false, messageKey: 'threads.error_extraction' });
		expect(privateToggleFailure(false, 'not json')).toEqual({ skip: false, messageKey: 'threads.error_extraction' });
	});

	it('a contained chat refuses to switch off: private mode stays ON, and the message says why', () => {
		// The engine's 409 for a chat that read data through a store connection carries `code: 'contained'`.
		expect(privateToggleFailure(true, { error: 'x', code: 'contained' })).toEqual({
			skip: true,
			messageKey: 'threads.error_contained',
			contained: true,
		});
		// A record the engine could not read: the same refusal, and where to look.
		for (const unknown of ['provisioned', 'self-hosted'] as const) {
			expect(privateToggleFailure(true, { error: 'x', code: 'contained', contained_unknown: unknown })).toEqual({
				skip: true,
				messageKey: 'threads.error_contained',
				contained: true,
				unknown,
			});
		}
		// A value the page does not know is a known record, as before.
		expect(privateToggleFailure(true, { error: 'x', code: 'contained', contained_unknown: 'other' })).toEqual({
			skip: true,
			messageKey: 'threads.error_contained',
			contained: true,
		});
		// Another refusal is not read as one.
		expect(privateToggleFailure(true, { error: 'x', code: 'other' })).toEqual({ skip: true, messageKey: 'threads.error_extraction' });
	});

	it('both toggles use it, and both messages exist in both languages', () => {
		const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
		for (const store of ['./chat.svelte.ts', './threads.svelte.ts']) {
			expect(read(store)).toMatch(/privateToggleFailure\(/);
			// The refusal's toast says what the engine could tell: read store data, or could not check.
			expect(read(store)).toContain("containedTextKeys('error', failure.unknown ?? null).map((k) => t(k)).join(' ')");
		}
		const i18n = read('../i18n.svelte.ts');
		for (const key of ['threads.private_purge_incomplete', 'threads.error_extraction', 'threads.error_contained']) {
			expect(i18n).toMatch(new RegExp(`'${key.replace('.', '\\.')}': \\{ de: '[^']+', en: '[^']+' \\}`));
		}
	});
});

describe('privateToggleOutcomeUnknown — when the page cannot know what the server holds', () => {
	it('no answer, or a server error naming no stored state: unknown', () => {
		expect(privateToggleOutcomeUnknown(null, null)).toBe(true);
		expect(privateToggleOutcomeUnknown(502, null)).toBe(true);
		expect(privateToggleOutcomeUnknown(500, { error: 'x' })).toBe(true);
	});

	it('a server error that names the stored state, or a refusal: known', () => {
		expect(privateToggleOutcomeUnknown(500, { error: 'x', skip_extraction: true })).toBe(false);
		expect(privateToggleOutcomeUnknown(500, { skip_extraction: false })).toBe(false);
		expect(privateToggleOutcomeUnknown(404, { error: 'Thread not found' })).toBe(false);
		expect(privateToggleOutcomeUnknown(499, null)).toBe(false);
	});
});
