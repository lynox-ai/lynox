/**
 * A day of the month as a schedule line says it: German writes the number with a period after
 * it ("am 1."), which the sentence key carries; English writes an ordinal ("on the 1st").
 */
export function monthDay(day: number, locale: 'de' | 'en'): string {
	if (locale === 'de') return String(day);
	const lastTwo = day % 100;
	if (lastTwo >= 11 && lastTwo <= 13) return `${day}th`;
	switch (day % 10) {
		case 1: return `${day}st`;
		case 2: return `${day}nd`;
		case 3: return `${day}rd`;
		default: return `${day}th`;
	}
}

/**
 * A schedule as the person reading it lives it. The engine reads a cron in UTC
 * (`src/core/cron-parser.ts`), so its hour, and with the hour its day and weekday, are moved
 * into local time together. Where a monthly day cannot be said as one local day (a day 28 to 31
 * moved forward lands on a day some months do not have), it stays in UTC and says so.
 */
export type LocalSchedule =
	| { kind: 'hourly' }
	| { kind: 'daily'; time: string }
	| { kind: 'weekly'; weekday: number; time: string }
	| { kind: 'monthly'; day: number; time: string }
	| { kind: 'monthly_last'; time: string }
	| { kind: 'monthly_utc'; day: number; time: string }
	| { kind: 'raw'; cron: string };

const pad = (n: number): string => n.toString().padStart(2, '0');

/**
 * `offsetMinutes` is local time minus UTC in minutes (Zurich in winter +60, Los Angeles -480);
 * by default today's offset of this browser, as before: a run on the other side of a
 * daylight-saving change is shown with today's offset.
 */
export function localSchedule(cron: string, offsetMinutes: number = -new Date().getTimezoneOffset()): LocalSchedule {
	if (cron === '0 * * * *') return { kind: 'hourly' };
	const m = /^(\d+)\s+(\d+)\s+(\*|\d+)\s+\*\s+(\*|\d+)$/.exec(cron);
	if (!m) return { kind: 'raw', cron };
	const minute = Number(m[1]);
	const hour = Number(m[2]);
	if (minute > 59 || hour > 23) return { kind: 'raw', cron };
	// Minutes after the UTC midnight of the run's day, moved into local time; the whole days that
	// moves across are the shift of the day and the weekday (-1, 0 or 1).
	const local = hour * 60 + minute + offsetMinutes;
	const shift = Math.floor(local / 1440);
	const inDay = local - shift * 1440;
	const time = `${pad(Math.floor(inDay / 60))}:${pad(inDay % 60)}`;
	const dayField = m[3]!;
	const weekdayField = m[4]!;
	if (dayField !== '*') {
		const day = Number(dayField);
		if (day < 1 || day > 31) return { kind: 'raw', cron };
		if (shift === 0) return { kind: 'monthly', day, time };
		if (shift < 0) return day === 1 ? { kind: 'monthly_last', time } : { kind: 'monthly', day: day - 1, time };
		return day <= 27 ? { kind: 'monthly', day: day + 1, time } : { kind: 'monthly_utc', day, time: `${pad(hour)}:${pad(minute)}` };
	}
	if (weekdayField !== '*') {
		const weekday = Number(weekdayField);
		// 0 to 6 from Sunday, as the engine reads it (cron-parser.ts); nothing else can be stored.
		if (weekday > 6) return { kind: 'raw', cron };
		return { kind: 'weekly', weekday: ((weekday + shift) % 7 + 7) % 7, time };
	}
	return { kind: 'daily', time };
}
