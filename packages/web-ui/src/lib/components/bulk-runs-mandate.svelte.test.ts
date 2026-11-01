import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readable } from 'svelte/store';
import { t } from '../i18n.svelte.js';
import { resetSettingsViewer } from '../stores/settings-viewer.svelte.js';
import type { BulkMerge, BulkRunDetailData, BulkTarget } from './bulk-runs.js';

// Every act on a bulk run, and taking a merge back, is the owner's: the routes refuse a mandate.
// A mandate's session reads the runs and the merges without those buttons, and the run's page
// says once who can act. The owner's session keeps every button.

vi.mock('$app/stores', () => ({ page: readable({ url: new URL('http://localhost/app/activity?tab=bulk') }) }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

// `svelte` resolves to its server entry under node, where `mount` throws. The component is compiled
// for the client, so it is mounted with the client entry, loaded by path.
const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element; props?: Record<string, unknown> }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

function makeRun(o: Partial<BulkRunDetailData> = {}): BulkRunDetailData {
	return {
		id: 'r1', createdAt: '2026-10-28T00:00:00Z', targetSystem: 'http:demo.myshopify.com', phase: 'previewed', total: 1,
		changes: { update: 1, create: 0, delete: 0, unchanged: 0, invalid: 0 }, applied: 0, failed: 0, conflicts: 0, sentUnknown: 0, undone: 0,
		kind: 'apply', atomic: false, sourceRunId: null, writeMethod: null, probeConfirmed: true, writeForm: 'measured', haltReason: null, haltKey: null,
		costUsd: 0, costCapUsd: null, judge: null, maxTargets: null, failedOnce: null, failureLimit: 0, resumeOpen: 0, resumeTries: 0, deselected: 0,
		checksum: 'c1', writeFormNote: null, writeFormConfirmation: null, judgeModel: null, resumesAt: null, probe: null, undoable: 0,
		listFirstPage: null, listStartChecksum: null, listNote: null, judgeRule: null, judgeRuleHash: null, judgeServedBy: null, judgeOwnKey: false,
		...o,
	};
}
const TARGETS: BulkTarget[] = [
	{ seq: 1, key: 'gid://shopify/Product/1', change: 'update', diff: { kind: 'fields', fields: [{ field: 'title', before: 'Alt', after: 'Neu' }] } as BulkTarget['diff'], error: null, deselected: false },
];
const MERGE: BulkMerge = {
	id: 'm1', createdAt: '2026-10-28T00:00:00Z', dupName: 'Anna M.', canonicalName: 'Anna Muster',
	applied: true, inEffect: true, superseded: false, dataStoreRows: 1, threadRows: 0,
};

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let run: BulkRunDetailData;
let viewer: 'owner' | 'mandate';

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	resetSettingsViewer();
	run = makeRun();
	viewer = 'mandate';
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const u = String(url);
		const reply = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
		if (u.endsWith('/config')) return reply({ managed: true, viewer });
		if (u.endsWith('/bulk/runs')) return reply({ runs: [run] });
		if (u.endsWith('/merges')) return reply({ merges: [MERGE] });
		const page = /\/targets\?offset=(\d+)&limit=(\d+)$/.exec(u);
		if (page) return reply({ targets: TARGETS.slice(Number(page[1]), Number(page[1]) + Number(page[2])) });
		return reply(run);
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
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

async function renderDetail(): Promise<void> {
	const { default: BulkRunDetail } = await import('./BulkRunDetail.svelte');
	component = mount(BulkRunDetail, { target, props: { runId: 'r1', onBack: () => {}, onOpen: () => {} } });
	await settle();
}

async function renderList(): Promise<void> {
	const { default: BulkRunsView } = await import('./BulkRunsView.svelte');
	component = mount(BulkRunsView, { target });
	await settle();
}

const buttonByText = (text: string): HTMLButtonElement | undefined =>
	[...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);

describe('a run\'s page as a mandate sees it', () => {
	it('shows a preview without approving or taking a target out, and says who can act', async () => {
		await renderDetail();
		expect(target.textContent).toContain('Product/1');
		expect(buttonByText(t('bulk.approve.approve'))).toBeUndefined();
		expect(buttonByText(t('bulk.deselect.off'))).toBeUndefined();
		expect(target.textContent).toContain(t('bulk.owner_only'));
	});

	it('keeps approving and taking a target out for the owner, without the sentence', async () => {
		viewer = 'owner';
		await renderDetail();
		expect(buttonByText(t('bulk.approve.approve'))).toBeDefined();
		expect(buttonByText(t('bulk.deselect.off'))).toBeDefined();
		expect(target.textContent).not.toContain(t('bulk.owner_only'));
	});

	it('says who starts a run that waits for its start, not which button to press', async () => {
		run = makeRun({ phase: 'planned', haltKey: 'awaitingStart', haltReason: 'engine English', total: 1, changes: { update: 0, create: 0, delete: 0, unchanged: 0, invalid: 0 } });
		await renderDetail();
		expect(buttonByText(t('bulk.start.read'))).toBeUndefined();
		expect(target.textContent).toContain(t('bulk.halt.wait_owner_only'));
		expect(target.textContent).not.toContain(t('bulk.halt.awaitingStart_start').replace('{button}', t('bulk.start.read')));
		expect(target.textContent).not.toContain('engine English');
	});

	it('names the start button to the owner of the same waiting run', async () => {
		viewer = 'owner';
		run = makeRun({ phase: 'planned', haltKey: 'awaitingStart', haltReason: 'engine English', total: 1, changes: { update: 0, create: 0, delete: 0, unchanged: 0, invalid: 0 } });
		await renderDetail();
		expect(buttonByText(t('bulk.start.read'))).toBeDefined();
		expect(target.textContent).toContain(t('bulk.halt.awaitingStart_start').replace('{button}', t('bulk.start.read')));
	});

	it('at a probe, names no step to a mandate, and offers neither confirming nor taking it back', async () => {
		run = makeRun({ phase: 'writing', haltKey: 'probeRequired', haltReason: 'engine English', applied: 1, probeConfirmed: false, probe: { key: 'gid://shopify/Product/1', fields: ['title'] } });
		await renderDetail();
		expect(buttonByText(t('bulk.probe.continue'))).toBeUndefined();
		expect(buttonByText(t('bulk.probe.undo_one'))).toBeUndefined();
		expect(target.textContent).toContain(t('bulk.halt.probeRequired'));
		expect(target.textContent).not.toContain(t('bulk.halt.probeRequired_confirm'));
	});

	it('does not tell a mandate to check a read list and start it', async () => {
		run = makeRun({ phase: 'planned', haltKey: 'listed', haltReason: 'engine English', total: 1, listFirstPage: 'https://demo.myshopify.com/products.json', listStartChecksum: 'l1', changes: { update: 0, create: 0, delete: 0, unchanged: 0, invalid: 0 } });
		await renderDetail();
		expect(target.textContent).not.toContain(t('bulk.start.listed').replace('{n}', '1'));
		expect(target.textContent).toContain(t('bulk.start.list_note'));
	});
});

describe('the run list as a mandate sees it', () => {
	it('lists a merge without taking it back, and adds no sentence', async () => {
		await renderList();
		expect(target.textContent).toContain('Anna Muster');
		expect(buttonByText(t('bulk.merges.take_back'))).toBeUndefined();
		expect(target.textContent).not.toContain(t('bulk.owner_only'));
	});

	it('offers the owner to take the merge back', async () => {
		viewer = 'owner';
		await renderList();
		expect(buttonByText(t('bulk.merges.take_back'))).toBeDefined();
	});
});
