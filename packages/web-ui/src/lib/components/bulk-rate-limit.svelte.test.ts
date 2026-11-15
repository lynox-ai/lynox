import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readable } from 'svelte/store';
import { t } from '../i18n.svelte.js';
import { resetSettingsViewer } from '../stores/settings-viewer.svelte.js';
import type { BulkRunDetailData, BulkTarget } from './bulk-runs.js';

// The engine answers a burst of requests with 429. The bulk pages then say that, not "Is the
// engine reachable?", and the list does not add "no runs yet" under a failed load.

vi.mock('$app/stores', () => ({ page: readable({ url: new URL('http://localhost/app/activity?tab=bulk') }) }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element; props?: Record<string, unknown> }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

const PREVIEWED: BulkRunDetailData = {
	id: 'r1', createdAt: '2026-10-28T00:00:00Z', targetSystem: 'http:demo.myshopify.com', phase: 'previewed', total: 1,
	changes: { update: 1, create: 0, delete: 0, unchanged: 0, invalid: 0 }, applied: 0, failed: 0, conflicts: 0, sentUnknown: 0, undone: 0,
	kind: 'apply', atomic: false, sourceRunId: null, writeMethod: null, probeConfirmed: true, writeForm: 'measured', haltReason: null, haltKey: null,
	costUsd: 0, costCapUsd: null, judge: null, maxTargets: null, failedOnce: null, failureLimit: 0, resumeOpen: 0, resumeTries: 0, resumeSends: 0, deselected: 0,
	checksum: 'c1', writeFormNote: null, writeFormConfirmation: null, judgeModel: null, resumesAt: null, probe: null, undoable: 0,
	listFirstPage: null, listStartChecksum: null, listNote: null, listFilters: null, judgeRule: null, judgeRuleHash: null, judgeServedBy: null, judgeOwnKey: false,
};
const TARGET: BulkTarget = { seq: 1, key: 'gid://shopify/Product/1', change: 'update', diff: { kind: 'fields', fields: [{ field: 'title', before: 'Alt', after: 'Neu' }] } as BulkTarget['diff'], error: null, deselected: false };

type Answer = 'ok-empty' | 'rate-limited' | 'network' | 'act-rate-limited';
let answer: Answer;
let target: HTMLElement;
let component: Record<string, unknown> | undefined;

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	resetSettingsViewer();
	vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
		const u = String(url);
		const reply = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
		if (u.endsWith('/config')) return reply({ managed: true, viewer: 'owner' });
		if (answer === 'act-rate-limited') {
			if (init?.method === 'POST') return new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '4' } });
			const page = /\/targets\?offset=(\d+)&limit=(\d+)$/.exec(u);
			if (page) return reply({ targets: [TARGET] });
			if (u.endsWith('/bulk/runs/r1')) return reply(PREVIEWED);
			return reply({}, 404);
		}
		if (answer === 'network') throw new TypeError('Failed to fetch');
		if (answer === 'rate-limited') return new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '4' } });
		if (u.endsWith('/bulk/runs')) return reply({ runs: [] });
		if (u.endsWith('/merges')) return reply({ merges: [] });
		return reply({}, 404);
	}));
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	resetSettingsViewer();
	vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) { await new Promise((r) => setTimeout(r, 0)); await tick(); flushSync(); }
}

async function renderList(): Promise<void> {
	const { default: BulkRunsView } = await import('./BulkRunsView.svelte');
	component = mount(BulkRunsView, { target });
	await settle();
}

describe('the list of bulk runs', () => {
	it('says a 429 is too many requests, and not that there are no runs', async () => {
		answer = 'rate-limited';
		await renderList();
		expect(target.textContent).toContain(t('common.rate_limited'));
		expect(target.textContent).not.toContain(t('common.load_failed'));
		expect(target.textContent).not.toContain(t('bulk.empty'));
	});

	it('says a network error is a failed load, and not that there are no runs', async () => {
		answer = 'network';
		await renderList();
		expect(target.textContent).toContain(t('common.load_failed'));
		expect(target.textContent).not.toContain(t('common.rate_limited'));
		expect(target.textContent).not.toContain(t('bulk.empty'));
	});

	it('says there are no runs after a load that found none', async () => {
		answer = 'ok-empty';
		await renderList();
		expect(target.textContent).toContain(t('bulk.empty'));
		expect(target.textContent).not.toContain(t('common.load_failed'));
		expect(target.textContent).not.toContain(t('common.rate_limited'));
	});
});

describe('a run\'s page', () => {
	for (const [what, said, notSaid] of [
		['rate-limited', 'common.rate_limited', 'common.load_failed'],
		['network', 'common.load_failed', 'common.rate_limited'],
	] as const) {
		it(`says ${said} when the run's load is ${what}`, async () => {
			answer = what;
			const { default: BulkRunDetail } = await import('./BulkRunDetail.svelte');
			component = mount(BulkRunDetail, { target, props: { runId: 'r1', onBack: () => {}, onOpen: () => {} } });
			await settle();
			expect(target.textContent).toContain(t(said));
			expect(target.textContent).not.toContain(t(notSaid));
		});
	}
});

describe('an act on a run\'s page', () => {
	it('says a 429 is too many requests, not the engine\'s English', async () => {
		answer = 'act-rate-limited';
		const { default: BulkRunDetail } = await import('./BulkRunDetail.svelte');
		component = mount(BulkRunDetail, { target, props: { runId: 'r1', onBack: () => {}, onOpen: () => {} } });
		await settle();
		const off = [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === t('bulk.deselect.off'));
		expect(off).toBeDefined();
		off!.click();
		await settle();
		expect(target.textContent).toContain(t('common.rate_limited'));
		expect(target.textContent).not.toContain('Too many requests');
	});
});
