import { describe, it, expect } from 'vitest';
import { clockTime, isCustomSchedule, localSchedule, monthDay } from './cron-human.js';

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
		for (const cron of ['*/7 * * * *', '0 */5 * * *', '0 9 * 1 *', '0 9 * * 7', '0 24 * * *', '60 9 * * *', '0 9 0 * *', '0 9 32 * *']) {
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
		expect(localSchedule('0 23 15 * *', ZURICH.winter, [ZURICH.winter, ZURICH.summer])).toEqual({ kind: 'monthly', day: 16, time: '00:00' });
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

describe('a schedule by the minute or by the hour', () => {
	const ZURICH_WINTER = 60;
	const INDIA = 330;

	it('says every minute, also as a step of one', () => {
		expect(localSchedule('* * * * *', ZURICH_WINTER)).toEqual({ kind: 'every_minute' });
		expect(localSchedule('*/1 * * * *', ZURICH_WINTER)).toEqual({ kind: 'every_minute' });
	});

	it('says every n minutes only where n divides the hour', () => {
		expect(localSchedule('*/5 * * * *', ZURICH_WINTER)).toEqual({ kind: 'every_minutes', n: 5 });
		expect(localSchedule('*/30 * * * *', ZURICH_WINTER)).toEqual({ kind: 'every_minutes', n: 30 });
		for (const cron of ['*/7 * * * *', '*/45 * * * *', '*/0 * * * *', '*/60 * * * *']) {
			expect(localSchedule(cron, ZURICH_WINTER)).toEqual({ kind: 'raw', cron });
		}
	});

	it('says every n hours with the first two local times of the day, only where n divides the day', () => {
		expect(localSchedule('15 */2 * * *', ZURICH_WINTER)).toEqual({ kind: 'every_hours', n: 2, times: ['01:15', '03:15'] });
		expect(localSchedule('0 */6 * * *', INDIA)).toEqual({ kind: 'every_hours', n: 6, times: ['05:30', '11:30'] });
		expect(localSchedule('0 */12 * * *', -480)).toEqual({ kind: 'every_hours', n: 12, times: ['04:00', '16:00'] });
		for (const cron of ['0 */5 * * *', '0 */7 * * *', '0 */24 * * *', '60 */2 * * *']) {
			expect(localSchedule(cron, ZURICH_WINTER)).toEqual({ kind: 'raw', cron });
		}
	});

	it('says every hour with its times at a minute past, and plainly on the hour', () => {
		expect(localSchedule('20 * * * *', ZURICH_WINTER)).toEqual({ kind: 'hourly_at', times: ['00:20', '01:20'] });
		expect(localSchedule('0 */1 * * *', ZURICH_WINTER)).toEqual({ kind: 'hourly' });
		expect(localSchedule('0 * * * *', ZURICH_WINTER)).toEqual({ kind: 'hourly' });
	});

	it('tells a schedule of its own from one said in words', () => {
		expect(isCustomSchedule('*/7 3-5 * * 1')).toBe(true);
		expect(isCustomSchedule('*/7 * * * *')).toBe(true);
		expect(isCustomSchedule('*/5 * * * *')).toBe(false);
		expect(isCustomSchedule('0 9 * * *')).toBe(false);
	});
});

describe('a time of day as the language writes it', () => {
	it('is the 24-hour clock with a leading zero in German', () => {
		expect(['00:00', '08:05', '12:00', '23:59'].map((t) => clockTime(t, 'de'))).toEqual(['00:00', '08:05', '12:00', '23:59']);
	});

	it('is the 12-hour clock without a leading zero in English, midnight and noon as 12', () => {
		expect(['00:00', '08:05', '11:59', '12:00', '13:30', '23:59'].map((t) => clockTime(t, 'en')))
			.toEqual(['12:00 AM', '8:05 AM', '11:59 AM', '12:00 PM', '1:30 PM', '11:59 PM']);
	});
});

describe('the edges of a worded schedule', () => {
	it('reads a step or a minute with a leading zero as the engine does', () => {
		expect(localSchedule('*/05 * * * *', 60)).toEqual({ kind: 'every_minutes', n: 5 });
		expect(localSchedule('05 */02 * * *', 60)).toEqual({ kind: 'every_hours', n: 2, times: ['01:05', '03:05'] });
	});

	it('reads fields split by more than one space, as the engine splits them', () => {
		expect(localSchedule('0  */2 * * *', 60)).toEqual({ kind: 'every_hours', n: 2, times: ['01:00', '03:00'] });
	});

	it('leaves to the expression what has more fields, or space before them, than it reads', () => {
		for (const cron of [' * * * * *', '0 0 */2 * * *', '0-30/5 * * * *']) {
			expect(localSchedule(cron, 60)).toEqual({ kind: 'raw', cron });
		}
	});

	it('says the times of an hourly schedule in a zone off the whole hour, also on the full UTC hour', () => {
		expect(localSchedule('0 * * * *', 330)).toEqual({ kind: 'hourly_at', times: ['00:30', '01:30'] });
		expect(localSchedule('0 */1 * * *', 330)).toEqual({ kind: 'hourly_at', times: ['00:30', '01:30'] });
		expect(localSchedule('30 * * * *', 330)).toEqual({ kind: 'hourly_at', times: ['00:00', '01:00'] });
	});

	it('moves the first times back in a zone behind UTC', () => {
		expect(localSchedule('45 */6 * * *', -480)).toEqual({ kind: 'every_hours', n: 6, times: ['04:45', '10:45'] });
	});

	it('keeps the engine\'s shorthand readable as it is, not as a schedule of its own', () => {
		for (const cron of ['5m', '1h', '1d', '30s']) {
			expect(localSchedule(cron, 60)).toEqual({ kind: 'interval', text: cron });
			expect(isCustomSchedule(cron)).toBe(false);
		}
	});
});
