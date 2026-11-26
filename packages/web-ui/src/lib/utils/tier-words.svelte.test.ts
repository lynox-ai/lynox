import { describe, it, expect, afterEach } from 'vitest';
import { setLocale, getLocale } from '../i18n.svelte.js';
import { effortName, isModelTier, thinkingName, tierName } from './tier-words.js';
import { STAMP_EFFORTS, STAMP_THINKING } from './workflow-stamp.js';

// A tier, a thoroughness and a thinking setting carry the names the settings use, in both languages,
// wherever the app shows one (U-477). A stored value is never the text.

const before = getLocale();
afterEach(() => setLocale(before));

describe('the names of a tier, a thoroughness and a thinking setting', () => {
	it('names every tier, and nothing that is not one', () => {
		setLocale('de');
		expect(['fast', 'balanced', 'deep'].map((v) => tierName(v))).toEqual(['Schnell', 'Ausgewogen', 'Tief']);
		setLocale('en');
		expect(['fast', 'balanced', 'deep'].map((v) => tierName(v))).toEqual(['Fast', 'Balanced', 'Deep']);
		for (const id of ['claude-sonnet-4-5', 'Fast', 'fast ', 'Ausgewogen', '']) {
			expect(tierName(id), id).toBeNull();
			expect(isModelTier(id), id).toBe(false);
		}
		// An older alias runs as its tier, so it carries that tier's name.
		setLocale('de');
		expect(['haiku', 'sonnet', 'opus'].map((v) => tierName(v))).toEqual(['Schnell', 'Ausgewogen', 'Tief']);
	});

	it('names every thoroughness and every thinking setting a stamp can carry, short, in both languages', () => {
		setLocale('de');
		expect(STAMP_EFFORTS.map(effortName)).toEqual(['Schnell', 'Ausgewogen', 'Gründlich', 'Sehr gründlich', 'Maximum']);
		expect(STAMP_THINKING.map(thinkingName)).toEqual(['Immer', 'Automatisch', 'Deaktiviert']);
		setLocale('en');
		expect(STAMP_EFFORTS.map(effortName)).toEqual(['Quick', 'Balanced', 'Thorough', 'Very thorough', 'Maximum']);
		expect(STAMP_THINKING.map(thinkingName)).toEqual(['Always', 'Automatic', 'Disabled']);
	});
});
