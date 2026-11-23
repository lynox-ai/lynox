import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t, setLocale } from '../i18n.svelte.js';

// The schedules list says how a trigger's last run ended in a word, not by colour alone, and a
// next run whose time has passed reads as due since then, not as a next run before the last one.

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

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let rows: Record<string, unknown>[] = [];

beforeEach(() => {
	rows = [];
	vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ triggers: rows }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
	vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

async function render(locale: 'de' | 'en' = 'en'): Promise<void> {
	setLocale(locale);
	const { default: TriggersView } = await import('./TriggersView.svelte');
	component = mount(TriggersView, { target });
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

const BASE = { status: 'open', source: 'cron', effect: 'run_agent', confirmed_at: '2026-10-01T00:00:00.000Z', enabled: 1 };
const HOUR = 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();

/** The "last run" line of each trigger, by its status. */
function lastRunLines(): Record<string, string> {
	return Object.fromEntries([...target.querySelectorAll<HTMLElement>('[data-run-status]')].map((e) => [e.dataset['runStatus'] ?? '', (e.textContent ?? '').replace(/\s+/g, ' ').trim()]));
}

describe('the last run of a trigger says how it ended in a word', () => {
	it.each(['en', 'de'] as const)('%s: a failed and a timed-out run carry their word, as halted, interrupted and stopped do; a success carries none', async (locale) => {
		const statuses = ['success', 'failed', 'timeout', 'halted', 'interrupted', 'stopped'];
		rows = statuses.map((s, i) => ({ ...BASE, id: `t-${s}`, title: `T ${i}`, last_run_at: '2026-11-23T08:00:00.000Z', last_run_status: s }));
		await render(locale);
		const lines = lastRunLines();
		expect(Object.keys(lines).sort()).toEqual([...statuses].sort());
		const word: Record<string, string> = {
			failed: t('tasks.run_failed'),
			timeout: t('tasks.run_timeout'),
			halted: t('tasks.run_halted'),
			interrupted: t('tasks.run_interrupted'),
			stopped: t('tasks.run_stopped'),
		};
		for (const [status, text] of Object.entries(word)) {
			expect(text.length, `${status} has a word`).toBeGreaterThan(0);
			expect(lines[status]).toMatch(new RegExp(`· ${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
		}
		expect(lines['success']).not.toContain('·');
		// The two red ones are told apart by their words, not only from the green one.
		expect(t('tasks.run_failed')).not.toBe(t('tasks.run_timeout'));
	});

	it('words them as they are worded, in both languages', async () => {
		const { readFileSync } = await import('node:fs');
		const src = readFileSync(join(dirname(new URL(import.meta.url).pathname), '../i18n.svelte.ts'), 'utf8');
		for (const line of [
			"'tasks.run_failed': { de: 'fehlgeschlagen', en: 'failed' },",
			"'tasks.run_timeout': { de: 'nach dem Zeitlimit abgebrochen', en: 'cut off at the time limit' },",
			"'tasks.due_since': { de: 'Fällig seit', en: 'Due since' },",
		]) expect(src).toContain(line);
	});
});

describe('a next run whose time has passed', () => {
	it.each(['en', 'de'] as const)('%s: reads as due since then, and a later one as the next run', async (locale) => {
		const now = Date.now();
		rows = [
			{ ...BASE, id: 'past', title: 'Past', next_run_at: iso(now - HOUR), last_run_at: iso(now - HOUR / 2), last_run_status: 'success' },
			{ ...BASE, id: 'future', title: 'Future', next_run_at: iso(now + HOUR) },
		];
		await render(locale);
		const next = [...target.querySelectorAll<HTMLElement>('[data-next-run]')].map((e) => [e.dataset['nextRun'], (e.textContent ?? '').trim()]);
		expect(next.map(([kind]) => kind)).toEqual(['due', 'next']);
		expect(next[0]![1]!.startsWith(`${t('tasks.due_since')}: `)).toBe(true);
		expect(next[1]![1]!.startsWith(`${t('tasks.next_run')}: `)).toBe(true);
		expect(t('tasks.due_since')).not.toBe(t('tasks.next_run'));
	});

	it('is not said of a paused, switched-off, parked, completed or stopped plan: it is not due', async () => {
		const now = Date.now();
		rows = [
			{ ...BASE, id: 'paused', title: 'Paused', next_run_at: iso(now - HOUR), paused: true },
			{ ...BASE, id: 'off', title: 'Off', next_run_at: iso(now - HOUR), enabled: 0 },
			// Its run waits for an answer to an open question; the worker does not start it.
			{ ...BASE, id: 'parked', title: 'Parked', next_run_at: iso(now - HOUR), status: 'waiting' },
			// Completing a trigger leaves its next_run_at; the worker starts neither of these.
			{ ...BASE, id: 'done', title: 'Done', next_run_at: iso(now - HOUR), status: 'completed' },
			{ ...BASE, id: 'stopped', title: 'Stopped', next_run_at: iso(now - HOUR), status: 'stopped' },
			{ ...BASE, id: 'live', title: 'Live', next_run_at: iso(now - HOUR) },
		];
		await render('de');
		expect([...target.querySelectorAll<HTMLElement>('[data-next-run]')].map((e) => e.dataset['nextRun'])).toEqual(['due']);
		expect(target.textContent ?? '').toContain('Live');
		expect(target.textContent ?? '').toContain('Paused');
		expect(target.textContent ?? '').toContain('Parked');
		expect(target.textContent ?? '').toContain('Done');
		expect(target.textContent ?? '').toContain('Stopped');
	});

	it('takes a time that cannot be read as not due', async () => {
		rows = [{ ...BASE, id: 'bad', title: 'Bad', next_run_at: 'not a date' }];
		await render();
		expect(target.querySelector<HTMLElement>('[data-next-run]')?.dataset['nextRun']).toBe('next');
	});
});
