import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { BulkRunDetailData, BulkTarget } from './bulk-runs.js';
import { BULK_FOLLOW_MS, BULK_FOLLOW_MAX_MS, BULK_FOLLOW_BACKOFF_MAX_MS, bulkEngineWorking, bulkFollowDelay } from './bulk-runs.js';

// The page of a run the engine moves on by itself — a list read, a judging, a write the owner
// started — follows it: it asks again until the run waits for the owner or has ended. Before, it
// loaded once right after the click and showed that state until the owner reloaded.

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
		id: 'r1', createdAt: '2026-11-13T12:34:00Z', targetSystem: 'http:demo.myshopify.com', phase: 'planned', total: 0,
		changes: { update: 0, create: 0, delete: 0, unchanged: 0, invalid: 0 }, applied: 0, failed: 0, conflicts: 0, sentUnknown: 0, undone: 0,
		kind: 'apply', atomic: false, sourceRunId: null, writeMethod: null, probeConfirmed: false, writeForm: 'unmeasured', haltReason: null, haltKey: null,
		costUsd: 0, costCapUsd: null, judge: null, maxTargets: null, failedOnce: 0, failureLimit: 0, resumeOpen: 0, resumeTries: 0, resumeSends: 0, deselected: 0,
		checksum: null, writeFormNote: null, writeFormConfirmation: null, judgeModel: null, resumesAt: null, probe: null, undoable: 0,
		listFirstPage: null, listStartChecksum: null, listNote: null, listFilters: null, judgeRule: null, judgeRuleHash: null, judgeServedBy: null, judgeOwnKey: false,
		undoneBy: null,
		...o,
	};
}

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let run: BulkRunDetailData;
let runAsks: number;
let targetAsks: number;
let posts: string[];
// What the next ask for the run is answered with: 200 with the run, or a refusal.
let runStatus: number;
let retryAfter: string | null;
// Statuses for the next asks, one each, before `runStatus` applies again.
let nextStatuses: number[];
// Statuses for the next asks for targets, one each, before 200 applies again; and each ask's limit.
let targetStatuses: number[];
let targetLimits: number[];
// The run's targets as the engine serves them, page by page.
let allTargets: BulkTarget[];
let r1Fails = false;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	target = document.createElement('div');
	document.body.appendChild(target);
	run = makeRun();
	runAsks = 0;
	targetAsks = 0;
	posts = [];
	runStatus = 200;
	retryAfter = null;
	nextStatuses = [];
	targetStatuses = [];
	targetLimits = [];
	allTargets = [];
	r1Fails = false;
	Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
	vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
		const u = String(url);
		const reply = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
		if (u.endsWith('/config')) return reply({ managed: true, viewer: 'owner' });
		if (init?.method === 'POST') { posts.push(u); return reply({}); }
		if (/\/targets\?/.test(u)) {
			targetAsks++;
			targetLimits.push(Number(/limit=(\d+)/.exec(u)?.[1]));
			const ts = targetStatuses.shift() ?? 200;
			if (ts !== 200) return new Response('{}', { status: ts, headers: { 'Content-Type': 'application/json', ...(retryAfter !== null ? { 'Retry-After': retryAfter } : {}) } });
			const off = Number(/offset=(\d+)/.exec(u)?.[1]);
			return reply({ targets: allTargets.slice(off, off + targetLimits.at(-1)!) });
		}
		runAsks++;
		const status = nextStatuses.shift() ?? runStatus;
		if (status !== 200) return new Response(JSON.stringify({ error: 'Too many requests' }), { status, headers: { 'Content-Type': 'application/json', ...(retryAfter !== null ? { 'Retry-After': retryAfter } : {}) } });
		return reply(run);
	}));
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await vi.advanceTimersByTimeAsync(0);
		await tick();
		flushSync();
	}
}

async function render(): Promise<void> {
	const { default: BulkRunDetail } = await import('./BulkRunDetail.svelte');
	component = mount(BulkRunDetail, { target, props: { runId: 'r1', onBack: () => {}, onOpen: () => {} } });
	await settle();
}

/** Let `ms` pass, with the page's answers handled after each ask. */
async function pass(ms: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
	await settle();
}

const shown = (): string => target.textContent ?? '';

describe('bulkEngineWorking', () => {
	it('is true only while the engine moves the run on by itself', () => {
		expect(bulkEngineWorking({ phase: 'planned', haltKey: null, haltReason: null })).toBe(true);
		expect(bulkEngineWorking({ phase: 'approved', haltKey: null, haltReason: null })).toBe(true);
		expect(bulkEngineWorking({ phase: 'writing', haltKey: null, haltReason: null })).toBe(true);
		// Waiting for the owner: a start, a probe or any halt, an approval, or an end.
		expect(bulkEngineWorking({ phase: 'planned', haltKey: 'awaitingStart', haltReason: 'awaitingStart' })).toBe(false);
		expect(bulkEngineWorking({ phase: 'planned', haltKey: 'listed', haltReason: 'listed' })).toBe(false);
		expect(bulkEngineWorking({ phase: 'writing', haltKey: 'probeRequired', haltReason: 'probeRequired' })).toBe(false);
		expect(bulkEngineWorking({ phase: 'previewed', haltKey: null, haltReason: null })).toBe(false);
		expect(bulkEngineWorking({ phase: 'done', haltKey: null, haltReason: null })).toBe(false);
		expect(bulkEngineWorking({ phase: 'aborted', haltKey: null, haltReason: null })).toBe(false);
		expect(bulkEngineWorking({ phase: 'undone', haltKey: null, haltReason: null })).toBe(false);
		// A halt whose reason this page does not know (a newer engine) still counts as a halt.
		expect(bulkEngineWorking({ phase: 'writing', haltKey: null, haltReason: 'someNewHalt' })).toBe(false);
	});
});

describe('the page of a run the engine is moving on', () => {
	it('shows the read list without a reload once the engine has read it', async () => {
		// Opened while the list is being read: no targets yet.
		await render();
		expect(runAsks).toBe(1);
		expect(shown()).not.toContain('17');
		// The engine finishes the list: 17 targets, and the run waits for the owner's start.
		run = makeRun({ total: 17, changes: { update: 17, create: 0, delete: 0, unchanged: 0, invalid: 0 }, haltKey: 'listed', haltReason: 'listed' });
		await pass(BULK_FOLLOW_MS);
		expect(shown()).toContain('17');
	});

	it('follows a start the owner clicked until the run waits for the owner again', async () => {
		run = makeRun({ haltKey: 'awaitingStart', haltReason: 'awaitingStart', listFirstPage: 'https://demo.myshopify.com/', listStartChecksum: 'c1' });
		await render();
		expect(runAsks).toBe(1);
		const startButton = [...target.querySelectorAll('button')].find((b) => !b.disabled && /lesen|read/i.test(b.textContent ?? ''));
		expect(startButton).toBeDefined();
		// The engine takes the start: from now on it reads the list, then waits for the owner.
		run = makeRun({ listFirstPage: 'https://demo.myshopify.com/' });
		startButton!.click();
		await settle();
		expect(posts.some((p) => p.endsWith('/bulk/runs/r1/resume'))).toBe(true);
		const afterClick = runAsks;
		await pass(BULK_FOLLOW_MS);
		expect(runAsks).toBe(afterClick + 1);
		expect(shown()).not.toContain('17');
		run = makeRun({ total: 17, changes: { update: 17, create: 0, delete: 0, unchanged: 0, invalid: 0 }, haltKey: 'listed', haltReason: 'listed' });
		await pass(BULK_FOLLOW_MS);
		expect(shown()).toContain('17');
		// Now it waits for the owner: the page stops asking.
		const settled = runAsks;
		await pass(BULK_FOLLOW_MS * 5);
		expect(runAsks).toBe(settled);
	});

	it('does not ask again for a run that waits for the owner', async () => {
		run = makeRun({ phase: 'previewed', total: 3 });
		await render();
		await pass(BULK_FOLLOW_MS * 5);
		expect(runAsks).toBe(1);
	});

	it('gives up after its limit', async () => {
		await render();
		await pass(BULK_FOLLOW_MAX_MS + BULK_FOLLOW_MS * 2);
		const atLimit = runAsks;
		expect(atLimit).toBeGreaterThan(1);
		expect(atLimit).toBeLessThanOrEqual(BULK_FOLLOW_MAX_MS / BULK_FOLLOW_MS + 3);
		await pass(BULK_FOLLOW_MS * 5);
		expect(runAsks).toBe(atLimit);
	});

	it('stops asking once the page is gone', async () => {
		await render();
		await pass(BULK_FOLLOW_MS);
		const before = runAsks;
		unmount(component!);
		component = undefined;
		await pass(BULK_FOLLOW_MS * 5);
		expect(runAsks).toBe(before);
	});

	it('asks for the run alone while it has not moved, and for its targets only once it has', async () => {
		await render();
		const targetsAtStart = targetAsks;
		await pass(BULK_FOLLOW_MS * 3);
		expect(runAsks).toBe(4);
		expect(targetAsks).toBe(targetsAtStart);
		run = makeRun({ total: 17, changes: { update: 17, create: 0, delete: 0, unchanged: 0, invalid: 0 }, haltKey: 'listed', haltReason: 'listed' });
		await pass(BULK_FOLLOW_MS);
		expect(targetAsks).toBeGreaterThan(targetsAtStart);
	});

	it('takes a run whose only change is when it resumes as moved', async () => {
		run = makeRun({ phase: 'writing', total: 3, applied: 1 });
		await render();
		const targetsAtStart = targetAsks;
		run = makeRun({ phase: 'writing', total: 3, applied: 1, resumesAt: '2026-11-13T16:00:00Z' });
		await pass(BULK_FOLLOW_MS);
		expect(targetAsks).toBe(targetsAtStart + 1);
	});

	it('does not ask while the tab is hidden', async () => {
		await render();
		Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
		await pass(BULK_FOLLOW_MS * 4);
		expect(runAsks).toBe(1);
		Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
		await pass(BULK_FOLLOW_MS);
		expect(runAsks).toBe(2);
	});

	it('backs off on a 429 as long as Retry-After says, and keeps the page as it was', async () => {
		await render();
		runStatus = 429;
		retryAfter = '20';
		await pass(BULK_FOLLOW_MS);
		const refused = runAsks;
		expect(refused).toBe(2);
		// The page does not turn into an error: the run stays shown.
		expect(shown()).not.toMatch(/Laden fehlgeschlagen|Failed to load/);
		expect(target.querySelector('[aria-current="step"]')).not.toBeNull();
		// Not again before the 20 s it was told.
		await pass(19_000);
		expect(runAsks).toBe(refused);
		runStatus = 200;
		run = makeRun({ total: 17, changes: { update: 17, create: 0, delete: 0, unchanged: 0, invalid: 0 }, haltKey: 'listed', haltReason: 'listed' });
		await pass(1_500);
		// Asked again once the wait was over; the run moved, so the page loaded it whole.
		expect(runAsks).toBeGreaterThan(refused);
		expect(shown()).toContain('17');
	});
});

describe('a follow ask whose load is refused', () => {
	it('keeps the page as it was and backs off when the targets of a moved run get a 429', async () => {
		await render();
		// The ask finds the run moved and still working; its targets are refused.
		run = makeRun({ total: 17, changes: { update: 17, create: 0, delete: 0, unchanged: 0, invalid: 0 } });
		targetStatuses = [429];
		retryAfter = '20';
		await pass(BULK_FOLLOW_MS);
		const refused = runAsks;
		expect(shown()).not.toMatch(/Laden fehlgeschlagen|Failed to load/);
		expect(target.querySelector('[aria-current="step"]')).not.toBeNull();
		// The page did not take the run half: no 17 without its targets.
		expect(shown()).not.toContain('17');
		await pass(19_000);
		expect(runAsks).toBe(refused);
		await pass(1_500);
		expect(runAsks).toBe(refused + 1);
		expect(shown()).toContain('17');
	});

	it('keeps the page as it was and backs off when the load after the run stopped working gets a 429', async () => {
		await render();
		// The ask finds the run waiting for the owner now; the load that follows is refused.
		run = makeRun({ total: 17, changes: { update: 17, create: 0, delete: 0, unchanged: 0, invalid: 0 }, haltKey: 'listed', haltReason: 'listed' });
		nextStatuses = [200, 429];
		retryAfter = '20';
		await pass(BULK_FOLLOW_MS);
		const refused = runAsks;
		expect(refused).toBe(3);
		expect(shown()).not.toMatch(/Laden fehlgeschlagen|Failed to load/);
		expect(target.querySelector('[aria-current="step"]')).not.toBeNull();
		await pass(19_000);
		expect(runAsks).toBe(refused);
		await pass(1_500);
		expect(shown()).toContain('17');
	});
});

describe('a large run being written', () => {
	const many = (n: number): BulkTarget[] => Array.from({ length: n }, (_, i) => ({ seq: i + 1, key: `k${i + 1}`, change: 'update', diff: { kind: 'none' }, error: null, deselected: false }) as BulkTarget);

	it('asks for the shown targets in one request of at most a page, never page by page', async () => {
		allTargets = many(300);
		run = makeRun({ phase: 'writing', total: 300, applied: 10, shopAddedMarkup: 1 } as Partial<BulkRunDetailData>);
		await render();
		const runsAtStart = runAsks;
		const targetsAtStart = targetAsks;
		run = makeRun({ phase: 'writing', total: 300, applied: 60, shopAddedMarkup: 1 } as Partial<BulkRunDetailData>);
		await pass(BULK_FOLLOW_MS);
		expect(runAsks).toBe(runsAtStart + 1);
		expect(targetAsks).toBe(targetsAtStart + 1);
		expect(targetLimits.at(-1)).toBe(300);
	});

	it('does not ask a whole list of more than a page again while the run is written', async () => {
		allTargets = many(1200);
		run = makeRun({ phase: 'writing', total: 1200, applied: 10, shopAddedMarkup: 1 } as Partial<BulkRunDetailData>);
		await render();
		// Opening loads it whole (three pages): the mark points into the whole list.
		expect(targetAsks).toBe(3);
		run = makeRun({ phase: 'writing', total: 1200, applied: 60, shopAddedMarkup: 1 } as Partial<BulkRunDetailData>);
		await pass(BULK_FOLLOW_MS * 3);
		expect(targetAsks).toBe(3);
		expect(runAsks).toBe(4);
	});
});

describe('a load for a run the page no longer shows', () => {
	it('writes nothing once the page shows another run', async () => {
		// r1 answers only when released; r2 at once.
		let release: () => void = () => {};
		const held = new Promise<void>((r) => { release = r; });
		const r1 = makeRun({ id: 'r1', phase: 'done', total: 17 });
		const r2 = makeRun({ id: 'r2', phase: 'done', total: 42 });
		vi.stubGlobal('fetch', vi.fn(async (url: string) => {
			const u = String(url);
			const reply = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
			if (u.endsWith('/config')) return reply({ managed: true, viewer: 'owner' });
			if (/\/targets\?/.test(u)) return reply({ targets: [] });
			if (u.includes('/bulk/runs/r1')) { await held; return r1Fails ? new Response('{}', { status: 500 }) : reply(r1); }
			return reply(r2);
		}));
		const props = $state({ runId: 'r1', onBack: () => {}, onOpen: () => {} });
		const { default: BulkRunDetail } = await import('./BulkRunDetail.svelte');
		component = mount(BulkRunDetail, { target, props });
		await settle();
		props.runId = 'r2';
		await settle();
		expect(shown()).toContain('42');
		release();
		await settle();
		expect(shown()).toContain('42');
		expect(shown()).not.toContain('17');
	});
	it('shows no error of it once the page shows another run', async () => {
		r1Fails = true;
		// r1 answers only when released; r2 at once.
		let release: () => void = () => {};
		const held = new Promise<void>((r) => { release = r; });
		const r1 = makeRun({ id: 'r1', phase: 'done', total: 17 });
		const r2 = makeRun({ id: 'r2', phase: 'done', total: 42 });
		vi.stubGlobal('fetch', vi.fn(async (url: string) => {
			const u = String(url);
			const reply = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
			if (u.endsWith('/config')) return reply({ managed: true, viewer: 'owner' });
			if (/\/targets\?/.test(u)) return reply({ targets: [] });
			if (u.includes('/bulk/runs/r1')) { await held; return r1Fails ? new Response('{}', { status: 500 }) : reply(r1); }
			return reply(r2);
		}));
		const props = $state({ runId: 'r1', onBack: () => {}, onOpen: () => {} });
		const { default: BulkRunDetail } = await import('./BulkRunDetail.svelte');
		component = mount(BulkRunDetail, { target, props });
		await settle();
		props.runId = 'r2';
		await settle();
		expect(shown()).toContain('42');
		release();
		await settle();
		expect(shown()).toContain('42');
		expect(shown()).not.toMatch(/Laden fehlgeschlagen|Failed to load/);
	});
});

describe('bulkFollowDelay', () => {
	it('goes back to the base after a good answer', () => {
		expect(bulkFollowDelay(40_000, true, null)).toBe(BULK_FOLLOW_MS);
	});
	it('doubles after a refusal, waits at least what Retry-After says, and never more than the cap', () => {
		expect(bulkFollowDelay(BULK_FOLLOW_MS, false, null)).toBe(BULK_FOLLOW_MS * 2);
		expect(bulkFollowDelay(BULK_FOLLOW_MS, false, 30)).toBe(30_000);
		expect(bulkFollowDelay(BULK_FOLLOW_MS, false, Number.NaN)).toBe(BULK_FOLLOW_MS * 2);
		expect(bulkFollowDelay(BULK_FOLLOW_BACKOFF_MAX_MS, false, null)).toBe(BULK_FOLLOW_BACKOFF_MAX_MS);
		expect(bulkFollowDelay(BULK_FOLLOW_MS, false, 600)).toBe(BULK_FOLLOW_BACKOFF_MAX_MS);
	});
});
