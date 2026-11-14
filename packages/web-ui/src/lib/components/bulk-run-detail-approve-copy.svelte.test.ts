import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t, tf } from '../i18n.svelte.js';
import { resetSettingsViewer } from '../stores/settings-viewer.svelte.js';
import type { BulkRunDetailData, BulkTarget } from './bulk-runs.js';
import { readable } from 'svelte/store';

vi.mock('$app/stores', () => ({ page: readable({ url: new URL('http://localhost/app/activity?tab=bulk') }) }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

// Two lines of a run's page said something that did not hold. The approval of an image-alt run on
// a store said titles and SEO texts would be visible at once, though the run writes neither; the
// sentence now names no field. And while the engine read a run's list, the head said „0 Ziele“ and
// counted nothing written, which reads as a run with nothing to do; it now names the step.

const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element; props?: Record<string, unknown> }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

const HOST = 'demo.myshopify.com';

function makeRun(o: Partial<BulkRunDetailData> = {}): BulkRunDetailData {
	return {
		id: 'r1', createdAt: '2026-11-14T07:50:00Z', targetSystem: `http:${HOST}`, phase: 'previewed', total: 2,
		changes: { update: 2, create: 0, delete: 0, unchanged: 0, invalid: 0 }, applied: 0, failed: 0, conflicts: 0, sentUnknown: 0, undone: 0,
		kind: 'apply', atomic: false, sourceRunId: null, writeMethod: null, probeConfirmed: false, writeForm: 'unmeasured', haltReason: null, haltKey: null,
		costUsd: 0, costCapUsd: null, judge: null, maxTargets: 2, failedOnce: 0, failureLimit: 0, resumeOpen: 0, resumeTries: 0, resumeSends: 0, deselected: 0,
		checksum: 'c1', writeFormNote: null, writeFormConfirmation: null, judgeModel: null, resumesAt: null, probe: null, undoable: 0,
		listFirstPage: null, listStartChecksum: null, listNote: null, listFilters: null, judgeRule: null, judgeRuleHash: null, judgeServedBy: null, judgeOwnKey: false,
		undoneBy: null,
		...o,
	};
}
const alt = (seq: number): BulkTarget =>
	({ seq, key: `gid://shopify/MediaImage/${String(seq)}`, change: 'update', diff: { kind: 'fields', fields: [{ field: 'alt', before: null, after: `Bild ${String(seq)}` }] }, error: null, deselected: false }) as BulkTarget;

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let run: BulkRunDetailData;
let targets: BulkTarget[];

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	resetSettingsViewer();
	run = makeRun();
	targets = [alt(1), alt(2)];
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const u = String(url);
		const reply = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
		if (u.endsWith('/config')) return reply({ managed: true, viewer: 'owner' });
		if (u.endsWith('/bulk/runs')) return reply({ runs: [run] });
		if (u.endsWith('/merges')) return reply({ merges: [] });
		const page = /\/targets\?offset=(\d+)&limit=(\d+)$/.exec(u);
		if (page) return reply({ targets: targets.slice(Number(page[1]), Number(page[1]) + Number(page[2])) });
		return reply(run);
	}));
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
});

async function render(): Promise<void> {
	const { default: BulkRunDetail } = await import('./BulkRunDetail.svelte');
	component = mount(BulkRunDetail, { target, props: { runId: 'r1', onBack: () => {}, onOpen: () => {} } });
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

const head = (): string => target.querySelector('h1')?.textContent ?? '';

describe('the approval of an image-alt run on a store', () => {
	it('says the new values take effect at once, and names no title or SEO text', async () => {
		await render();
		const approval = [...target.querySelectorAll('h2')].find((h) => h.textContent === t('bulk.approve.title'))!.parentElement!.textContent ?? '';
		expect(approval).toContain('Bei veröffentlichten Produkten gelten die neuen Werte sofort in deinem Shop, sobald lynox sie schreibt.');
		expect(approval).not.toContain('Titel und SEO-Texte');
	});
});

describe('the head of a run', () => {
	it('names the list read while the engine reads it, and counts nothing yet', async () => {
		run = makeRun({ phase: 'planned', total: 0, changes: { update: 0, create: 0, delete: 0, unchanged: 0, invalid: 0 }, checksum: null, writeForm: null, listFirstPage: `https://${HOST}/admin/api/2026-10/graphql.json`, list: { state: 'pending' } });
		targets = [];
		await render();
		expect(head()).toBe(`Liste wird gelesen · ${HOST}`);
		expect(target.textContent).not.toContain(tf('bulk.head.counts', { n: '0', a: '0', c: '0', f: '0' }));
		expect([...target.querySelectorAll('dt')].map((d) => d.textContent)).not.toContain(t('bulk.head.targets'));
	});

	it('says the list is not read yet before the start, with the button to read it and no counts', async () => {
		run = makeRun({ phase: 'planned', total: 0, changes: { update: 0, create: 0, delete: 0, unchanged: 0, invalid: 0 }, haltKey: 'awaitingStart', haltReason: 'awaitingStart', checksum: null, writeForm: null, listFirstPage: `https://${HOST}/admin/api/2026-10/graphql.json`, list: { state: 'pending' } });
		targets = [];
		await render();
		expect(head()).toBe(`Liste noch nicht gelesen · ${HOST}`);
		expect([...target.querySelectorAll('dt')].map((d) => d.textContent)).not.toContain(t('bulk.head.targets'));
		expect([...target.querySelectorAll('button')].some((b) => b.textContent?.trim() === t('bulk.start.list'))).toBe(true);
	});

	it('counts the targets collected so far when the list read halted part-way', async () => {
		run = makeRun({ phase: 'planned', total: 600, changes: { update: 600, create: 0, delete: 0, unchanged: 0, invalid: 0 }, haltKey: 'listReadFailed', haltReason: 'listReadFailed', checksum: null, writeForm: null, listFirstPage: `https://${HOST}/admin/api/2026-10/graphql.json`, list: { state: 'pending' } });
		targets = [];
		await render();
		expect(head()).toBe(`600 Ziele · ${HOST}`);
		expect(target.textContent).toContain(tf('bulk.head.counts', { n: '600', a: '0', c: '0', f: '0' }));
	});

	it('counts the targets once the list is read', async () => {
		run = makeRun({ phase: 'planned', haltKey: 'listed', haltReason: 'listed', checksum: null, writeForm: null, list: { state: 'done' } });
		await render();
		expect(head()).toBe(`2 Ziele · ${HOST}`);
		expect(target.textContent).toContain(tf('bulk.head.counts', { n: '2', a: '0', c: '0', f: '0' }));
	});
});

describe('the list of runs', () => {
	async function renderList(): Promise<void> {
		const { default: BulkRunsView } = await import('./BulkRunsView.svelte');
		component = mount(BulkRunsView, { target });
		for (let i = 0; i < 10; i++) {
			await new Promise((r) => setTimeout(r, 0));
			await tick();
			flushSync();
		}
	}
	const rowName = (): string => target.querySelector('tbody tr td button')?.textContent ?? '';

	it('names the list read as the run page does, while the engine reads it', async () => {
		run = makeRun({ phase: 'planned', total: 0, changes: { update: 0, create: 0, delete: 0, unchanged: 0, invalid: 0 }, checksum: null, writeForm: null, list: { state: 'pending' } });
		await renderList();
		expect(rowName()).toBe(`Liste wird gelesen · ${HOST}`);
	});

	it('says the list is not read yet before the start', async () => {
		run = makeRun({ phase: 'planned', total: 0, changes: { update: 0, create: 0, delete: 0, unchanged: 0, invalid: 0 }, haltKey: 'awaitingStart', haltReason: 'awaitingStart', checksum: null, writeForm: null, list: { state: 'pending' } });
		await renderList();
		expect(rowName()).toBe(`Liste noch nicht gelesen · ${HOST}`);
	});

	it('counts the targets once the list is read', async () => {
		run = makeRun({ phase: 'planned', haltKey: 'listed', haltReason: 'listed', checksum: null, writeForm: null, list: { state: 'done' } });
		await renderList();
		expect(rowName()).toBe(`2 Ziele · ${HOST}`);
	});
});
