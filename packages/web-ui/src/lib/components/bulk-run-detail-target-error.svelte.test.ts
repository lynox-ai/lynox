import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { BulkRunDetailData, BulkTarget, BulkHeads } from './bulk-runs.js';
import { bulkTargetErrorText } from './bulk-runs.js';
import { t, getLocale, setLocale } from '../i18n.svelte.js';

// A target with no diff to show shows its error as a sentence, in German and in English, never
// as the engine's code; a code the page does not know reads as a neutral sentence.

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
const UPDATES = (n: number) => ({ update: n, create: 0, delete: 0, unchanged: 0, invalid: 0 });
const NONE: BulkHeads = { deselected: 0, invalid: 0, unchanged: 0, takenBack: 0, written: 0, conflict: 0, unclear: 0, failed: 0, settled: 0, open: 0 };
const field = (seq: number, error: string | null = null): BulkTarget => ({
	seq, key: `https://demo.myshopify.com/products/${String(seq)}`, change: 'update', error, deselected: false,
	diff: { kind: 'fields', fields: [{ field: 'price', before: '12.00', after: '15' }] },
});
const unread = (seq: number, error: string): BulkTarget => ({ ...field(seq, error), diff: { kind: 'none' } });

/** A write run halted on its failures: the engine serves every target, the ones given first. */
function writeRun(targets: BulkTarget[]): BulkRunDetailData {
	allTargets = [...targets, field(targets.length)];
	const total = allTargets.length;
	return makeRun({
		phase: 'writing', total, changes: UPDATES(total), haltKey: 'failureRate', haltReason: 'more than 5 % of the targets failed',
		probeConfirmed: true, maxTargets: total, failed: 1, failedOnce: 1, failureLimit: 0,
		resumeOpen: total - 1, resumeTries: total - 1, resumeSends: total - 1, heads: { ...NONE, failed: 1, open: total - 1 },
	});
}

/** A planned run halted while it read, with targets still unread. */
function planningRun(targets: BulkTarget[]): BulkRunDetailData {
	allTargets = [...targets, field(targets.length)];
	const total = allTargets.length;
	return makeRun({
		phase: 'planned', total, changes: UPDATES(total), haltKey: 'consecutiveFailures', haltReason: 'three consecutive targets failed',
	});
}

const errorTexts = (): string[] => [...target.querySelectorAll('[data-testid="bulk-target-error"]')].map((e) => e.textContent ?? '');

const SENTENCES: Record<string, { de: string; en: string }> = {
	read_failed: { de: 'lynox konnte dieses Ziel nicht lesen.', en: 'lynox could not read this target.' },
	write_failed: { de: 'Beim Schreiben dieses Ziels kam ein Fehler zurück. Ob die Änderung trotzdem angekommen ist, ist offen. Sieh beim Anbieter nach.', en: 'Writing this target returned an error. Whether the change arrived anyway is unclear. Check at the provider.' },
	path_changed: { de: 'Der Ort dieses Ziels hat sich seit dem Lesen geändert. lynox hat es nicht geschrieben.', en: 'Where this target lives changed since it was read. lynox did not write it.' },
	redirect: { de: 'Der Anbieter hat mit einer Weiterleitung geantwortet. lynox folgt keiner Weiterleitung. Ob die Änderung angekommen ist, ist offen. lynox sendet sie nicht noch einmal. Sieh beim Anbieter nach.', en: 'The provider answered with a redirect. lynox never follows one. Whether the change arrived is unclear. lynox does not send it again. Check at the provider.' },
	secret: { de: 'Die Anfrage hätte etwas enthalten, das wie ein Passwort oder Schlüssel aussieht. lynox hat sie nicht gesendet.', en: 'The request would have carried something that looks like a password or key. lynox did not send it.' },
	conflict: { de: 'Dieses Ziel stand beim Nachsehen anders da als erwartet. lynox hat es so gelassen.', en: 'This target looked different than expected when lynox checked it. lynox left it as it was.' },
	sent_unknown: { de: 'Offen, ob die Änderung angekommen ist. lynox sendet sie nicht noch einmal. Sieh beim Anbieter nach.', en: 'Unclear whether the change arrived. lynox does not send it again. Check at the provider.' },
};
// Where the engine says no send to the target is unclear: the change did not arrive.
const NOT_ARRIVED: Record<string, { de: string; en: string }> = {
	write_failed: { de: 'Das Schreiben dieses Ziels ist gescheitert. Die Änderung ist nicht angekommen.', en: 'Writing this target failed. The change did not arrive.' },
	redirect: { de: 'Der Anbieter hat mit einer Weiterleitung geantwortet. lynox folgt keiner Weiterleitung und hat die Änderung nicht gesendet.', en: 'The provider answered with a redirect. lynox never follows one and did not send the change.' },
};
const OTHER = { de: 'Bei diesem Ziel ist etwas schiefgegangen.', en: 'Something went wrong with this target.' };
const WRITE_CODES = ['write_failed', 'path_changed', 'redirect', 'secret', 'conflict', 'sent_unknown'] as const;

describe('the error of a target, in the preview', () => {
	let locale: ReturnType<typeof getLocale>;
	beforeEach(() => { locale = getLocale(); setLocale('de'); });
	afterEach(() => { setLocale(locale); });

	for (const lang of ['de', 'en'] as const) {
		for (const code of WRITE_CODES) {
			it(`says ${code} on a write run as its own sentence in ${lang}, not as the code`, async () => {
				setLocale(lang);
				run = writeRun([unread(0, code)]);
				await render();
				expect(errorTexts()).toEqual([SENTENCES[code]![lang]]);
				if (code.includes('_')) expect(shown()).not.toContain(code);
				expect(errorTexts()[0]).not.toBe(code);
			});
		}

		it(`says a read that failed in planning as its own sentence in ${lang}, not as the code`, async () => {
			setLocale(lang);
			run = planningRun([unread(0, 'read_failed')]);
			await render();
			expect(errorTexts()).toEqual([SENTENCES['read_failed']![lang]]);
			expect(shown()).not.toContain('read_failed');
		});

		it(`says a code the page does not know as a neutral sentence in ${lang}, never as the code`, async () => {
			setLocale(lang);
			run = writeRun([unread(0, 'quota_exceeded'), unread(1, 'toString'), unread(2, 'other')]);
			await render();
			expect(errorTexts()).toEqual([OTHER[lang], OTHER[lang], OTHER[lang]]);
			expect(shown()).not.toContain('quota_exceeded');
			expect(shown()).not.toContain('toString');
		});
	}

	it('gives every code its own sentence, apart from the neutral one and from each other', () => {
		const i18n = { t };
		for (const lang of ['de', 'en'] as const) {
			setLocale(lang);
			const said = [
				...Object.keys(SENTENCES).map((c) => bulkTargetErrorText({ error: c }, i18n)),
				...Object.keys(NOT_ARRIVED).map((c) => bulkTargetErrorText({ error: c, sendUnclear: false }, i18n)),
			];
			expect(new Set(said).size).toBe(said.length);
			expect(said).not.toContain(bulkTargetErrorText({ error: 'quota_exceeded' }, i18n));
			expect(said.every((s) => !s.startsWith('bulk.'))).toBe(true);
		}
	});

	for (const lang of ['de', 'en'] as const) {
		it(`says the error of a target with a diff under its diff in ${lang}`, async () => {
			// A diff alone would read as written or still to write (U-424).
			setLocale(lang);
			run = writeRun([field(0, 'write_failed'), field(1, 'conflict'), field(2, 'sent_unknown')]);
			await render();
			expect(errorTexts()).toEqual([SENTENCES['write_failed']![lang], SENTENCES['conflict']![lang], SENTENCES['sent_unknown']![lang]]);
			const row = target.querySelector('tbody tr')!;
			const after = row.querySelector('[data-testid="bulk-after"]')!;
			const said = row.querySelector('[data-testid="bulk-target-error"]')!;
			// Under the diff: the sentence follows the diff's value in the row.
			expect(after.compareDocumentPosition(said) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
			expect(shown()).not.toContain('write_failed');
		});
	}

	for (const lang of ['de', 'en'] as const) {
		for (const code of ['write_failed', 'redirect'] as const) {
			it(`says ${code} as not arrived in ${lang} only where no send to the target is unclear`, async () => {
				setLocale(lang);
				run = writeRun([
					{ ...unread(0, code), sendUnclear: false },
					{ ...unread(1, code), sendUnclear: true },
					{ ...field(2, code), written: true, sendUnclear: false },
					{ ...field(3, code), written: true, sendUnclear: true },
				]);
				await render();
				expect(errorTexts()).toEqual([NOT_ARRIVED[code]![lang], SENTENCES[code]![lang], NOT_ARRIVED[code]![lang], SENTENCES[code]![lang]]);
			});
		}
	}

	it('says the other codes the same whether or not a send to the target is unclear', async () => {
		const others = ['read_failed', 'path_changed', 'secret', 'conflict', 'sent_unknown'] as const;
		run = writeRun(others.flatMap((c, i) => [{ ...unread(2 * i, c), sendUnclear: false }, { ...unread(2 * i + 1, c), sendUnclear: true }]));
		await render();
		expect(errorTexts()).toEqual(others.flatMap((c) => [SENTENCES[c]!.de, SENTENCES[c]!.de]));
	});

	it('says the error of a target sent to and not recorded, under its diff', async () => {
		// The engine calls such a target written: the run may have changed it. Its error is its own.
		run = writeRun([{ ...field(0, 'sent_unknown'), written: true, applied: false, sendUnclear: true }, { ...field(1, 'write_failed'), written: true, applied: false, sendUnclear: false }]);
		await render();
		expect(errorTexts()).toEqual([SENTENCES['sent_unknown']!.de, NOT_ARRIVED['write_failed']!.de]);
	});

	it('says no error on a target recorded as applied, where a loop that lost its claim can have left one', async () => {
		run = writeRun([{ ...field(0, 'conflict'), written: true, applied: true }, { ...field(1, 'write_failed'), written: true, applied: true, sendUnclear: false }, { ...field(2, 'write_failed'), applied: false }]);
		await render();
		expect(errorTexts()).toEqual([SENTENCES['write_failed']!.de]);
		expect(shown()).not.toContain(SENTENCES['conflict']!.de);
	});

	it('says the error of a target from an engine that does not say whether it was applied, as possibly arrived', async () => {
		run = writeRun([{ ...field(0, 'write_failed'), written: true }, { ...unread(1, 'redirect') }]);
		await render();
		expect(errorTexts()).toEqual([SENTENCES['write_failed']!.de, SENTENCES['redirect']!.de]);
	});

	it('shows a target left out at planning by its reason, not by this sentence', async () => {
		run = planningRun([{ ...unread(0, 'read_failed'), change: 'invalid' }]);
		await render();
		expect(errorTexts()).toEqual([]);
		expect(shown()).toContain(t('bulk.invalid.read_failed'));
	});
});
