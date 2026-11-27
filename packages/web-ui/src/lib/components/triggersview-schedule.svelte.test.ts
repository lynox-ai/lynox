import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getLocale, setLocale } from '../i18n.svelte.js';

// `svelte` resolves to its server entry under node, where `mount` throws. The component is compiled
// for the client, so it is mounted with the client entry, loaded by path.
const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

// A monthly schedule names its day as the language does: "am 1." in German, "on the 1st" in
// English, where the German period used to stand in both.

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let rows: Record<string, unknown>[] = [];
const locale = getLocale();

beforeEach(() => {
	rows = [];
	vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ triggers: rows, viewer: 'owner' }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
	vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	setLocale(locale);
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

async function render(): Promise<void> {
	const { default: TriggersView } = await import('./TriggersView.svelte');
	component = mount(TriggersView, { target });
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

const BASE = { status: 'open', source: 'cron', effect: 'run_agent', confirmed_at: '2026-11-10T00:00:00.000Z' };

function scheduleOf(title: string): string {
	const card = [...target.querySelectorAll('[data-trigger-title]')].find((e) => e.textContent?.trim() === title)?.closest('.group');
	return card?.querySelector('[data-trigger-schedule]')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

describe('a monthly schedule names its day as the language does', () => {
	// Zurich in winter, all year: the day must not depend on where the test runs.
	beforeEach(() => { vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-60); });
	const monthly = (): Record<string, unknown>[] => [
		{ ...BASE, id: 'm1', title: 'Erster', schedule_cron: '0 10 1 * *' },
		{ ...BASE, id: 'm22', title: 'Zweiundzwanzigster', schedule_cron: '0 10 22 * *' },
	];

	it('in English as an ordinal after "the"', async () => {
		setLocale('en');
		rows = monthly();
		await render();
		expect(scheduleOf('Erster')).toMatch(/^Monthly on the 1st at \d{1,2}:\d\d [AP]M$/);
		expect(scheduleOf('Zweiundzwanzigster')).toMatch(/^Monthly on the 22nd at \d{1,2}:\d\d [AP]M$/);
	});

	it('in German as the number with its period', async () => {
		setLocale('de');
		rows = monthly();
		await render();
		expect(scheduleOf('Erster')).toMatch(/^Monatlich am 1\. um \d\d:\d\d$/);
		expect(scheduleOf('Zweiundzwanzigster')).toMatch(/^Monatlich am 22\. um \d\d:\d\d$/);
	});
});

describe('a schedule near midnight names the local day', () => {
	const rowsOf = (): Record<string, unknown>[] => [
		{ ...BASE, id: 'w', title: 'Wochentag', schedule_cron: '0 23 * * 1' },
		{ ...BASE, id: 'l', title: 'Erster', schedule_cron: '0 2 1 * *' },
		{ ...BASE, id: 'u', title: 'Einunddreissigster', schedule_cron: '0 23 31 * *' },
	];
	// getTimezoneOffset is UTC minus local, in minutes.
	const inZone = (offset: number) => vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(offset);

	it('in Zurich: the next weekday, and a day 31 that moves forward stays in UTC', async () => {
		inZone(-60);
		setLocale('de');
		rows = rowsOf();
		await render();
		expect(scheduleOf('Wochentag')).toBe('Dienstags 00:00');
		expect(scheduleOf('Erster')).toBe('Monatlich am 1. um 03:00');
		expect(scheduleOf('Einunddreissigster')).toBe('Monatlich am 31. um 23:00 UTC');
	});

	it('in Los Angeles: day 1 moves back to the last day, in English too', async () => {
		inZone(480);
		setLocale('en');
		rows = rowsOf();
		await render();
		expect(scheduleOf('Wochentag')).toBe('Mondays 3:00 PM');
		expect(scheduleOf('Erster')).toBe('Monthly on the last day at 6:00 PM');
		expect(scheduleOf('Einunddreissigster')).toBe('Monthly on the 31st at 3:00 PM');
	});

	it('a day that moves is said as the local day, with that day\'s English ordinal', async () => {
		// The ordinal belongs to the day the reader lives, not to the day in the cron: 1 becomes the
		// 2nd and 10 the 11th forward; 2 becomes the 1st and 23 the 22nd back. A day that stays in UTC
		// keeps the cron's day, and its ordinal too.
		const moved = (): Record<string, unknown>[] => [
			{ ...BASE, id: 'f1', title: 'Vor', schedule_cron: '0 23 1 * *' },
			{ ...BASE, id: 'u31', title: 'Einunddreissig UTC', schedule_cron: '0 23 31 * *' },
			{ ...BASE, id: 'f10', title: 'Vor Zehn', schedule_cron: '0 23 10 * *' },
			{ ...BASE, id: 'b2', title: 'Zurück', schedule_cron: '0 2 2 * *' },
			{ ...BASE, id: 'b23', title: 'Zurück Dreiundzwanzig', schedule_cron: '0 2 23 * *' },
		];
		inZone(-60);
		setLocale('en');
		rows = moved();
		await render();
		expect(scheduleOf('Vor')).toBe('Monthly on the 2nd at 12:00 AM');
		expect(scheduleOf('Vor Zehn')).toBe('Monthly on the 11th at 12:00 AM');
		expect(scheduleOf('Einunddreissig UTC')).toBe('Monthly on the 31st at 11:00 PM UTC');
		unmount(component!);
		component = undefined;
		inZone(480);
		rows = moved();
		await render();
		expect(scheduleOf('Zurück')).toBe('Monthly on the 1st at 6:00 PM');
		expect(scheduleOf('Zurück Dreiundzwanzig')).toBe('Monthly on the 22nd at 6:00 PM');
	});

	it('across a clock change: a weekday that summer would move stays in UTC', async () => {
		// Winter today, summer in July: 22:00 UTC is Monday 23:00 now and Tuesday 00:00 then.
		vi.spyOn(Date.prototype, 'getTimezoneOffset').mockImplementation(function (this: Date) { return this.getMonth() >= 3 && this.getMonth() <= 9 ? -120 : -60; });
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], now: new Date('2026-01-15T12:00:00Z') });
		setLocale('de');
		rows = [{ ...BASE, id: 'd', title: 'Umstellung', schedule_cron: '0 22 * * 1' }];
		await render();
		expect(scheduleOf('Umstellung')).toBe('Montags 22:00 UTC');
	});

	it('a zone that changes for a few weeks between January and July still keeps the weekday in UTC', async () => {
		// Morocco 2026: +60 all year except about five weeks from mid-February into March, when it is 0.
		// 23:30 UTC is Tuesday 00:30 at +60 and Monday 23:30 at 0.
		vi.spyOn(Date.prototype, 'getTimezoneOffset').mockImplementation(function (this: Date) { return this.getMonth() === 2 ? 0 : -60; });
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], now: new Date('2026-07-15T12:00:00Z') });
		setLocale('de');
		rows = [{ ...BASE, id: 'r', title: 'Ramadan', schedule_cron: '30 23 * * 1' }];
		await render();
		expect(scheduleOf('Ramadan')).toBe('Montags 23:30 UTC');
	});
});

describe('a schedule said in words, or as a schedule of its own', () => {
	beforeEach(() => { vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-60); });

	const forms = (): Record<string, unknown>[] => [
		{ ...BASE, id: 'f1', title: 'Minute', schedule_cron: '* * * * *' },
		{ ...BASE, id: 'f2', title: 'Fünf', schedule_cron: '*/5 * * * *' },
		{ ...BASE, id: 'f3', title: 'Zwei Stunden', schedule_cron: '15 */2 * * *' },
		{ ...BASE, id: 'f4', title: 'Stunde', schedule_cron: '20 * * * *' },
		{ ...BASE, id: 'f5', title: 'Eigen', schedule_cron: '*/7 3-5 * * 1' },
		{ ...BASE, id: 'f6', title: 'Täglich', schedule_cron: '0 7 * * *' },
	];

	function titleOf(title: string): string | null {
		const card = [...target.querySelectorAll('[data-trigger-title]')].find((e) => e.textContent?.trim() === title)?.closest('.group');
		return card?.querySelector('[data-trigger-schedule]')?.getAttribute('title') ?? null;
	}

	it('in German', async () => {
		setLocale('de');
		rows = forms();
		await render();
		expect(['Minute', 'Fünf', 'Zwei Stunden', 'Stunde', 'Eigen', 'Täglich'].map(scheduleOf)).toEqual([
			'Jede Minute', 'Alle 5 Minuten', 'Alle 2 Stunden (01:15, 03:15, …)', 'Stündlich (00:20, 01:20, …)', 'Eigener Zeitplan', 'Täglich um 08:00',
		]);
		// The expression is not the label; it is there on hover, and only for a schedule of its own.
		expect(titleOf('Eigen')).toBe('*/7 3-5 * * 1');
		expect(titleOf('Täglich')).toBeNull();
	});

	it('in English, on the 12-hour clock', async () => {
		setLocale('en');
		rows = forms();
		await render();
		expect(['Minute', 'Fünf', 'Zwei Stunden', 'Stunde', 'Eigen', 'Täglich'].map(scheduleOf)).toEqual([
			'Every minute', 'Every 5 minutes', 'Every 2 hours (1:15 AM, 3:15 AM, …)', 'Every hour (12:20 AM, 1:20 AM, …)', 'Custom schedule', 'Daily at 8:00 AM',
		]);
		expect(titleOf('Eigen')).toBe('*/7 3-5 * * 1');
	});
});

describe('the dates on a card write their time as the schedule line does', () => {
	beforeEach(() => { vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-60); });

	function nextRunOf(title: string): string {
		const card = [...target.querySelectorAll('[data-trigger-title]')].find((e) => e.textContent?.trim() === title)?.closest('.group');
		return card?.querySelector('[data-next-run]')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
	}

	// 07:00 UTC, which is 08:00 in this browser's zone only if the runner sits there too: the
	// date is drawn in the runner's own zone, so the time is matched by its form, not its value.
	const next = '2099-03-04T07:00:00.000Z';

	it('in English on the 12-hour clock without a leading zero, like "Daily at 8:00 AM"', async () => {
		setLocale('en');
		rows = [{ ...BASE, id: 'd1', title: 'Täglich', schedule_cron: '0 7 * * *', next_run_at: next }];
		await render();
		expect(nextRunOf('Täglich')).toMatch(/, (1[0-2]|[1-9]):\d\d [AP]M$/);
	});

	it('in German on the 24-hour clock with a leading zero', async () => {
		setLocale('de');
		rows = [{ ...BASE, id: 'd1', title: 'Täglich', schedule_cron: '0 7 * * *', next_run_at: next }];
		await render();
		expect(nextRunOf('Täglich')).toMatch(/\d\d\.\d\d\.2099, \d\d:\d\d$/);
	});
});
