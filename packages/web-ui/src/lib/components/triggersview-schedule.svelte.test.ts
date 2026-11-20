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
	const monthly = (): Record<string, unknown>[] => [
		{ ...BASE, id: 'm1', title: 'Erster', schedule_cron: '0 10 1 * *' },
		{ ...BASE, id: 'm22', title: 'Zweiundzwanzigster', schedule_cron: '0 10 22 * *' },
	];

	it('in English as an ordinal after "the"', async () => {
		setLocale('en');
		rows = monthly();
		await render();
		expect(scheduleOf('Erster')).toMatch(/^Monthly on the 1st at \d\d:\d\d$/);
		expect(scheduleOf('Zweiundzwanzigster')).toMatch(/^Monthly on the 22nd at \d\d:\d\d$/);
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
		expect(scheduleOf('Wochentag')).toBe('Mondays 15:00');
		expect(scheduleOf('Erster')).toBe('Monthly on the last day at 18:00');
		expect(scheduleOf('Einunddreissigster')).toBe('Monthly on the 31st at 15:00');
	});
});
