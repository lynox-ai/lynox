import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readable } from 'svelte/store';
import { setLocale, getLocale } from '../i18n.svelte.js';
import type { BulkRun } from './bulk-runs.js';

// While a run reads its list nothing is counted yet: the runs list names its size „–“, as the
// run's own page does, and not „0 Ziele“, which reads as a run that is done with nothing.

vi.mock('$app/stores', () => ({ page: readable({ url: new URL('http://localhost/app/activity?tab=bulk') }) }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

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

function makeRun(o: Partial<BulkRun>): BulkRun {
	return {
		id: 'r1', createdAt: '2026-11-18T00:00:00Z', targetSystem: 'http:demo.myshopify.com', phase: 'planned', total: 0,
		changes: { update: 0, create: 0, delete: 0, unchanged: 0, invalid: 0 }, applied: 0, failed: 0, conflicts: 0, sentUnknown: 0, undone: 0,
		kind: 'apply', atomic: false, sourceRunId: null, writeMethod: null, probeConfirmed: false, writeForm: 'measured', haltReason: null, haltKey: null,
		costUsd: 0, costCapUsd: null, judge: null, maxTargets: null, failedOnce: null, failureLimit: 0, resumeOpen: 0, resumeTries: 0, resumeSends: 0, deselected: 0,
		list: null,
		...o,
	} as BulkRun;
}

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let runs: BulkRun[];
let locale: ReturnType<typeof getLocale>;

beforeEach(() => {
	locale = getLocale();
	setLocale('de');
	target = document.createElement('div');
	document.body.appendChild(target);
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const u = String(url);
		const reply = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
		if (u.endsWith('/config')) return reply({ managed: true, viewer: 'owner' });
		if (u.endsWith('/bulk/runs')) return reply({ runs });
		if (u.endsWith('/merges')) return reply({ merges: [] });
		return reply({});
	}));
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	setLocale(locale);
	vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

/** Each run's title and count in the list, in order. */
async function rows(): Promise<{ title: string; count: string }[]> {
	const { default: BulkRunsView } = await import('./BulkRunsView.svelte');
	component = mount(BulkRunsView, { target });
	await settle();
	return [...target.querySelectorAll('tbody tr')].filter((tr) => tr.querySelector('[data-testid="bulk-run-count"]')).map((tr) => ({
		title: tr.querySelector('td button')!.textContent!.trim(),
		count: tr.querySelector('[data-testid="bulk-run-count"]')!.textContent!.trim(),
	}));
}

describe('the runs list while a run reads its list', () => {
	it('names „–“ for the run that reads its list and the numbers for every other', async () => {
		runs = [
			makeRun({ id: 'reading', list: { state: 'pending' } }),
			makeRun({ id: 'read', list: { state: 'done' }, total: 12 }),
			makeRun({ id: 'plain', total: 3, phase: 'previewed' }),
			// Halted while reading: the engine is not reading now, and the list shows what stands.
			makeRun({ id: 'halted', list: { state: 'pending' }, haltKey: 'unavailable', haltReason: 'engine English' }),
			// An older engine sends no list at all.
			makeRun({ id: 'old', total: 1, list: undefined }),
		];
		expect(await rows()).toEqual([
			{ title: '– Ziele', count: '–' },
			{ title: '12 Ziele', count: '0/12' },
			{ title: '3 Ziele', count: '0/3' },
			{ title: '0 Ziele', count: '0/0' },
			{ title: '1 Ziel', count: '0/1' },
		]);
	});
});

// The row names its host once (U-338): below sm under the date line, from sm in the target column. The
// title is the size alone, an undo says so in front, and a run that spent nothing shows „–“.
describe('the runs list names a run\'s host once', () => {
	async function mountList(): Promise<HTMLTableRowElement[]> {
		const { default: BulkRunsView } = await import('./BulkRunsView.svelte');
		component = mount(BulkRunsView, { target });
		await settle();
		return [...target.querySelectorAll<HTMLTableRowElement>('tbody tr')].filter((tr) => tr.querySelector('[data-testid="bulk-run-count"]'));
	}

	it('keeps the host out of the title and puts it once in each width\'s place, in DE and EN', async () => {
		runs = [
			makeRun({ id: 'two', total: 2 }),
			makeRun({ id: 'one', total: 1 }),
			makeRun({ id: 'undo2', total: 2, kind: 'undo', sourceRunId: 'two' }),
			makeRun({ id: 'undo1', total: 1, kind: 'undo', sourceRunId: 'one' }),
		];
		const titleOf = (tr: HTMLTableRowElement): string => tr.querySelector('td button')!.textContent!.trim();
		const placesOnce = (list: HTMLTableRowElement[]): void => { for (const tr of list) {
			// Each place carries the host once, and the two places never show at the same width.
			expect(tr.textContent!.split('demo.myshopify.com').length - 1).toBe(2);
			const narrow = tr.querySelector('[data-testid="bulk-run-host-narrow"]')!;
			const wide = tr.querySelector('[data-testid="bulk-run-host"]')!;
			expect(narrow.textContent).toBe('demo.myshopify.com');
			expect(narrow.classList.contains('sm:hidden')).toBe(true);
			expect(wide.textContent).toBe('demo.myshopify.com');
			expect(wide.classList.contains('hidden') && wide.classList.contains('sm:table-cell')).toBe(true);
		} };
		const de = await mountList();
		expect(de.map(titleOf)).toEqual(['2 Ziele', '1 Ziel', 'Rücknahme · 2 Ziele', 'Rücknahme · 1 Ziel']);
		placesOnce(de);
		unmount(component!);
		component = undefined;
		setLocale('en');
		const en = await mountList();
		expect(en.map(titleOf)).toEqual(['2 targets', '1 target', 'Undo · 2 targets', 'Undo · 1 target']);
		placesOnce(en);
	});

	it('shows „–“ in the cost column for a run that spent nothing or sent no cost, and the amount for one that did', async () => {
		// An older engine may send no cost at all.
		runs = [makeRun({ id: 'none', costUsd: 0 }), makeRun({ id: 'unknown', costUsd: null as unknown as number }), makeRun({ id: 'spent', costUsd: 0.25 })];
		const costs = (await mountList()).map((tr) => tr.querySelector('[data-testid="bulk-run-cost"]')!.textContent);
		expect(costs).toEqual(['–', '–', '$0.25']);
	});
});

// Below sm the count and target columns are hidden (U-352). The date line then leads with the count, as
// the column reads it, and the host stands on a line of its own that breaks only where it is wider than
// the line alone, not after the date mid-value. From sm the line is the date alone, as before.
describe('the runs list at phone width', () => {
	async function dateLines(): Promise<{ line: HTMLElement; tr: HTMLTableRowElement }[]> {
		const { default: BulkRunsView } = await import('./BulkRunsView.svelte');
		component = mount(BulkRunsView, { target });
		await settle();
		return [...target.querySelectorAll<HTMLTableRowElement>('tbody tr')]
			.filter((tr) => tr.querySelector('[data-testid="bulk-run-count"]'))
			.map((tr) => ({ tr, line: tr.querySelector<HTMLElement>('[data-testid="bulk-run-host-narrow"]')!.parentElement! }));
	}
	/** The text a width shows on screen: below sm everything but what is only for screen readers, a block on its own
	 *  line; from sm without what is sm:hidden. */
	const shown = (el: HTMLElement, wide: boolean): string => [...el.childNodes].map((n) => {
		if (!(n instanceof HTMLElement)) return n.textContent ?? '';
		if (n.classList.contains('sr-only') || (wide && n.classList.contains('sm:hidden'))) return '';
		return (n.classList.contains('block') ? '\n' : '') + (n.textContent ?? '');
	}).join('');

	it('leads the date line with the count and puts the host on its own line, and from sm shows the date alone', async () => {
		runs = [
			makeRun({ id: 'part', total: 3, applied: 1, phase: 'writing', haltReason: 'stopped', haltKey: 'stoppedByOwner', targetSystem: 'http:lynox-demo-shop.myshopify.com' }),
			makeRun({ id: 'reading', list: { state: 'pending' } }),
		];
		const lines = await dateLines();
		const date = /\d{2}[./]\d{2}[./]\d{4}, \d{2}:\d{2}/.exec(lines[0]!.line.textContent!)![0];
		// While the run reads its list the title already says „– Ziele“: no count, no stray separator, nothing for a screen reader.
		expect(lines.map(({ line }) => shown(line, false))).toEqual([
			`1/3 · ${date}\nlynox-demo-shop.myshopify.com`,
			`${date}\ndemo.myshopify.com`,
		]);
		expect(lines.map(({ line }) => shown(line, true))).toEqual([date, date]);
		const reading = lines[1]!.line;
		expect(reading.querySelector('[data-testid="bulk-run-count-narrow"]')).toBeNull();
		expect(reading.querySelector('[data-testid="bulk-run-count-narrow-label"]')).toBeNull();
		expect(reading.textContent).toBe(`${date}demo.myshopify.com`);
		for (const { line, tr } of lines) {
			// The column still shows from sm only, „–“ while the list is read.
			const column = tr.querySelector<HTMLElement>('[data-testid="bulk-run-count"]')!;
			expect(column.classList.contains('hidden') && column.classList.contains('sm:table-cell')).toBe(true);
			const host = line.querySelector<HTMLElement>('[data-testid="bulk-run-host-narrow"]')!;
			// Its own line, so it starts at the line's edge. overflow-wrap:anywhere lets a host wider than the line
			// break, and lets the table shrink the column to the phone's width instead of pushing the status out.
			expect([...host.classList]).toEqual(expect.arrayContaining(['block', 'sm:hidden', '[overflow-wrap:anywhere]']));
			expect(line.lastElementChild).toBe(host);
		}
		expect(lines.map(({ tr }) => tr.querySelector('[data-testid="bulk-run-count"]')!.textContent)).toEqual(['1/3', '–']);
		const { line, tr } = lines[0]!;
		const count = line.querySelector<HTMLElement>('[data-testid="bulk-run-count-narrow"]')!;
		// The narrow count reads as the column does.
		expect(count.textContent).toBe(tr.querySelector('[data-testid="bulk-run-count"]')!.textContent);
		expect(count.classList.contains('sm:hidden')).toBe(true);
		// The column's header is hidden below sm: a screen reader hears the count after its name.
		const label = line.querySelector<HTMLElement>('[data-testid="bulk-run-count-narrow-label"]')!;
		expect(label.textContent).toBe('Ziele: ');
		expect(label.classList.contains('sr-only') && label.classList.contains('sm:hidden')).toBe(true);
		expect(line.firstElementChild).toBe(label);
		expect(label.nextElementSibling).toBe(count);
	});

	// Below sm the status chip may break after its „·“ and nowhere else (U-352): each part keeps its words
	// together, and from sm the chip stays on one line. A chip without a suffix is one unbreakable part.
	// jsdom does no layout, so this checks the classes and text that give that result, not the result.
	it('marks the status chip\'s parts nowrap and the chip itself only from sm, with a plain space after its „·“ between the parts, in DE and EN', async () => {
		runs = [
			makeRun({ id: 'stopped', total: 3, applied: 1, phase: 'writing', haltReason: 'stopped', haltKey: 'stoppedByOwner' }),
			makeRun({ id: 'halted', total: 3, applied: 1, phase: 'aborted', atomic: true, haltReason: 'x', haltKey: 'atomicRolledBack' }),
			makeRun({ id: 'ready', total: 3, phase: 'previewed' }),
		];
		const chips = async (): Promise<{ text: string; parts: string[] }[]> => {
			const list = await dateLines();
			return list.map(({ tr }) => {
				const chip = tr.querySelector<HTMLElement>('[data-testid="bulk-run-phase"]')!;
				expect(chip.classList.contains('sm:whitespace-nowrap')).toBe(true);
				expect(chip.classList.contains('whitespace-nowrap')).toBe(false);
				const parts = [...chip.children] as HTMLElement[];
				for (const p of parts) expect(p.classList.contains('whitespace-nowrap')).toBe(true);
				// Nothing around the chip takes that one break away again.
				for (let el = chip.parentElement; el !== null && el !== target; el = el.parentElement) expect(el.classList.contains('whitespace-nowrap')).toBe(false);
				return { text: chip.textContent!, parts: parts.map((p) => p.textContent!) };
			});
		};
		// The status column is as narrow as its longest part below sm, its natural width from sm.
		const head = (): HTMLElement => target.querySelector<HTMLElement>('[data-testid="bulk-col-status"]')!;
		expect(await chips()).toEqual([
			{ text: 'schreibt · gestoppt', parts: ['schreibt ·', 'gestoppt'] },
			{ text: 'abgebrochen · angehalten', parts: ['abgebrochen ·', 'angehalten'] },
			{ text: 'Vorschau bereit', parts: ['Vorschau bereit'] },
		]);
		expect(head().classList.contains('w-px') && head().classList.contains('sm:w-auto')).toBe(true);
		unmount(component!);
		component = undefined;
		setLocale('en');
		expect(await chips()).toEqual([
			{ text: 'writing · stopped', parts: ['writing ·', 'stopped'] },
			{ text: 'aborted · halted', parts: ['aborted ·', 'halted'] },
			{ text: 'preview ready', parts: ['preview ready'] },
		]);
	});
});
