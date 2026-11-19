import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readable } from 'svelte/store';
import { setLocale, getLocale } from '../i18n.svelte.js';
import type { BulkRun } from './bulk-runs.js';

// The runs list names a run's cost as the run's own page does: the amount, then „USD“ (U-339). A run
// that spent nothing, or an older engine that sends no cost, reads „–“.

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
		id: 'r1', createdAt: '2026-11-18T00:00:00Z', targetSystem: 'http:demo.myshopify.com', phase: 'done', total: 2,
		changes: { update: 0, create: 0, delete: 0, unchanged: 0, invalid: 0 }, applied: 2, failed: 0, conflicts: 0, sentUnknown: 0, undone: 0,
		kind: 'apply', atomic: false, sourceRunId: null, writeMethod: null, probeConfirmed: false, writeForm: 'measured', haltReason: null, haltKey: null,
		costUsd: 0, costCapUsd: null, judge: null, maxTargets: null, failedOnce: null, failureLimit: 0, resumeOpen: 0, resumeTries: 0, resumeSends: 0, deselected: 0,
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

async function costs(): Promise<string[]> {
	const { default: BulkRunsView } = await import('./BulkRunsView.svelte');
	component = mount(BulkRunsView, { target });
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
	return [...target.querySelectorAll('[data-testid="bulk-run-cost"]')].map((td) => td.textContent ?? '');
}

describe('the cost column of the runs list', () => {
	it('names the amount in USD as the run page does, and „–“ for a run that spent nothing or sent no cost', async () => {
		runs = [
			makeRun({ id: 'spent', costUsd: 0.25 }),
			makeRun({ id: 'small', costUsd: 0.004 }),
			makeRun({ id: 'none', costUsd: 0 }),
			// An older engine may send no cost at all.
			makeRun({ id: 'unknown', costUsd: null as unknown as number }),
		];
		expect(await costs()).toEqual(['0.25 USD', '0.0040 USD', '–', '–']);
	});
});
