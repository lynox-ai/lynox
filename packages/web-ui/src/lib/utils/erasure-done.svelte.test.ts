import { describe, it, expect, afterEach } from 'vitest';
import { setLocale } from '../i18n.svelte.js';
import { erasureDoneText } from './erasure-done.js';

describe('the person erasure done line', () => {
	afterEach(() => setLocale('de'));

	const cases: Array<[number, number, string, string]> = [
		[0, 0, 'Gelöscht: keine Einträge und keine Erinnerungen.', 'Erased: no entries and no memories.'],
		[0, 2, 'Gelöscht: 2 Erinnerungen.', 'Erased: 2 memories.'],
		[3, 0, 'Gelöscht: 3 Einträge.', 'Erased: 3 entries.'],
		[0, 1, 'Gelöscht: 1 Erinnerung.', 'Erased: 1 memory.'],
		[1, 0, 'Gelöscht: 1 Eintrag.', 'Erased: 1 entry.'],
		[1, 1, 'Gelöscht: 1 Eintrag und 1 Erinnerung.', 'Erased: 1 entry and 1 memory.'],
		[1, 2, 'Gelöscht: 1 Eintrag und 2 Erinnerungen.', 'Erased: 1 entry and 2 memories.'],
		[2, 1, 'Gelöscht: 2 Einträge und 1 Erinnerung.', 'Erased: 2 entries and 1 memory.'],
		[2, 2, 'Gelöscht: 2 Einträge und 2 Erinnerungen.', 'Erased: 2 entries and 2 memories.'],
	];

	it.each(cases)('reads %i entries and %i memories in the agreed wording, in DE and EN', (entries, memories, de, en) => {
		setLocale('de');
		expect(erasureDoneText(entries, memories)).toBe(de);
		setLocale('en');
		expect(erasureDoneText(entries, memories)).toBe(en);
	});
});
