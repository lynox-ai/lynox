import { describe, it, expect } from 'vitest';
import { localSchedule, monthDay } from './cron-human.js';

describe('a day of the month in a schedule line', () => {
	it('is an English ordinal: st, nd, rd, and th for 11 to 13 and the rest', () => {
		const shown = [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 24, 31].map((d) => monthDay(d, 'en'));
		expect(shown).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '24th', '31st']);
	});

	it('is the bare number in German, where the sentence carries the period', () => {
		expect([1, 11, 22].map((d) => monthDay(d, 'de'))).toEqual(['1', '11', '22']);
	});
});

describe('a UTC schedule as the reader lives it', () => {
	const ZURICH_WINTER = 60;
	const LOS_ANGELES = -480;

	it('moves the weekday with the hour across midnight, both ways', () => {
		// Measured 2026-11-20: 0 23 * * 1 runs Tuesday 00:00 in Zurich, and was shown as Monday.
		expect(localSchedule('0 23 * * 1', ZURICH_WINTER)).toEqual({ kind: 'weekly', weekday: 2, time: '00:00' });
		expect(localSchedule('0 23 * * 6', ZURICH_WINTER)).toEqual({ kind: 'weekly', weekday: 0, time: '00:00' });
		expect(localSchedule('0 2 * * 1', LOS_ANGELES)).toEqual({ kind: 'weekly', weekday: 0, time: '18:00' });
		expect(localSchedule('0 2 * * 0', LOS_ANGELES)).toEqual({ kind: 'weekly', weekday: 6, time: '18:00' });
		expect(localSchedule('0 9 * * 1', ZURICH_WINTER)).toEqual({ kind: 'weekly', weekday: 1, time: '10:00' });
	});

	it('moves a monthly day with the hour, and says the last day where day 1 moves back', () => {
		expect(localSchedule('0 23 1 * *', ZURICH_WINTER)).toEqual({ kind: 'monthly', day: 2, time: '00:00' });
		expect(localSchedule('0 23 27 * *', ZURICH_WINTER)).toEqual({ kind: 'monthly', day: 28, time: '00:00' });
		expect(localSchedule('0 2 15 * *', LOS_ANGELES)).toEqual({ kind: 'monthly', day: 14, time: '18:00' });
		expect(localSchedule('0 2 1 * *', LOS_ANGELES)).toEqual({ kind: 'monthly_last', time: '18:00' });
		expect(localSchedule('0 10 1 * *', ZURICH_WINTER)).toEqual({ kind: 'monthly', day: 1, time: '11:00' });
	});

	it('keeps a day 28 to 31 that moves forward in UTC, since some months lack the day it would land on', () => {
		for (const day of [28, 29, 30, 31]) {
			expect(localSchedule(`0 23 ${day} * *`, ZURICH_WINTER)).toEqual({ kind: 'monthly_utc', day, time: '23:00' });
		}
	});

	it('moves only the hour of a daily schedule, and leaves what it cannot read as it is', () => {
		expect(localSchedule('30 23 * * *', ZURICH_WINTER)).toEqual({ kind: 'daily', time: '00:30' });
		expect(localSchedule('0 * * * *', ZURICH_WINTER)).toEqual({ kind: 'hourly' });
		for (const cron of ['*/5 * * * *', '0 9 * 1 *', '0 9 * * 7', '0 24 * * *', '60 9 * * *', '0 9 0 * *', '0 9 32 * *']) {
			expect(localSchedule(cron, ZURICH_WINTER)).toEqual({ kind: 'raw', cron });
		}
	});
});

describe('a schedule stays in UTC where one local day would not hold all year', () => {
	const LOS_ANGELES = -480;
	const ZURICH = { winter: 60, summer: 120 };

	it('keeps a day 29 to 31 that moves back in UTC, and moves 28 back to the 27th', () => {
		for (const day of [29, 30, 31]) {
			expect(localSchedule(`0 2 ${day} * *`, LOS_ANGELES)).toEqual({ kind: 'monthly_utc', day, time: '02:00' });
		}
		expect(localSchedule('0 2 28 * *', LOS_ANGELES)).toEqual({ kind: 'monthly', day: 27, time: '18:00' });
	});

	it('keeps a day or weekday in UTC when the clock change would move it, and moves it when it does not', () => {
		// 22:00 UTC is 23:00 in a Zurich winter and 00:00 the next day in summer.
		expect(localSchedule('0 22 * * 1', ZURICH.winter, [ZURICH.winter, ZURICH.summer])).toEqual({ kind: 'weekly_utc', weekday: 1, time: '22:00' });
		expect(localSchedule('0 22 15 * *', ZURICH.winter, [ZURICH.winter, ZURICH.summer])).toEqual({ kind: 'monthly_utc', day: 15, time: '22:00' });
		expect(localSchedule('0 22 1 * *', ZURICH.summer, [ZURICH.winter, ZURICH.summer])).toEqual({ kind: 'monthly_utc', day: 1, time: '22:00' });
		// 23:00 UTC is the next day in both seasons; 10:00 UTC is the same day in both.
		expect(localSchedule('0 23 * * 1', ZURICH.winter, [ZURICH.winter, ZURICH.summer])).toEqual({ kind: 'weekly', weekday: 2, time: '00:00' });
		expect(localSchedule('0 10 * * 1', ZURICH.summer, [ZURICH.winter, ZURICH.summer])).toEqual({ kind: 'weekly', weekday: 1, time: '12:00' });
		// Daily: only the hour moves, whatever the season.
		expect(localSchedule('0 22 * * *', ZURICH.winter, [ZURICH.winter, ZURICH.summer])).toEqual({ kind: 'daily', time: '23:00' });
	});

	it('moves by offsets that are not whole hours, and at the ends of the range', () => {
		expect(localSchedule('45 23 * * 1', 15)).toEqual({ kind: 'weekly', weekday: 2, time: '00:00' });
		expect(localSchedule('30 20 * * 5', 330)).toEqual({ kind: 'weekly', weekday: 6, time: '02:00' });
		expect(localSchedule('15 2 * * 0', -210)).toEqual({ kind: 'weekly', weekday: 6, time: '22:45' });
		expect(localSchedule('0 0 * * 0', -720)).toEqual({ kind: 'weekly', weekday: 6, time: '12:00' });
		expect(localSchedule('59 23 * * 6', 840)).toEqual({ kind: 'weekly', weekday: 0, time: '13:59' });
	});
});
