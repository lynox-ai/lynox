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
