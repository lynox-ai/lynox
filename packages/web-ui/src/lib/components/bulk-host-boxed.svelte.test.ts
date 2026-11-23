import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readable } from 'svelte/store';
import { t, tf } from '../i18n.svelte.js';
import { resetSettingsViewer } from '../stores/settings-viewer.svelte.js';
import type { BulkMerge, BulkRunDetailData, BulkTarget } from './bulk-runs.js';

// The host an external run writes to is the planner's: it stands boxed as code wherever it meets
// the page's own words, in the list and on the run's page, and the words around it stay the page's.

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
		costUsd: 0, costCapUsd: null, judge: null, maxTargets: null, failedOnce: null, failureLimit: 0, resumeOpen: 0, resumeTries: 0, resumeSends: 0, deselected: 0,
		checksum: 'c1', writeFormNote: null, writeFormConfirmation: null, judgeModel: null, resumesAt: null, probe: null, undoable: 0,
		listFirstPage: null, listStartChecksum: null, listNote: null, listFilters: null, judgeRule: null, judgeRuleHash: null, judgeServedBy: null, judgeOwnKey: false,
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
let viewer: 'owner' | 'mandate' | 'none' | null;
let shownTargets: BulkTarget[];

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	resetSettingsViewer();
	run = makeRun();
	viewer = 'owner';
	shownTargets = TARGETS;
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const u = String(url);
		const reply = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
		if (u.endsWith('/config')) return viewer === null ? new Response('', { status: 502 }) : reply({ managed: true, viewer });
		if (u.endsWith('/bulk/runs')) return reply({ runs: [run] });
		if (u.endsWith('/merges')) return reply({ merges: [MERGE] });
		const page = /\/targets\?offset=(\d+)&limit=(\d+)$/.exec(u);
		if (page) return reply({ targets: shownTargets.slice(Number(page[1]), Number(page[1]) + Number(page[2])) });
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

const HOST = 'feed-partner.example.biz';
const hostBoxes = (within: Element | null): string[] => [...(within?.querySelectorAll('code[data-testid="bulk-host"]') ?? [])].map((e) => e.textContent ?? '');
// The element's own words, the boxed host left out.
const ownWords = (e: Element | null): string => [...(e?.childNodes ?? [])].filter((n) => !(n instanceof Element && n.matches('code[data-testid="bulk-host"]'))).map((n) => n.textContent ?? '').join('');

describe('the host of a bulk run, boxed where it meets the page\'s words', () => {
	it('boxes the host in a run\'s label in the list, beside its date and in its column, the label\'s words staying text', async () => {
		run = makeRun({ targetSystem: `http:${HOST}`, total: 3 });
		await renderList();
		const label = target.querySelector('tbody button');
		expect(label?.textContent).toBe(tf('bulk.label', { n: '3', target: HOST }));
		expect(hostBoxes(label)).toEqual([HOST]);
		expect(ownWords(label)).toBe(tf('bulk.label', { n: '3', target: '' }));
		expect(hostBoxes(target.querySelector('tbody'))).toEqual([HOST, HOST, HOST]);
	});

	it('names a system lynox names itself as text in the list, with no box', async () => {
		run = makeRun({ targetSystem: 'data_store', total: 1 });
		await renderList();
		expect(target.querySelector('tbody button')?.textContent).toBe(tf('bulk.label_one', { n: '1', target: t('bulk.system.data_store') }));
		expect(hostBoxes(target.querySelector('tbody'))).toEqual([]);
	});

	it('boxes the host in the heading and the target line of the run\'s page, the words around it staying text', async () => {
		run = makeRun({ targetSystem: `http:${HOST}`, kind: 'undo', total: 1, writeMethod: 'PUT' });
		await renderDetail();
		const heading = target.querySelector('h1');
		expect(heading?.textContent).toBe(tf('bulk.label_undo_one', { n: '1', target: HOST }));
		expect(hostBoxes(heading)).toEqual([HOST]);
		expect(ownWords(heading)).toBe(tf('bulk.label_undo_one', { n: '1', target: '' }));
		const line = [...target.querySelectorAll('dt')].find((d) => d.textContent === t('bulk.head.target'))?.nextElementSibling ?? null;
		expect(line?.textContent).toBe(`${HOST} · PUT`);
		expect(hostBoxes(line)).toEqual([HOST]);
		expect(ownWords(line)).toBe(' · PUT');
	});

	it('names a system lynox names itself as text on the run\'s page, with no box', async () => {
		run = makeRun({ targetSystem: 'workspace' });
		await renderDetail();
		expect(target.querySelector('h1')?.textContent).toBe(tf('bulk.label_one', { n: '1', target: t('bulk.system.workspace') }));
		expect(hostBoxes(target)).toEqual([]);
	});
});

// Every place the run's page names the host among its words: the host boxed there, and named
// nowhere on the page outside a box.
const unboxedText = (root: Element): string => {
	const copy = root.cloneNode(true) as Element;
	copy.querySelectorAll('code[data-testid="bulk-host"]').forEach((c) => c.remove());
	return copy.textContent ?? '';
};
const ext = (o: Partial<BulkRunDetailData>): BulkRunDetailData => makeRun({ targetSystem: `http:${HOST}`, ...o });

describe('the host in the sentences of a run\'s page', () => {
	it('boxes the host in the sentence before reading the targets, and names it nowhere else unboxed', async () => {
		run = ext({ phase: 'planned', haltKey: 'awaitingStart', haltReason: 'awaiting start' });
		await renderDetail();
		const line = target.querySelector('[data-testid="bulk-read-explain"]');
		expect(line?.textContent).toBe(tf('bulk.start.read_explain', { provider: HOST }));
		expect(hostBoxes(line)).toEqual([HOST]);
		expect(unboxedText(target)).not.toContain(HOST);
	});

	it('boxes the host and the list\'s address each in its own box in the sentence before reading a list', async () => {
		const address = `https://${HOST}/api/products?page=1`;
		run = ext({ phase: 'planned', haltKey: 'awaitingStart', haltReason: 'awaiting start', listFirstPage: address });
		await renderDetail();
		const line = target.querySelector('[data-testid="bulk-list-explain"]');
		expect(line?.textContent).toBe(tf('bulk.start.list_explain', { provider: HOST, address }));
		expect(hostBoxes(line)).toEqual([HOST]);
		expect([...(line?.querySelectorAll('code[data-testid="bulk-list-address"]') ?? [])].map((c) => c.textContent)).toEqual([address]);
		expect([...(line?.childNodes ?? [])].filter((n) => !(n instanceof Element)).map((n) => n.textContent).join('')).toBe(tf('bulk.start.list_explain', { provider: '', address: '' }));
	});

	it('boxes the host in what the probe says and in each sentence the owner confirms', async () => {
		run = ext({ phase: 'writing', haltKey: 'maxTargets', haltReason: 'probe', applied: 1, probeConfirmed: false, writeForm: 'measured', probe: { key: 'gid://shopify/Product/1', fields: ['title'] } });
		await renderDetail();
		expect(hostBoxes(target.querySelector('[data-testid="bulk-probe-explain"]'))).toEqual([HOST]);
		const confirm = target.querySelector('[data-testid="bulk-probe-confirm"]');
		expect(confirm?.textContent).toBe(`${tf('bulk.probe.confirm', { provider: HOST })} ${tf('bulk.probe.confirm_measured', { provider: HOST })}`);
		expect(hostBoxes(confirm)).toEqual([HOST, HOST]);
		expect(unboxedText(target)).not.toContain(HOST);
	});

	it('boxes the host in what the probe says when it checks the target whole', async () => {
		run = ext({ phase: 'writing', haltKey: 'maxTargets', haltReason: 'probe', applied: 1, probeConfirmed: false, writeForm: null, probe: { key: 'gid://shopify/Product/1', fields: [] } });
		await renderDetail();
		expect(hostBoxes(target.querySelector('[data-testid="bulk-probe-explain"]'))).toEqual([HOST]);
		expect(hostBoxes(target.querySelector('[data-testid="bulk-probe-confirm"]'))).toEqual([HOST]);
		expect(unboxedText(target)).not.toContain(HOST);
	});

	it('boxes the host in a halt\'s cause and in what starting again does', async () => {
		run = ext({ phase: 'planned', haltKey: 'unavailable', haltReason: 'host did not answer' });
		await renderDetail();
		const cause = target.querySelector('[data-testid="bulk-halt-cause"]');
		expect(cause?.textContent).toBe(tf('bulk.halt.unavailable', { provider: HOST }));
		expect(hostBoxes(cause)).toEqual([HOST]);
		expect(target.textContent).toContain(tf('bulk.halt.unavailable_before', { provider: HOST }));
		expect(unboxedText(target)).not.toContain(HOST);
	});

	it('boxes the host in a halted write\'s cause, and names it nowhere unboxed', async () => {
		run = ext({ phase: 'writing', haltKey: 'unrecorded', haltReason: 'not recorded', applied: 1, resumeOpen: 0, resumeTries: 0 });
		await renderDetail();
		const cause = target.querySelector('[data-testid="bulk-halt-cause"]');
		expect(cause?.textContent).toBe(tf('bulk.halt.unrecorded_write', { provider: HOST, host: HOST, max: '0' }));
		expect(hostBoxes(cause)).toEqual([HOST]);
		expect(unboxedText(target)).not.toContain(HOST);
	});

	it('boxes the host in what to do before writing on', async () => {
		run = ext({ phase: 'writing', haltKey: 'unavailable', haltReason: 'host did not answer', applied: 1, resumeOpen: 0, resumeTries: 0 });
		await renderDetail();
		const before = [...target.querySelectorAll('p')].find((p) => p.textContent === tf('bulk.halt.unavailable_before', { provider: HOST })) ?? null;
		expect(hostBoxes(before)).toEqual([HOST]);
		expect(unboxedText(target)).not.toContain(HOST);
	});

	it('boxes the host only where a text names it whole, never inside a longer name', async () => {
		const { bulkHostSplit } = await import('./bulk-runs.js');
		expect(bulkHostSplit('bei shop.ch, nicht api.shop.ch, shop.ch.other.example, myshop.ch oder shop.chx; an shop.ch. Ende', 'shop.ch')).toEqual([
			{ text: 'bei ' }, { slot: true }, { text: ', nicht api.shop.ch, shop.ch.other.example, myshop.ch oder shop.chx; an ' }, { slot: true }, { text: '. Ende' },
		]);
		expect(bulkHostSplit('https://api.shop.ch.evil.example/p/1', 'shop.ch')).toEqual([{ text: 'https://api.shop.ch.evil.example/p/1' }]);
		expect(bulkHostSplit('(shop.ch)', 'shop.ch')).toEqual([{ text: '(' }, { slot: true }, { text: ')' }]);
		for (const longer of ['https://shop.ch_x.evil.example/p', 'shop.ch.\u00fcmlaut.example', '\u00e4shop.ch', 'x_shop.ch', 'a\u0308shop.ch', 'shop.ch\u0301', 'x\u00adshop.ch', 'shop.ch\u200dx', 'shop.ch\uff0eevil.example', 'evil\u3002shop.ch', 'https://shop.ch@evil.example/p/1', 'support@shop.ch', 'https://shop.ch%2eevil.example/', 'https://evil%2Eshop.ch/', 'shop.ch:8443', 'shop.ch\u27e8U+200B\u27e9evil.example']) {
			expect(bulkHostSplit(longer, 'shop.ch')).toEqual([{ text: longer }]);
		}
		expect(bulkHostSplit('shop.ch', null)).toEqual([{ text: 'shop.ch' }]);
	});

	it('never searches a target\'s key for the host on the probe, boxing only the sentence\'s own place', async () => {
		const host = 'shop.example.com';
		const key = `https://${host}@evil.example/p/1`;
		run = makeRun({ targetSystem: `http:${host}`, phase: 'writing', haltKey: 'maxTargets', haltReason: 'probe', applied: 1, probeConfirmed: false, writeForm: null, probe: { key, fields: ['title'] } });
		await renderDetail();
		const explain = target.querySelector('[data-testid="bulk-probe-explain"]');
		expect(explain?.textContent).toContain(key);
		expect(hostBoxes(explain)).toEqual([host]);
	});

	it('shows the engine\'s own reason for a halt as text, never boxing a host in it', async () => {
		const reason = `request to https://${HOST}/x failed`;
		run = ext({ phase: 'writing', haltKey: null, haltReason: reason, applied: 1 });
		await renderDetail();
		const cause = target.querySelector('[data-testid="bulk-halt-cause"]');
		expect(cause?.textContent).toBe(reason);
		expect(hostBoxes(cause)).toEqual([]);
	});

	it('draws no empty box for a run whose host is empty', async () => {
		run = makeRun({ targetSystem: 'http:' });
		await renderDetail();
		expect(target.querySelectorAll('code[data-testid="bulk-host"]').length).toBe(0);
	});

	it('leaves the host inside a target\'s longer name unboxed on the probe', async () => {
		const host = 'shop.example.com';
		run = makeRun({ targetSystem: `http:${host}`, phase: 'writing', haltKey: 'maxTargets', haltReason: 'probe', applied: 1, probeConfirmed: false, writeForm: null, probe: { key: `https://api.${host}.other.example/p/1`, fields: [] } });
		await renderDetail();
		const explain = target.querySelector('[data-testid="bulk-probe-explain"]');
		expect(explain?.textContent).toContain(`api.${host}.other.example`);
		expect(hostBoxes(explain)).toEqual([host]);
	});
});

describe('where a boxed value may wrap', () => {
	it('cuts a value after a dot, a slash or a space, never at a hyphen, keeping every character', async () => {
		const { bulkBoxParts } = await import('./bulk-runs.js');
		expect(bulkBoxParts('summer-shoes-test.myshopify.com')).toEqual(['summer-shoes-test.', 'myshopify.', 'com']);
		expect(bulkBoxParts('https://shop-x.ch/admin/api/p.json?limit=250')).toEqual(['https://', 'shop-x.', 'ch/', 'admin/', 'api/', 'p.', 'json?limit=250']);
		expect(bulkBoxParts('a-b c-d')).toEqual(['a-b ', 'c-d']);
		for (const value of ['summer-shoes-test.myshopify.com', 'https://shop-x.ch/admin/api/p.json?limit=250', '..a--b//c. d']) {
			const parts = bulkBoxParts(value);
			expect(parts.join('')).toBe(value);
			for (const part of parts.slice(0, -1)) expect(part).toMatch(/[./\s]$/);
		}
	});

	it('boxes each piece whole with a break only between pieces, so a host with hyphens breaks only after a dot', async () => {
		const { default: BulkHost } = await import('./BulkHost.svelte');
		component = mount(BulkHost, { target, props: { value: 'summer-shoes-test.myshopify.com' } });
		flushSync();
		const box = target.querySelector('code[data-testid="bulk-host"]');
		expect(box?.textContent).toBe('summer-shoes-test.myshopify.com');
		expect([...(box?.querySelectorAll('span') ?? [])].map((s) => s.textContent)).toEqual(['summer-shoes-test.', 'myshopify.', 'com']);
		expect([...(box?.querySelectorAll('span') ?? [])].every((s) => s.classList.contains('inline-block') && s.classList.contains('break-all'))).toBe(true);
		expect([...(box?.childNodes ?? [])].filter((n) => n.nodeType !== Node.COMMENT_NODE && !(n.nodeType === Node.TEXT_NODE && n.textContent === '')).map((n) => n.nodeName)).toEqual(['SPAN', 'WBR', 'SPAN', 'WBR', 'SPAN']);
	});

	it('keeps a space in a boxed value as text between its pieces, where it shows and a line may end', async () => {
		const { default: BulkHost } = await import('./BulkHost.svelte');
		component = mount(BulkHost, { target, props: { value: 'a-b c-d' } });
		flushSync();
		const box = target.querySelector('code[data-testid="bulk-host"]');
		expect(box?.textContent).toBe('a-b c-d');
		expect([...(box?.querySelectorAll('span') ?? [])].map((s) => s.textContent)).toEqual(['a-b', 'c-d']);
		expect(box?.querySelectorAll('wbr').length).toBe(0);
	});

	it('leaves a run of spaces as text, with no empty piece', async () => {
		const { default: BulkHost } = await import('./BulkHost.svelte');
		component = mount(BulkHost, { target, props: { value: '  a.  b' } });
		flushSync();
		const box = target.querySelector('code[data-testid="bulk-host"]');
		expect(box?.textContent).toBe('  a.  b');
		expect([...(box?.querySelectorAll('span') ?? [])].map((s) => s.textContent)).toEqual(['a.', 'b']);
	});

	it('splits a sentence at each named placeholder and fills the others', async () => {
		const { bulkTemplateParts } = await import('./bulk-runs.js');
		expect(bulkTemplateParts('auf {list}, auf {store} und {n} mehr', ['store', 'list'], { n: '2' })).toEqual([
			{ text: 'auf ' }, { slot: 'list' }, { text: ', auf ' }, { slot: 'store' }, { text: ' und 2 mehr' },
		]);
	});
});
