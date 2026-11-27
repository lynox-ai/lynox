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
 * into local time together. It stays in UTC, and says so, where one local day or weekday would
 * not be true all year: a day 28 to 31 moved forward or 29 to 31 moved back lands on a day some
 * months lack, and a time near midnight can fall on another day once the clocks change.
 */
export type LocalSchedule =
	| { kind: 'hourly' }
	| { kind: 'daily'; time: string }
	| { kind: 'weekly'; weekday: number; time: string }
	| { kind: 'weekly_utc'; weekday: number; time: string }
	| { kind: 'monthly'; day: number; time: string }
	| { kind: 'monthly_last'; time: string }
	| { kind: 'monthly_utc'; day: number; time: string }
	| { kind: 'raw'; cron: string };

const pad = (n: number): string => n.toString().padStart(2, '0');

/**
 * This browser's offsets (local minus UTC, minutes) today and on the 1st and 15th of every month
 * of this year. January and July alone miss a zone that changes for a few weeks in between
 * (Morocco during Ramadan). The sample follows this year's rules only.
 */
function browserOffsets(): { now: number; year: number[] } {
	const y = new Date().getFullYear();
	const year: number[] = [];
	for (let month = 0; month < 12; month++) {
		for (const day of [1, 15]) year.push(-new Date(y, month, day).getTimezoneOffset());
	}
	return { now: -new Date().getTimezoneOffset(), year };
}

/**
 * `offsetMinutes` is local time minus UTC in minutes (Zurich in winter +60, Los Angeles -480),
 * by default this browser's today; the time is shown with it. `yearOffsets` are the offsets the
 * zone takes over the year (by default a sample of this year, see `browserOffsets`): a day or
 * weekday is moved only when every one of them moves it the same way.
 */
export function localSchedule(cron: string, offsetMinutes?: number, yearOffsets?: number[]): LocalSchedule {
	if (cron === '0 * * * *') return { kind: 'hourly' };
	const m = /^(\d+)\s+(\d+)\s+(\*|\d+)\s+\*\s+(\*|\d+)$/.exec(cron);
	if (!m) return { kind: 'raw', cron };
	const minute = Number(m[1]);
	const hour = Number(m[2]);
	if (minute > 59 || hour > 23) return { kind: 'raw', cron };
	const browser = offsetMinutes === undefined ? browserOffsets() : null;
	const now = offsetMinutes ?? browser!.now;
	const year = yearOffsets ?? browser?.year ?? [now];
	// Minutes after the UTC midnight of the run's day, moved into local time; the whole days that
	// moves across are the shift of the day and the weekday (-1, 0 or 1).
	const shiftAt = (offset: number): number => Math.floor((hour * 60 + minute + offset) / 1440);
	const local = hour * 60 + minute + now;
	const shift = shiftAt(now);
	const inDay = local - shift * 1440;
	const time = `${pad(Math.floor(inDay / 60))}:${pad(inDay % 60)}`;
	const utcTime = `${pad(hour)}:${pad(minute)}`;
	const steady = year.every((o) => shiftAt(o) === shift);
	const dayField = m[3]!;
	const weekdayField = m[4]!;
	if (dayField !== '*') {
		const day = Number(dayField);
		if (day < 1 || day > 31) return { kind: 'raw', cron };
		if (shift === 0 && steady) return { kind: 'monthly', day, time };
		if (!steady) return { kind: 'monthly_utc', day, time: utcTime };
		if (shift < 0) {
			if (day === 1) return { kind: 'monthly_last', time };
			return day <= 28 ? { kind: 'monthly', day: day - 1, time } : { kind: 'monthly_utc', day, time: utcTime };
		}
		return day <= 27 ? { kind: 'monthly', day: day + 1, time } : { kind: 'monthly_utc', day, time: utcTime };
	}
	if (weekdayField !== '*') {
		const weekday = Number(weekdayField);
		// 0 to 6 from Sunday, as the engine reads it (cron-parser.ts); it rejects anything else.
		if (weekday > 6) return { kind: 'raw', cron };
		if (!steady) return { kind: 'weekly_utc', weekday, time: utcTime };
		return { kind: 'weekly', weekday: ((weekday + shift) % 7 + 7) % 7, time };
	}
	return { kind: 'daily', time };
}
