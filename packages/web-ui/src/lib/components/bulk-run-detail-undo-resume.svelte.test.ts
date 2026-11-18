import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readable } from 'svelte/store';
import { t, tf, getLocale, setLocale } from '../i18n.svelte.js';
import { resetSettingsViewer } from '../stores/settings-viewer.svelte.js';
import type { BulkRunDetailData } from './bulk-runs.js';

// A halted undo is continued in its own words: it takes targets back, so its page does not say
// that what is written stays, nor offer to write on (U-335). A halted write keeps its words.

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

/** A run halted while writing three targets, with every target left to try again. */
function makeRun(o: Partial<BulkRunDetailData> = {}): BulkRunDetailData {
	return {
		id: 'r1', createdAt: '2026-11-18T00:00:00Z', targetSystem: 'http:demo.myshopify.com', phase: 'writing', total: 3,
		changes: { update: 3, create: 0, delete: 0, unchanged: 0, invalid: 0 }, applied: 1, failed: 0, conflicts: 0, sentUnknown: 0, undone: 0,
		kind: 'undo', atomic: false, sourceRunId: 'src1', writeMethod: null, probeConfirmed: true, writeForm: 'measured',
		haltReason: 'engine English', haltKey: 'unavailable',
		costUsd: 0, costCapUsd: null, judge: null, maxTargets: 3, failedOnce: null, failureLimit: 0, resumeOpen: 2, resumeTries: 2, resumeSends: 0, deselected: 0,
		checksum: 'c1', writeFormNote: null, writeFormConfirmation: null, judgeModel: null, resumesAt: null, probe: null, undoable: 0,
		listFirstPage: null, listStartChecksum: null, listNote: null, listFilters: null, judgeRule: null, judgeRuleHash: null, judgeServedBy: null, judgeOwnKey: false,
		...o,
	};
}

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let run: BulkRunDetailData;
let opened: string[];
let locale: ReturnType<typeof getLocale>;

beforeEach(() => {
	locale = getLocale();
	setLocale('de');
	target = document.createElement('div');
	document.body.appendChild(target);
	resetSettingsViewer();
	opened = [];
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const u = String(url);
		const reply = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
		if (u.endsWith('/config')) return reply({ managed: true, viewer: 'owner' });
		if (/\/targets\?/.test(u)) return reply({ targets: [] });
		return reply(run);
	}));
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	resetSettingsViewer();
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

async function render(o: Partial<BulkRunDetailData>): Promise<string> {
	run = makeRun(o);
	const { default: BulkRunDetail } = await import('./BulkRunDetail.svelte');
	component = mount(BulkRunDetail, { target, props: { runId: 'r1', onBack: () => {}, onOpen: (id: string) => { opened.push(id); } } });
	await settle();
	return target.textContent ?? '';
}

const buttonByText = (text: string): HTMLButtonElement | undefined =>
	[...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);

describe('a halted undo continues in its own words', () => {
	it('says what is undone stays, offers to continue the undo, and never says written', async () => {
		const text = await render({});
		expect(text).toContain(t('bulk.resume.kept_undo'));
		expect(text).toContain(t('bulk.resume.window_undo'));
		expect(buttonByText(t('bulk.resume.write_undo'))).toBeDefined();
		expect(buttonByText(t('bulk.resume.write'))).toBeUndefined();
		expect(text).not.toContain(t('bulk.resume.kept_write'));
		expect(text).not.toContain(t('bulk.resume.window'));
	});

	it('says no target is confirmed as undone where none is, and names the maximum where one bounds it', async () => {
		expect(await render({ applied: 0 })).toContain(t('bulk.resume.kept_undo_none'));
		unmount(component!);
		component = undefined;
		expect(await render({ resumeTries: 1 })).toContain(t('bulk.resume.kept_undo_capped'));
		unmount(component!);
		component = undefined;
		expect(await render({ applied: 0, resumeTries: 1 })).toContain(t('bulk.resume.kept_undo_none_capped'));
	});

	it('says what continuing lets fail with "continuing"', async () => {
		const text = await render({ haltKey: 'failureRate', failureLimit: 0 });
		expect(text).toContain(t('bulk.resume.allows_again_zero_undo'));
		expect(text).not.toContain(t('bulk.resume.allows_again_zero'));
	});

	// One word on the whole page: the halt and the step before continuing say "undo" too.
	it('names the failures that halted it as targets not undone, and the step before as continuing the undo', async () => {
		const once = await render({ haltKey: 'failureRate', failureLimit: 0 });
		expect(once).toContain(t('bulk.halt.failureRate_undo0'));
		expect(once).toContain(t('bulk.halt.failures_before_undo'));
		expect(once).not.toContain(t('bulk.halt.failureRate_write0'));
		expect(once).not.toContain(t('bulk.halt.failures_before_write'));
		unmount(component!);
		component = undefined;
		expect(await render({ haltKey: 'failureRate', failureLimit: 2 })).toContain(tf('bulk.halt.failureRate_undo', { limit: '2' }));
		unmount(component!);
		component = undefined;
		expect(await render({ haltKey: 'consecutiveFailures', failureLimit: 2 })).toContain(t('bulk.halt.consecutiveFailures_undo'));
		unmount(component!);
		component = undefined;
		expect(await render({ haltKey: 'unrecorded' })).toContain(tf('bulk.halt.unrecorded_undo', { provider: 'demo.myshopify.com', host: 'demo.myshopify.com' }));
	});

	it('says an undo that has only conflicts left sends nothing and overwrites nothing', async () => {
		const text = await render({ haltKey: 'unavailable', conflicts: 2 });
		expect(text).toContain(tf('bulk.resume.nothing_left_undo', { provider: 'demo.myshopify.com' }));
		expect(text).not.toContain(tf('bulk.resume.nothing_left', { provider: 'demo.myshopify.com' }));
	});

	it('control: a halted write keeps the words of its halt and of nothing left', async () => {
		expect(await render({ kind: 'apply', sourceRunId: null, haltKey: 'failureRate', failureLimit: 0 })).toContain(t('bulk.halt.failures_before_write'));
		unmount(component!);
		component = undefined;
		expect(await render({ kind: 'apply', sourceRunId: null, haltKey: 'unavailable', conflicts: 2 })).toContain(tf('bulk.resume.nothing_left', { provider: 'demo.myshopify.com' }));
	});

	it('control: a halted write keeps the words of writing on', async () => {
		const text = await render({ kind: 'apply', sourceRunId: null });
		expect(text).toContain(t('bulk.resume.kept_write'));
		expect(text).toContain(t('bulk.resume.window'));
		expect(buttonByText(t('bulk.resume.write'))).toBeDefined();
		expect(text).not.toContain(t('bulk.resume.kept_undo'));
		expect(buttonByText(t('bulk.resume.write_undo'))).toBeUndefined();
	});
});

describe('a halted undo continuing would not help', () => {
	const none = (): string => target.querySelector('[data-testid="bulk-resume-none"]')!.textContent!;
	const sentence = (): string => t('bulk.resume.none_undo').replace('{link}', t('bulk.resume.none_undo_link'));

	it('says to start it again from the page of the run it undoes, and links that page', async () => {
		await render({ haltKey: 'consentOutdated' });
		expect(none()).toBe(sentence());
		buttonByText(t('bulk.resume.none_undo_link'))!.click();
		expect(opened).toEqual(['src1']);
	});

	it('says the same without a link where the undo names no run', async () => {
		await render({ haltKey: 'consentOutdated', sourceRunId: null });
		expect(none()).toBe(sentence());
		expect(buttonByText(t('bulk.resume.none_undo_link'))).toBeUndefined();
	});

	it('control: a halted write still says to plan it again in a chat', async () => {
		await render({ kind: 'apply', sourceRunId: null, haltKey: 'consentOutdated' });
		expect(none()).toBe(t('bulk.resume.none'));
	});

	it('reads in English as approved', async () => {
		setLocale('en');
		await render({ haltKey: 'consentOutdated' });
		expect(none()).toBe('Continuing would not help. Start the undo again from the page of the bulk run it undoes.');
		expect(tf('bulk.resume.window_undo', {})).toBe('By continuing you approve the undo again, as shown above.');
	});
});
