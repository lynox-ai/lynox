import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readable } from 'svelte/store';
import { t, tf, getLocale, setLocale } from '../i18n.svelte.js';
import { resetSettingsViewer } from '../stores/settings-viewer.svelte.js';
import type { BulkRunDetailData, BulkTarget } from './bulk-runs.js';

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
let viewer: 'owner' | 'mandate';
let locale: ReturnType<typeof getLocale>;

beforeEach(() => {
	locale = getLocale();
	setLocale('de');
	target = document.createElement('div');
	document.body.appendChild(target);
	resetSettingsViewer();
	opened = [];
	viewer = 'owner';
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const u = String(url);
		const reply = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
		if (u.endsWith('/config')) return reply({ managed: true, viewer });
		// Every target of the run, the first one marked with its failure: a run halted on its
		// failures is loaded whole, and the step to check them stands only where one is marked.
		if (/\/targets\?/.test(u)) {
			return reply({ targets: Array.from({ length: run.total }, (_, seq): BulkTarget => ({
				seq, key: `https://demo.myshopify.com/products/${String(seq)}`, change: 'update', error: seq === 0 ? 'write_failed' : null, deselected: false,
				diff: seq === 0 ? { kind: 'none' } : { kind: 'fields', fields: [{ field: 'price', before: '12.00', after: '15' }] },
			})) });
		}
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

	it('says the undo window first and what may fail then right behind it, with the undo\'s word', async () => {
		const text = await render({ haltKey: 'failureRate', failureLimit: 0 });
		expect(text).toContain(`${t('bulk.resume.window_undo')} ${t('bulk.resume.allows_again_zero_undo')}`);
		expect(text).not.toContain(t('bulk.resume.allows_again_zero'));
		// The window sentence carries the verb; no failure sentence says it a second time, in either language.
		const undoAllows = ['allows_again', 'allows_again_few', 'allows_again_one', 'allows_again_zero', 'allows_only_consecutive', 'allows_no_failure_stop', 'allows_no_failure_stop_one'];
		for (const lang of ['de', 'en'] as const) {
			setLocale(lang);
			for (const k of undoAllows) expect(t(`bulk.resume.${k}_undo`), `${lang} ${k}_undo`).not.toMatch(/fortsetz|fortf|weiterschreib|continu|resum|go on|writing on/i);
		}
		setLocale('de');
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
	const sentence = (key: string): string => t(key).replace('{link}', t('bulk.resume.none_undo_link'));

	it('says to start it again from the page of the run it undoes, and links that page', async () => {
		await render({ haltKey: 'checksum' });
		expect(none()).toBe(sentence('bulk.resume.none_undo'));
		buttonByText(t('bulk.resume.none_undo_link'))!.click();
		expect(opened).toEqual(['src1']);
	});

	// The halt names its own step first (reconnect the store): starting again comes after it.
	it('says to start it again afterwards where its halt names a step of its own', async () => {
		await render({ haltKey: 'consentOutdated' });
		expect(none()).toBe(sentence('bulk.resume.none_undo_after'));
		buttonByText(t('bulk.resume.none_undo_link'))!.click();
		expect(opened).toEqual(['src1']);
	});

	it('says the same without a link where the undo names no run', async () => {
		await render({ haltKey: 'checksum', sourceRunId: null });
		expect(none()).toBe(sentence('bulk.resume.none_undo'));
		expect(buttonByText(t('bulk.resume.none_undo_link'))).toBeUndefined();
	});

	// U-232: a store's pass refused a request as it is formed. An undo has nothing to take out and
	// starts again from its run's page; a write takes it out and plans anew. Each says what stays.
	it('says, under the way on, what stays after a pass refused a request: taken back for an undo, written for a write', async () => {
		const kept = (): string | undefined => target.querySelector('[data-testid="bulk-resume-kept"]')?.textContent ?? undefined;
		await render({ haltKey: 'storeRequestRefused' });
		expect(none()).toBe(sentence('bulk.resume.none_undo'));
		expect(kept()).toBe(t('bulk.halt.storeRequestRefused_kept_undo'));
		expect(target.textContent).not.toContain(t('bulk.halt.storeRequestRefused_before'));
		unmount(component!);
		component = undefined;
		await render({ kind: 'apply', sourceRunId: null, haltKey: 'storeRequestRefused' });
		expect(none()).toBe(t('bulk.resume.none'));
		expect(kept()).toBe(t('bulk.halt.storeRequestRefused_kept'));
		expect(target.textContent).toContain(t('bulk.halt.storeRequestRefused_before'));
		unmount(component!);
		component = undefined;
		// Another halt no writing on gets past says nothing of what stays.
		await render({ kind: 'apply', sourceRunId: null, haltKey: 'contract' });
		expect(kept()).toBeUndefined();
	});

	it('control: a halted write still says to plan it again in a chat', async () => {
		await render({ kind: 'apply', sourceRunId: null, haltKey: 'consentOutdated' });
		expect(none()).toBe(t('bulk.resume.none'));
	});

	it('reads in English as approved', async () => {
		setLocale('en');
		await render({ haltKey: 'checksum' });
		expect(none()).toBe('Continuing would not help. Start the undo again from the page of the bulk run it undoes.');
		unmount(component!);
		component = undefined;
		await render({ haltKey: 'consentOutdated' });
		expect(none()).toBe('Continuing would not help. Start the undo again afterwards, from the page of the bulk run it undoes.');
		expect(tf('bulk.resume.window_undo', {})).toBe('By continuing you approve the undo again, as shown above.');
	});
});

// Every halt sentence an undo reaches that names the write has its undo words (U-335).
describe('a halted undo names its halt as taking back', () => {
	const vars = { provider: 'demo.myshopify.com', host: 'demo.myshopify.com' };
	const consent = { field: t('bulk.consent.field.seo_title'), path: `${t('nav.settings')} → ${t('settings.apis')}` };
	const undoCases: [string, Partial<BulkRunDetailData>, () => string, () => string][] = [
		['a target outside the grant', { haltKey: 'contract' }, () => tf('bulk.halt.contract_undo', vars), () => tf('bulk.halt.contract', vars)],
		['a log that could not record the run', { haltKey: 'runUnrecorded' }, () => tf('bulk.halt.runUnrecorded_undo', vars), () => tf('bulk.halt.runUnrecorded', vars)],
		['markup the store added', { haltKey: 'markupAddedByShop' }, () => tf('bulk.halt.markupAddedByShop_undo', vars), () => tf('bulk.halt.markupAddedByShop', vars)],
		['markup the store added, the step before', { haltKey: 'markupAddedByShop' }, () => tf('bulk.halt.markupAddedByShop_before_undo', vars), () => tf('bulk.halt.markupAddedByShop_before', vars)],
		['a connection that does not cover the field, nothing undone', { haltKey: 'consentOutdated', applied: 0, consentFields: ['seo_title'] }, () => tf('bulk.halt.consentOutdated_undo', consent), () => tf('bulk.halt.consentOutdated', consent)],
		['a connection that does not cover the field, some undone', { haltKey: 'consentOutdated', consentFields: ['seo_title'] }, () => tf('bulk.halt.consentOutdated_more_undo', consent), () => tf('bulk.halt.consentOutdated_more', consent)],
		['a discarded undo', { phase: 'aborted', haltKey: 'discarded' }, () => t('bulk.halt.discarded_undo'), () => t('bulk.halt.discarded')],
		['a request the store\'s pass refused', { haltKey: 'storeRequestRefused' }, () => t('bulk.halt.storeRequestRefused_undo'), () => t('bulk.halt.storeRequestRefused')],
	];
	for (const [name, o, undo, write] of undoCases) {
		it(`words ${name} in undo words, and a write in its own`, async () => {
			expect(await render(o)).toContain(undo());
			expect(target.textContent).not.toContain(write());
			unmount(component!);
			component = undefined;
			expect(await render({ ...o, kind: 'apply', sourceRunId: null })).toContain(write());
		});
	}

	it('tells a mandate the owner starts the undo again after reconnecting, and that the owner discarded it', async () => {
		viewer = 'mandate';
		expect(await render({ haltKey: 'consentOutdated', consentFields: ['seo_title'] })).toContain(tf('bulk.halt.consentOutdated_more_undo_mandate', consent));
		unmount(component!);
		component = undefined;
		expect(await render({ haltKey: 'consentOutdated', applied: 0, consentFields: ['seo_title'] })).toContain(tf('bulk.halt.consentOutdated_undo_mandate', consent));
		unmount(component!);
		component = undefined;
		expect(await render({ phase: 'aborted', haltKey: 'discarded' })).toContain(t('bulk.halt.discarded_undo_mandate'));
	});

	it('says an atomic undo that rolled back starts again from the page of the run it undoes, linked', async () => {
		const sentence = t('bulk.halt.atomicRolledBack_undo').replace('{link}', t('bulk.resume.none_undo_link'));
		const text = await render({ phase: 'aborted', haltKey: 'atomicRolledBack', atomic: true });
		expect(text).toContain(sentence);
		expect(text).not.toContain(t('bulk.halt.atomicRolledBack'));
		buttonByText(t('bulk.resume.none_undo_link'))!.click();
		expect(opened).toEqual(['src1']);
		unmount(component!);
		component = undefined;
		// Without a run to open, the same words stand, unlinked.
		expect(await render({ phase: 'aborted', haltKey: 'atomicRolledBack', atomic: true, sourceRunId: null })).toContain(sentence);
		expect(buttonByText(t('bulk.resume.none_undo_link'))).toBeUndefined();
	});

	it('says an atomic undo whose time ran out starts again later from the page of the run it undoes, linked, never from the chat', async () => {
		const sentence = t('bulk.halt.atomicTimeRolledBack_undo').replace('{link}', t('bulk.resume.none_undo_link'));
		const text = await render({ phase: 'aborted', haltKey: 'atomicTimeRolledBack', atomic: true });
		expect(text).toContain(sentence);
		expect(text).not.toContain(t('bulk.halt.atomicTimeRolledBack'));
		buttonByText(t('bulk.resume.none_undo_link'))!.click();
		expect(opened).toEqual(['src1']);
		unmount(component!);
		component = undefined;
		expect(await render({ phase: 'aborted', haltKey: 'atomicTimeRolledBack', atomic: true, sourceRunId: null })).toContain(sentence);
		expect(buttonByText(t('bulk.resume.none_undo_link'))).toBeUndefined();
	});
});

describe('an undo with a send left unclear', () => {
	const box = (): string => target.querySelector('[data-testid="bulk-sent-unknown"]')?.textContent ?? '';

	it('says to start the undo again from the page of the run it undoes, linked, never to plan it in a chat', async () => {
		await render({ phase: 'done', haltKey: null, haltReason: null, sentUnknown: 1 });
		const sentence = t('bulk.sent_unknown.one_undo').replace('{link}', t('bulk.resume.none_undo_link'));
		expect(box()).toBe(sentence);
		expect(box()).not.toMatch(/Chat/);
		[...target.querySelectorAll<HTMLButtonElement>('[data-testid="bulk-sent-unknown"] button')].find((b) => b.textContent === t('bulk.resume.none_undo_link'))!.click();
		expect(opened).toEqual(['src1']);
	});

	it('counts several unclear sends in the same words, on a halted undo too', async () => {
		await render({ sentUnknown: 3, haltKey: 'unavailable', haltReason: 'engine English' });
		expect(box()).toBe(tf('bulk.sent_unknown.many_undo', { count: '3', link: t('bulk.resume.none_undo_link') }));
		expect(box()).toContain('Bei 3 Zielen');
		expect(target.querySelector('[data-testid="bulk-sent-unknown"] button')?.textContent).toBe(t('bulk.resume.none_undo_link'));
	});

	it('says, while the undo still runs, only that the way on follows once it stops, with no link', async () => {
		await render({ phase: 'writing', haltKey: null, haltReason: null, sentUnknown: 1 });
		expect(box()).toBe(t('bulk.sent_unknown.one_undo_running'));
		expect(box()).not.toContain(t('bulk.resume.none_undo_link'));
		expect(target.querySelector('[data-testid="bulk-sent-unknown"] button')).toBeNull();
	});

	it('tells a mandate, while the undo still runs, the same as the owner, with no link', async () => {
		viewer = 'mandate';
		await render({ phase: 'writing', haltKey: null, haltReason: null, sentUnknown: 1 });
		// The page reads this session as a mandate's.
		expect(target.textContent).toContain(t('bulk.owner_only_notice'));
		expect(box()).toBe(t('bulk.sent_unknown.one_undo_running'));
		expect(target.querySelector('[data-testid="bulk-sent-unknown"] button')).toBeNull();
	});

	it('tells a mandate that only the owner starts the undo again, linked to the run it undoes', async () => {
		viewer = 'mandate';
		await render({ phase: 'done', haltKey: null, haltReason: null, sentUnknown: 1 });
		expect(box()).toBe(t('bulk.sent_unknown.one_undo_mandate').replace('{link}', t('bulk.resume.none_undo_link')));
		expect(box()).not.toContain('Starte die Rücknahme neu');
		[...target.querySelectorAll<HTMLButtonElement>('[data-testid="bulk-sent-unknown"] button')].find((b) => b.textContent === t('bulk.resume.none_undo_link'))!.click();
		expect(opened).toEqual(['src1']);
	});

	it('says the same without a link where the undo names no run', async () => {
		await render({ phase: 'done', haltKey: null, haltReason: null, sentUnknown: 1, sourceRunId: null });
		expect(box()).toBe(t('bulk.sent_unknown.one_undo').replace('{link}', t('bulk.resume.none_undo_link')));
		expect(target.querySelector('[data-testid="bulk-sent-unknown"] button')).toBeNull();
	});

	it('control: a write with a send left unclear still says to plan it again in a chat', async () => {
		await render({ kind: 'apply', sourceRunId: null, phase: 'done', haltKey: null, haltReason: null, sentUnknown: 1 });
		expect(box()).toBe(t('bulk.sent_unknown.one'));
		expect(target.querySelector('[data-testid="bulk-sent-unknown"] button')).toBeNull();
	});

	it('reads in English as approved', async () => {
		setLocale('en');
		await render({ phase: 'done', haltKey: null, haltReason: null, sentUnknown: 1 });
		expect(box()).toBe('For one target it is unclear whether the undo reached the provider. The send got no clear answer, and lynox does not send it again, or it could arrive twice. Start the undo again from the page of the bulk run it undoes: lynox then reads each target first and sends only where the run\'s change is still there.');
	});
});
