import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { BulkRunDetailData, BulkTarget, BulkHeads } from './bulk-runs.js';
import { bulkHaltSuffixKey } from './bulk-runs.js';
import { t, tf, getLocale, setLocale } from '../i18n.svelte.js';

// A halted run's sentences on a target whose send has no clear answer (U-364):
// the halt names unclear targets apart from the ones that could not be written, the step "check
// the targets with an error below" stands only where the preview marks one, the count of failed
// targets so far leaves the unclear ones out, a cancelled run is called cancelled, and the rest
// of a run with no way on has no result rather than being open.

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
// While set, the run's answer arrives but its body is read only once this settles.
let holdBody: Promise<void> | null = null;

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
	holdBody = null;
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
		const res = reply(run);
		if (holdBody !== null) {
			const hold = holdBody;
			const snap = run;
			res.json = async () => { await hold; return snap; };
		}
		return res;
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


const shown = (): string => target.textContent ?? '';
const counts = (): string | null => target.querySelector('[data-testid="bulk-counts"]')?.textContent ?? null;
const UPDATES = (n: number) => ({ update: n, create: 0, delete: 0, unchanged: 0, invalid: 0 });
const NONE: BulkHeads = { deselected: 0, invalid: 0, unchanged: 0, takenBack: 0, written: 0, conflict: 0, unclear: 0, failed: 0, settled: 0, open: 0 };
const field = (seq: number, error: string | null = null): BulkTarget => ({
	seq, key: `https://demo.myshopify.com/products/${String(seq)}`, change: 'update', error, deselected: false,
	diff: { kind: 'fields', fields: [{ field: 'price', before: '12.00', after: '15' }] },
});
const unread = (seq: number, error: string): BulkTarget => ({ ...field(seq, error), diff: { kind: 'none' } });

/** A write run halted on its failure rate, with `f` targets failed now and `u` sends unclear in this pass. */
function halted(f: number, u: number, o: Partial<BulkRunDetailData> = {}): BulkRunDetailData {
	const total = o.total ?? f + u + 2;
	// A run halted on its failures is loaded whole: the engine serves every target.
	allTargets = Array.from({ length: total }, (_, i) => field(i));
	return makeRun({
		phase: 'writing', total, changes: UPDATES(total), haltKey: 'failureRate', haltReason: 'more than 5 % of the targets failed',
		probeConfirmed: true, maxTargets: total, failed: f + u, failedOnce: f, passUnclear: u, passFailed: f, secretFailed: 0, sentUnknown: u, failureLimit: 0,
		resumeOpen: 2 + f, resumeTries: 2 + f, resumeSends: 2 + f, heads: { ...NONE, failed: f, unclear: u, open: 2 }, ...o,
	});
}

describe('the halt on a target whose send is unclear', () => {
	let locale: ReturnType<typeof getLocale>;
	beforeEach(() => { locale = getLocale(); setLocale('de'); });
	afterEach(() => { setLocale(locale); });

	it('names one unclear target as unclear, not as one that could not be written', async () => {
		run = halted(0, 1);
		await render();
		expect(shown()).toContain('In diesem Durchgang blieb bei einem Ziel offen, ob die Änderung angekommen ist.');
		expect(shown()).not.toContain('liess sich ein Ziel nicht schreiben');
	});

	it('names several unclear targets with their number, never the limit', async () => {
		run = halted(0, 3);
		await render();
		expect(shown()).toContain('In diesem Durchgang blieb bei 3 Zielen offen, ob die Änderung angekommen ist.');
		expect(shown()).not.toContain('mehr als');
	});

	it('names failed and unclear targets apart, each in the singular where it is one', async () => {
		const cases: [number, number, string][] = [
			[2, 3, 'In diesem Durchgang liessen sich 2 Ziele nicht schreiben, und bei 3 blieb offen, ob die Änderung angekommen ist.'],
			[1, 3, 'In diesem Durchgang liess sich 1 Ziel nicht schreiben, und bei 3 blieb offen, ob die Änderung angekommen ist.'],
			[2, 1, 'In diesem Durchgang liessen sich 2 Ziele nicht schreiben, und bei 1 Ziel blieb offen, ob die Änderung angekommen ist.'],
			[1, 1, 'In diesem Durchgang liess sich 1 Ziel nicht schreiben, und bei 1 Ziel blieb offen, ob die Änderung angekommen ist.'],
		];
		for (const [f, u, said] of cases) {
			if (component) unmount(component);
			component = undefined;
			run = halted(f, u);
			await render();
			expect(shown(), `${String(f)}/${String(u)}`).toContain(said);
		}
	});

	it('says it in English too', async () => {
		setLocale('en');
		run = halted(0, 1);
		await render();
		expect(shown()).toContain('In this pass, it stayed unclear whether one change arrived.');
		unmount(component!);
		run = halted(2, 3);
		await render();
		expect(shown()).toContain('In this pass, 2 targets could not be written, and for 3 it stayed unclear whether the change arrived.');
	});

	it('names a target failed on its secret apart, without a number or a pass, and never as one of this pass\'s failures', async () => {
		const secret = 'Dazu kommen Ziele, deren Wert etwas enthält, das lynox nicht hinausgibt, etwa einen Schlüssel. Sie lassen sich so nicht schreiben.';
		// The head counts that target as failed; the pass's own count does not.
		run = halted(0, 1, { heads: { ...NONE, failed: 1, unclear: 1, open: 2 }, failed: 2, secretFailed: 1 });
		await render();
		expect(shown()).toContain(`In diesem Durchgang blieb bei einem Ziel offen, ob die Änderung angekommen ist. ${secret}`);
		expect(shown()).not.toContain('liess sich 1 Ziel nicht schreiben');
		unmount(component!);
		// With no failure of this pass on record, only that sentence: not the one on the limit.
		run = halted(0, 0, { heads: { ...NONE, failed: 1, open: 2 }, failed: 1, secretFailed: 1 });
		await render();
		expect(shown()).toContain(secret);
		expect(shown()).not.toContain(t('bulk.halt.failureRate_write0'));
		unmount(component!);
		// Nothing on record and no such target: the sentence on the limit.
		run = halted(0, 0, { heads: { ...NONE, failed: 1, open: 2 }, failed: 1 });
		await render();
		expect(shown()).toContain(t('bulk.halt.failureRate_write0'));
		expect(shown()).not.toContain(secret);
		setLocale('en');
		expect(t('bulk.halt.secret_targets')).toBe('There are also targets whose value contains something lynox does not send out, such as a key. They cannot be written as they are.');
	});

	it('keeps the sentence on a target that could not be written where no send is unclear, or the engine does not say', async () => {
		run = halted(1, 0);
		await render();
		expect(shown()).toContain(t('bulk.halt.failureRate_write0'));
		unmount(component!);
		run = halted(0, 1, { passUnclear: undefined });
		await render();
		expect(shown()).toContain(t('bulk.halt.failureRate_write0'));
	});
});

describe('the halt on three failures in a row', () => {
	it('names them as unclear where every failure of the pass is unclear, as either where both kinds are, and keeps its sentence where none is', async () => {
		const cases: [number, number, string][] = [
			[0, 3, 'Bei drei Zielen hintereinander blieb offen, ob die Änderung angekommen ist.'],
			[1, 2, 'Bei drei Zielen hintereinander schlug das Schreiben fehl oder blieb offen, ob die Änderung angekommen ist.'],
			[3, 0, 'Dreimal hintereinander liess sich ein Ziel nicht schreiben.'],
		];
		// A target failed on its secret may be one of the three: never "only unclear" then.
		if (component) unmount(component);
		component = undefined;
		run = halted(0, 3, { haltKey: 'consecutiveFailures', haltReason: 'three consecutive targets failed', failureLimit: 5, secretFailed: 1 });
		await render();
		expect(shown()).toContain('Bei drei Zielen hintereinander schlug das Schreiben fehl oder blieb offen, ob die Änderung angekommen ist. Dazu kommen Ziele');
		for (const [f, u, said] of cases) {
			if (component) unmount(component);
			component = undefined;
			run = halted(f, u, { haltKey: 'consecutiveFailures', haltReason: 'three consecutive targets failed', failureLimit: 5 });
			await render();
			expect(shown(), `${String(f)}/${String(u)}`).toContain(said);
		}
		unmount(component!);
		component = undefined;
		run = halted(0, 3, { haltKey: 'consecutiveFailures', haltReason: 'three consecutive targets failed', failureLimit: 5, passFailed: undefined });
		await render();
		expect(shown()).toContain('Dreimal hintereinander liess sich ein Ziel nicht schreiben.');
		const locale = getLocale();
		setLocale('en');
		try {
			expect(t('bulk.halt.consecutiveFailures_unclear')).toBe('For three targets in a row, it stayed unclear whether the change arrived.');
			expect(t('bulk.halt.consecutiveFailures_mixed')).toBe('For three targets in a row, writing failed or it stayed unclear whether the change arrived.');
		} finally { setLocale(locale); }
	});
});

describe('the step to check the targets with an error', () => {
	it('stands only where the preview marks a target with a failure', async () => {
		const step = t('bulk.halt.failures_before_write');
		run = halted(1, 0);
		allTargets = [field(0, 'write_failed'), field(1), field(2)];
		await render();
		// A target with a diff shows the diff, not its error: nothing below is marked.
		expect(shown()).not.toContain(step);
		unmount(component!);
		allTargets = [unread(0, 'write_failed'), field(1), field(2)];
		await render();
		expect(shown()).toContain(step);
		unmount(component!);
		// A conflict or an unclear send is not a failure.
		allTargets = [unread(0, 'conflict'), unread(1, 'sent_unknown'), field(2)];
		await render();
		expect(shown()).not.toContain(step);
	});

	it('loads every target of a run halted on its failures, so a marked one past the first page counts', async () => {
		run = halted(1, 0, { total: 12, changes: UPDATES(12), heads: { ...NONE, failed: 1, open: 11 } });
		allTargets = [...Array.from({ length: 10 }, (_, i) => field(i)), unread(10, 'write_failed'), field(11)];
		await render();
		expect(shown()).toContain(t('bulk.halt.failures_before_write'));
		expect(target.textContent).toContain('/products/11');
	});
});

describe('the failed targets so far', () => {
	it('counts only the targets that failed, never one whose send is unclear', async () => {
		// The engine leaves the unclear one out of `failedOnce`; with none left the line is gone.
		run = halted(0, 1, { resumeSends: 2 });
		await render();
		expect(shown()).not.toMatch(/gescheitert/);
		unmount(component!);
		run = halted(2, 1, { failedOnce: 2, resumeSends: 4 });
		await render();
		expect(shown()).toContain(tf('bulk.resume.failed_so_far', { n: '2' }));
		expect(shown()).not.toContain(tf('bulk.resume.failed_so_far', { n: '3' }));
	});
});

describe('a cancelled run', () => {
	it('is called cancelled over its cause and in the list, not halted', async () => {
		run = makeRun({ phase: 'aborted', total: 4, changes: UPDATES(4), haltKey: 'mandateEnded', haltReason: 'the access that planned this run has ended before it was approved', heads: { ...NONE, open: 4 } });
		await render();
		const dt = [...target.querySelectorAll('dt')].map((d) => d.textContent);
		expect(dt).toContain('Abgebrochen');
		expect(dt).not.toContain('Angehalten');
		expect(bulkHaltSuffixKey({ phase: 'aborted', haltKey: 'mandateEnded' })).toBeNull();
		expect(bulkHaltSuffixKey({ phase: 'aborted', haltKey: 'stoppedByOwner' })).toBeNull();
		expect(bulkHaltSuffixKey({ phase: 'writing', haltKey: 'mandateEnded' })).toBe('bulk.halted_suffix');
		const locale = getLocale();
		setLocale('en');
		try {
			expect(t('bulk.head.aborted')).toBe('Cancelled');
			expect(t('bulk.phase.aborted')).toBe('cancelled');
		} finally { setLocale(locale); }
	});
});

describe('a run halted with no way on', () => {
	it('gives its rest no result, as an ended run, while a run that can go on keeps it open', async () => {
		run = makeRun({ phase: 'writing', total: 3, changes: UPDATES(3), applied: 1, haltKey: 'checksum', haltReason: 'the run changed since it was approved', probeConfirmed: true, heads: { ...NONE, written: 1, open: 2 } });
		await render();
		expect(shown()).toContain(t('bulk.resume.none'));
		expect(counts()).toBe('3 Ziele: 1 geschrieben · 0 Konflikte · 0 fehlgeschlagen · 2 ohne Ergebnis');
		unmount(component!);
		run = { ...run, haltKey: 'unavailable', haltReason: 'unavailable', resumeOpen: 2, resumeTries: 2, resumeSends: 2 };
		await render();
		expect(counts()).toBe('3 Ziele: 1 geschrieben · 0 Konflikte · 0 fehlgeschlagen · 2 offen');
	});
});
