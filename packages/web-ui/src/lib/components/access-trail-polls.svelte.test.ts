import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t, tf, setLocale, getLocale } from '../i18n.svelte.js';

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

// Row 1034, ux U-047: the reads a helper's web UI makes by itself (marked `auto` by the engine)
// stand grouped in the owner's view, after the filters, so the helper's own steps stay findable.
// Nothing is dropped: a group opens to every read it stands for.

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let page: unknown[] = [];

const IDA = { email: 'ida@example.invalid', display: 'IDA', mandateId: 'M-1' };
const BEN = { email: 'ben@example.invalid', display: null, mandateId: 'M-2' };
/** Minutes ago, newest first in the fixtures as the engine sends them. */
const ago = (min: number): string => new Date(Date.now() - min * 60_000).toISOString();

let nextId = 0;
const poll = (min: number, person = IDA): unknown => ({ id: `p${String(nextId++)}`, kind: 'event', action: 'GET /api/runs/active', target: '/api/runs/active', phase: 'read', at: ago(min), person, auto: true });
const read = (min: number, person = IDA): unknown => ({ id: `r${String(nextId++)}`, kind: 'event', action: 'GET /api/threads/:id', target: '/api/threads/t-1', phase: 'read', at: ago(min), person });
const step = (min: number, person = IDA): unknown => ({ id: `s${String(nextId++)}`, kind: 'step', action: 'instance:remember#create', target: null, at: ago(min), person, status: 'done' });

beforeEach(() => {
	vi.stubGlobal('fetch', vi.fn(async () =>
		new Response(JSON.stringify({ entries: page, before: null }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

async function render(entries: unknown[]): Promise<void> {
	page = entries;
	const { default: AccessTrailView } = await import('./AccessTrailView.svelte');
	component = mount(AccessTrailView, { target });
	await settle();
}

/** The view's top-level rows, as kind and, for a group, its count of reads. */
const rows = (): string[] => [...target.querySelectorAll<HTMLElement>('ul > li[data-entry-kind]')].map((li) =>
	li.dataset['entryKind'] === 'polls' ? `polls:${String(li.querySelectorAll('details [data-entry-kind="event"]').length)}` : li.dataset['entryKind']!);
const summaries = (): string[] => [...target.querySelectorAll('[data-polls-summary]')].map((s) => s.textContent?.trim() ?? '');

describe('reads the interface made by itself', () => {
	it('groups consecutive marked reads of one person, and leaves steps and other reads single', async () => {
		await render([poll(1), poll(2), step(3), poll(4), read(5), poll(6), poll(7), poll(8)]);
		expect(rows()).toEqual(['polls:2', 'step', 'polls:1', 'event', 'polls:3']);
	});

	it('says how many and from when to when, in one form for one read', async () => {
		await render([poll(1), step(2), poll(3), poll(4)]);
		const [one, two] = summaries();
		expect(one).toMatch(new RegExp(`^${tf('access_trail.polls_one', { time: 'X' }).split('X')[0]!.replace(/[()]/g, '\\$&')}`));
		expect(two!.startsWith(tf('access_trail.polls_many', { n: '2', span: 'X' }).split('X')[0]!)).toBe(true);
		// t() falls back to the key, so the texts must be real translations.
		expect(t('access_trail.polls_many')).not.toBe('access_trail.polls_many');
		expect(t('access_trail.polls_one')).not.toBe('access_trail.polls_one');
	});

	it('shows the legend', async () => {
		await render([poll(1)]);
		expect(target.querySelector('[data-legend="interface-polls"]')?.textContent?.trim()).toBe(t('access_trail.polls_legend'));
	});

	it('opens a group to every read in it', async () => {
		await render([poll(1), poll(2), poll(3)]);
		const lines = [...target.querySelectorAll('li[data-entry-kind="polls"] details [data-entry-kind="event"]')];
		expect(lines).toHaveLength(3);
		for (const line of lines) expect(line.textContent).toContain('GET /api/runs/active');
	});

	it('another person\'s read ends a group', async () => {
		await render([poll(1), poll(2, BEN), poll(3)]);
		expect(rows()).toEqual(['polls:1', 'polls:1', 'polls:1']);
	});

	it('groups after the person filter, so one person\'s reads join across another\'s', async () => {
		await render([poll(1), poll(2, BEN), poll(3)]);
		const select = target.querySelector<HTMLSelectElement>('[data-filter="person"]')!;
		select.value = 'M-1';
		select.dispatchEvent(new Event('change'));
		await settle();
		expect(rows()).toEqual(['polls:2']);
	});

	it('an unmarked read is never grouped, even on a listed route', async () => {
		// The engine decides what is marked; the view groups nothing by its route.
		const unmarked = { ...(poll(1) as Record<string, unknown>), auto: undefined };
		await render([unmarked, poll(2)]);
		expect(rows()).toEqual(['event', 'polls:1']);
	});

	it('ten minutes of an open tab and one step: the step is in the first rows', async () => {
		// threads.svelte.ts reads every 4 s: 150 reads in ten minutes, a step in the middle of them.
		const entries = [
			...Array.from({ length: 75 }, (_, i) => poll(i * 4 / 60)),
			step(5.01),
			read(5.02),
			...Array.from({ length: 75 }, (_, i) => poll(5.03 + i * 4 / 60)),
		];
		await render(entries);
		expect(rows()).toEqual(['polls:75', 'step', 'event', 'polls:75']);
	});
});

describe('the texts, as ux wrote them (U-047)', () => {
	it('DE and EN', () => {
		const before = getLocale();
		try {
			setLocale('de');
			expect([t('access_trail.polls_legend'), t('access_trail.polls_many'), t('access_trail.polls_one')]).toEqual([
				'Statusabfragen (laufende Arbeit, Aufgaben, Kosten, Anbieter) stehen zusammengefasst. Die meisten macht die Oberfläche von selbst. Aufklappen zeigt jede einzeln.',
				'{n} Statusabfragen ({span})',
				'Eine Statusabfrage ({time})',
			]);
			setLocale('en');
			expect([t('access_trail.polls_legend'), t('access_trail.polls_many'), t('access_trail.polls_one')]).toEqual([
				'Status requests (running work, tasks, costs, providers) are grouped. The interface makes most of them by itself. Expand to see each one.',
				'{n} status requests ({span})',
				'One status request ({time})',
			]);
		} finally {
			setLocale(before);
		}
	});
});
