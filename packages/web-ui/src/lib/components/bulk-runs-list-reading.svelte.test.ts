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
			// Halted while reading, after it found targets: the engine is not reading now, and the list counts what it found.
			makeRun({ id: 'halted', list: { state: 'pending' }, total: 40, haltKey: 'unavailable', haltReason: 'engine English' }),
			// An older engine sends no list at all.
			makeRun({ id: 'old', total: 1, list: undefined }),
		];
		expect(await rows()).toEqual([
			{ title: '– Ziele · demo.myshopify.com', count: '–' },
			{ title: '12 Ziele · demo.myshopify.com', count: '0/12' },
			{ title: '3 Ziele · demo.myshopify.com', count: '0/3' },
			{ title: '40 Ziele · demo.myshopify.com', count: '0/40' },
			{ title: '1 Ziel · demo.myshopify.com', count: '0/1' },
		]);
	});
});

describe('the runs list for a run whose list is not read yet', () => {
	it('names the list not read yet, with no count, while it waits for its start and when the read halted before a target', async () => {
		runs = [
			makeRun({ id: 'waits', list: { state: 'pending' }, haltKey: 'awaitingStart', haltReason: 'awaitingStart' }),
			makeRun({ id: 'halted', list: { state: 'pending' }, haltKey: 'unavailable', haltReason: 'engine English' }),
			// Ended before its list was read: it never reads it, so it only counts.
			makeRun({ id: 'ended', phase: 'aborted', list: { state: 'pending' }, haltKey: 'mandateEnded', haltReason: 'mandateEnded' }),
		];
		expect(await rows()).toEqual([
			{ title: 'Liste noch nicht gelesen · demo.myshopify.com', count: '' },
			{ title: 'Liste noch nicht gelesen · demo.myshopify.com', count: '' },
			{ title: '0 Ziele · demo.myshopify.com', count: '0/0' },
		]);
	});

	it('says it in English too', async () => {
		setLocale('en');
		runs = [makeRun({ id: 'waits', list: { state: 'pending' }, haltKey: 'awaitingStart', haltReason: 'awaitingStart' })];
		expect(await rows()).toEqual([{ title: 'List not read yet · demo.myshopify.com', count: '' }]);
	});
});
