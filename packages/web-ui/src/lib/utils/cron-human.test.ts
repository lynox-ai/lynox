import { describe, it, expect } from 'vitest';
import { monthDay } from './cron-human.js';

describe('a day of the month in a schedule line', () => {
	it('is an English ordinal: st, nd, rd, and th for 11 to 13 and the rest', () => {
		const shown = [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 24, 31].map((d) => monthDay(d, 'en'));
		expect(shown).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '24th', '31st']);
	});

	it('is the bare number in German, where the sentence carries the period', () => {
		expect([1, 11, 22].map((d) => monthDay(d, 'de'))).toEqual(['1', '11', '22']);
	});
});
