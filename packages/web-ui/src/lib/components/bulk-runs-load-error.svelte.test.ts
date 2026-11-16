import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t, tf, setLocale, getLocale } from '../i18n.svelte.js';
import { resetSettingsViewer } from '../stores/settings-viewer.svelte.js';
import { bulkLoadErrorKey, type BulkRun, type BulkRunDetailData, type BulkTarget } from './bulk-runs.js';

// The engine answers 429 when one client asked too often within its window. The bulk pages said
// "Failed to load. Is the engine reachable?" then, and the run list said "No bulk runs yet." under
// it, though the engine ran and held runs. A 429 now has its own sentence, a failure without an
// answer keeps the old one, and the list says it is empty only after it read the list.

// A page store the tests can move: opening a run and coming back reloads the list in place.
const LIST_URL = 'http://localhost/app/activity?tab=bulk';
const pageStore = vi.hoisted(() => ({ store: null as null | { set: (v: { url: URL }) => void; subscribe: unknown } }));
vi.mock('$app/stores', async () => {
	const { writable: w } = await import('svelte/store');
	pageStore.store = w({ url: new URL('http://localhost/app/activity?tab=bulk') });
	return { page: pageStore.store };
});
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

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
		id: 'r1', createdAt: '2026-11-16T00:00:00Z', targetSystem: 'http:demo.myshopify.com', phase: 'done', total: 1,
		changes: { update: 1, create: 0, delete: 0, unchanged: 0, invalid: 0 }, applied: 1, failed: 0, conflicts: 0, sentUnknown: 0, undone: 0,
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

// How each route answers: a status (with a JSON body on 200), 'throw' for no answer at all, or
// 'bad' for a 200 whose body is not JSON.
type Answer = number | 'throw' | 'bad';
let answers: { run: Answer; targets: Answer; runs: Answer; merges: Answer };
let listed: BulkRun[];
// While set, each ask for the run list waits until the test answers it, in the order asked.
let holdRuns: boolean;
let heldRuns: ((a: Answer) => void)[];
// Answers for the next asks for targets, one each, before `answers.targets` applies again.
let targetQueue: Answer[];
let detailRun: BulkRunDetailData;
let served: BulkTarget[];
// The limit of each ask for targets, in order.
let targetLimits: number[];
let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let locale: ReturnType<typeof getLocale>;

beforeEach(() => {
	locale = getLocale();
	setLocale('de');
	target = document.createElement('div');
	document.body.appendChild(target);
	resetSettingsViewer();
	pageStore.store?.set({ url: new URL(LIST_URL) });
	answers = { run: 200, targets: 200, runs: 200, merges: 200 };
	listed = [];
	holdRuns = false;
	heldRuns = [];
	targetQueue = [];
	detailRun = makeRun();
	served = TARGETS;
	targetLimits = [];
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const u = String(url);
		const reply = (a: Answer, body: unknown): Response => {
			if (a === 'throw') throw new TypeError('Failed to fetch');
			if (a === 'bad') return new Response('not json', { status: 200 });
			return a === 200
				? new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
				: new Response(JSON.stringify({ error: 'Too many requests' }), { status: a, headers: { 'Content-Type': 'application/json', 'Retry-After': '4' } });
		};
		if (u.endsWith('/config')) return reply(200, { managed: true, viewer: 'owner' });
		if (u.endsWith('/bulk/runs')) {
			if (holdRuns) return new Promise<Response>((res, rej) => heldRuns.push((a) => { try { res(reply(a, { runs: listed })); } catch (e) { rej(e); } }));
			return reply(answers.runs, { runs: listed });
		}
		if (u.endsWith('/merges')) return reply(answers.merges, { merges: [] });
		const page = /\/targets\?offset=(\d+)&limit=(\d+)$/.exec(u);
		if (page) targetLimits.push(Number(page[2]));
		if (page) return reply(targetQueue.shift() ?? answers.targets, { targets: served.slice(Number(page[1]), Number(page[1]) + Number(page[2])) });
		return reply(answers.run, detailRun);
	}));
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	resetSettingsViewer();
	vi.unstubAllGlobals();
	setLocale(locale);
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

/** Open a run and come back: the list loads again in place, keeping what it held. */
async function reloadList(): Promise<void> {
	pageStore.store!.set({ url: new URL(`${LIST_URL}&run=r1`) });
	await settle();
	pageStore.store!.set({ url: new URL(LIST_URL) });
	await settle();
}

const RATE = 'Zu viele Anfragen in kurzer Zeit. Warte einen Moment und lade die Seite dann neu.';
const REACHABLE = 'Ist die Engine erreichbar?';

describe('the sentence for a failed load', () => {
	it('names the rate limit only when every failed answer was a 429', () => {
		expect(bulkLoadErrorKey([429])).toBe('common.rate_limited');
		expect(bulkLoadErrorKey([429, 429])).toBe('common.rate_limited');
		expect(bulkLoadErrorKey([null])).toBe('common.load_failed');
		expect(bulkLoadErrorKey([500])).toBe('common.load_failed');
		expect(bulkLoadErrorKey([429, 500])).toBe('common.load_failed');
		expect(bulkLoadErrorKey([429, null])).toBe('common.load_failed');
		expect(bulkLoadErrorKey([])).toBe('common.load_failed');
	});

	it('reads as worded, in German and in English', () => {
		expect(t('common.rate_limited')).toBe(RATE);
		setLocale('en');
		expect(t('common.rate_limited')).toBe('Too many requests in a short time. Wait a moment, then reload the page.');
	});
});

describe('a run\'s page that could not load', () => {
	it('says too many requests on a 429 for the run, and not that the engine is unreachable', async () => {
		answers.run = 429;
		await renderDetail();
		expect(target.textContent).toContain(RATE);
		expect(target.textContent).not.toContain(REACHABLE);
	});

	it('says too many requests on a 429 for the run\'s targets', async () => {
		answers.targets = 429;
		await renderDetail();
		expect(target.textContent).toContain(RATE);
		expect(target.textContent).not.toContain(REACHABLE);
	});

	it('says too many requests on a 429 while it loads a preview whole', async () => {
		detailRun = makeRun({ phase: 'previewed', applied: 0 });
		answers.targets = 429;
		await renderDetail();
		// Whole: the preview is asked for in full pages, not as the short first page.
		expect(targetLimits).toEqual([500]);
		expect(target.textContent).toContain(RATE);
		expect(target.textContent).not.toContain(REACHABLE);
	});

	it('says too many requests on a 429 while it loads what an undo deletes', async () => {
		served = [{ ...TARGETS[0]!, change: 'delete' }];
		detailRun = makeRun({ kind: 'undo', changes: { update: 0, create: 0, delete: 1, unchanged: 0, invalid: 0 } });
		targetQueue = [200, 429];
		await renderDetail();
		expect(target.textContent).toContain(RATE);
		expect(target.textContent).not.toContain(REACHABLE);
	});

	it('says too many requests when showing more targets gets a 429', async () => {
		served = Array.from({ length: 8 }, (_, i) => ({ ...TARGETS[0]!, seq: i + 1, key: `gid://shopify/Product/${i + 1}` }));
		detailRun = makeRun({ total: 8, applied: 8, changes: { update: 8, create: 0, delete: 0, unchanged: 0, invalid: 0 } });
		await renderDetail();
		expect(target.textContent).not.toContain(RATE);
		answers.targets = 429;
		const more = [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === tf('bulk.preview.show_all', { n: '8' }));
		expect(more).toBeDefined();
		more!.click();
		await settle();
		expect(target.textContent).toContain(RATE);
		expect(target.textContent).not.toContain(REACHABLE);
	});

	it('keeps the engine sentence when no answer came at all', async () => {
		answers.run = 'throw';
		await renderDetail();
		expect(target.textContent).toContain(t('common.load_failed'));
		expect(target.textContent).not.toContain(RATE);
	});

	it('keeps the engine sentence on another refusal', async () => {
		answers.targets = 500;
		await renderDetail();
		expect(target.textContent).toContain(t('common.load_failed'));
		expect(target.textContent).not.toContain(RATE);
	});

	it('shows the run when it loads (control)', async () => {
		await renderDetail();
		expect(target.textContent).not.toContain(RATE);
		expect(target.textContent).not.toContain(REACHABLE);
		expect(target.querySelector('[data-testid="bulk-target-admin"]')).not.toBeNull();
	});
});

describe('the run list that could not load', () => {
	it('says too many requests on a 429, and neither that the engine is unreachable nor that there are no runs', async () => {
		answers.runs = 429;
		await renderList();
		expect(target.textContent).toContain(RATE);
		expect(target.textContent).not.toContain(REACHABLE);
		expect(target.textContent).not.toContain(t('bulk.empty'));
	});

	it('says too many requests when only the merges got a 429, and that there are no runs, since it read the run list', async () => {
		answers.merges = 429;
		await renderList();
		expect(target.textContent).toContain(RATE);
		expect(target.textContent).not.toContain(REACHABLE);
		expect(target.textContent).toContain(t('bulk.empty'));
	});

	it('keeps the engine sentence without an answer, and does not say there are no runs', async () => {
		answers.runs = 'throw';
		await renderList();
		expect(target.textContent).toContain(t('common.load_failed'));
		expect(target.textContent).not.toContain(RATE);
		expect(target.textContent).not.toContain(t('bulk.empty'));
	});

	it('keeps the engine sentence when one answer was a 429 and the other another refusal', async () => {
		answers.runs = 429;
		answers.merges = 500;
		await renderList();
		expect(target.textContent).toContain(t('common.load_failed'));
		expect(target.textContent).not.toContain(RATE);
	});

	it('keeps the rows it showed and says too many requests when a reload gets a 429', async () => {
		listed = [makeRun() as unknown as BulkRun];
		await renderList();
		expect(target.querySelectorAll('tbody tr').length).toBe(1);
		answers.runs = 429;
		await reloadList();
		expect(target.textContent).toContain(RATE);
		expect(target.querySelectorAll('tbody tr').length).toBe(1);
	});

	it('no longer says there are no runs when a reload after an empty list gets a 429', async () => {
		await renderList();
		expect(target.textContent).toContain(t('bulk.empty'));
		answers.runs = 429;
		await reloadList();
		expect(target.textContent).toContain(RATE);
		expect(target.textContent).not.toContain(t('bulk.empty'));
	});

	it('says there are no runs when the run list was read empty and the merges answer could not be read', async () => {
		answers.merges = 'bad';
		await renderList();
		expect(target.textContent).toContain(t('common.load_failed'));
		expect(target.textContent).toContain(t('bulk.empty'));
	});

	it('does not say there are no runs when the run list answer could not be read', async () => {
		answers.runs = 'bad';
		await renderList();
		expect(target.textContent).toContain(t('common.load_failed'));
		expect(target.textContent).not.toContain(t('bulk.empty'));
	});

	it('says only the error when an earlier load read an empty list and a later one, ending last, got a 429', async () => {
		holdRuns = true;
		await renderList();
		await reloadList();
		expect(heldRuns.length).toBe(2);
		heldRuns[0]!(200);
		await settle();
		// The earlier load read the empty list: until the later one ends, the page says so.
		expect(target.textContent).toContain(t('bulk.empty'));
		heldRuns[1]!(429);
		await settle();
		expect(target.textContent).toContain(RATE);
		expect(target.textContent).not.toContain(t('bulk.empty'));
	});

	it('says there are no runs once it read an empty list', async () => {
		await renderList();
		expect(target.textContent).toContain(t('bulk.empty'));
		expect(target.textContent).not.toContain(REACHABLE);
		expect(target.textContent).not.toContain(RATE);
	});

	it('says there are no runs when bulk runs are off (404)', async () => {
		answers.runs = 404;
		await renderList();
		expect(target.textContent).toContain(t('bulk.empty'));
		expect(target.textContent).not.toContain(REACHABLE);
	});
});
