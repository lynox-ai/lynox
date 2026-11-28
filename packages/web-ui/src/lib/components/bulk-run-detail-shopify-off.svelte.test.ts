import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t, getLocale, setLocale } from '../i18n.svelte.js';
import { resetSettingsViewer } from '../stores/settings-viewer.svelte.js';
import type { BulkRunDetailData, BulkTarget } from './bulk-runs.js';

// While this instance has Shopify bulk changes off, the engine refuses to approve or to resume a
// Shopify run with `shopify_off`. The page words that refusal in its own sentence, not in the
// engine's English. On a run halted on the switch the way to turn it on already stands above; on a
// run refused its approval it follows the refusal, as the halt words it for the instance's kind.

const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element; props?: Record<string, unknown> }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

const ENGINE = 'Bulk runs on a Shopify store are switched off on this instance, so this run cannot be approved or resumed.';

function makeRun(o: Partial<BulkRunDetailData> = {}): BulkRunDetailData {
	return {
		id: 'r1', createdAt: '2026-11-28T08:00:00Z', targetSystem: 'http:demo.myshopify.com', phase: 'previewed', total: 1,
		changes: { update: 1, create: 0, delete: 0, unchanged: 0, invalid: 0 }, applied: 0, failed: 0, conflicts: 0, sentUnknown: 0, undone: 0,
		kind: 'apply', atomic: false, sourceRunId: null, writeMethod: null, probeConfirmed: false, writeForm: 'measured', haltReason: null, haltKey: null,
		costUsd: 0, costCapUsd: null, judge: null, maxTargets: null, failedOnce: null, failureLimit: 0, resumeOpen: 0, resumeTries: 0, resumeSends: 0, deselected: 0,
		checksum: 'c1', writeFormNote: null, writeFormConfirmation: null, judgeModel: null, resumesAt: null, probe: null, undoable: 0,
		listFirstPage: null, listStartChecksum: null, listNote: null, listFilters: null, judgeRule: null, judgeRuleHash: null, judgeServedBy: null, judgeOwnKey: false,
		undoneBy: null,
		...o,
	};
}
/** A write run halted on the switch with a send left unclear: it goes on by checking. */
const haltedOnSwitch = (): BulkRunDetailData => makeRun({
	phase: 'writing', total: 3, changes: { update: 3, create: 0, delete: 0, unchanged: 0, invalid: 0 }, haltKey: 'shopifyWriteOff', haltReason: 'shopifyWriteOff',
	maxTargets: 1, failedOnce: 0, sentUnknown: 1, resumeOpen: 3, resumeTries: 1,
});
const TARGET: BulkTarget = {
	seq: 1, key: 'gid://shopify/Product/1', change: 'update', error: null, deselected: false,
	diff: { kind: 'fields', fields: [{ field: 'title', before: 'Alt', after: 'Neu' }] } as BulkTarget['diff'],
};

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let run: BulkRunDetailData;
let managed: boolean;
let posts: string[];
const locale = getLocale();

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	resetSettingsViewer();
	run = makeRun();
	managed = true;
	posts = [];
	vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
		const u = String(url);
		const reply = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
		if (init?.method === 'POST') {
			posts.push(u);
			if (u.endsWith('/approve') || u.endsWith('/resume')) return reply({ error: ENGINE, code: 'shopify_off' }, 409);
			return reply({});
		}
		if (u.endsWith('/config')) return reply({ managed, viewer: 'owner' });
		if (/\/targets\?offset=/.test(u)) return reply({ targets: run.phase === 'previewed' ? [TARGET] : [] });
		return reply(run);
	}));
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
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

async function render(): Promise<void> {
	const { default: BulkRunDetail } = await import('./BulkRunDetail.svelte');
	component = mount(BulkRunDetail, { target, props: { runId: 'r1', onBack: () => {}, onOpen: () => {} } });
	await settle();
}

async function press(label: string): Promise<void> {
	const button = [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
	expect(button, label).toBeDefined();
	button!.click();
	await settle();
}

const errorLine = (): string | undefined => target.querySelector('[data-testid="bulk-action-error"]')?.textContent?.trim();

describe('a Shopify run refused while bulk changes are off', () => {
	for (const lang of ['de', 'en'] as const) {
		it(`words the refused check of a run halted on the switch in ${lang}, without the engine's English or the way again`, async () => {
			setLocale(lang);
			run = haltedOnSwitch();
			await render();
			await press(t('bulk.resume.check'));
			expect(posts).toEqual([expect.stringMatching(/\/bulk\/runs\/r1\/resume$/)]);
			expect(errorLine()).toBe(lang === 'de'
				? 'Bulk-Änderungen an Shopify-Shops sind auf dieser Instanz nicht freigeschaltet. Darum lässt sich der Lauf gerade nicht freigeben oder fortsetzen.'
				: 'Bulk changes to Shopify stores are not enabled on this instance, so the run cannot be approved or continued right now.');
			expect(target.textContent).not.toContain(ENGINE);
		});

		it(`words the refused approval of a planned run in ${lang}, followed by the way to turn the changes on`, async () => {
			setLocale(lang);
			await render();
			await press(t('bulk.approve.write_only'));
			expect(posts).toEqual([expect.stringMatching(/\/bulk\/runs\/r1\/approve$/)]);
			expect(errorLine()).toBe(`${t('bulk.resume.refused.shopify_off')} ${t('bulk.halt.shopifyWriteOff_before_managed')}`);
			expect(target.textContent).not.toContain(ENGINE);
		});
	}

	it('names the configuration as the way on a self-hosted instance', async () => {
		managed = false;
		await render();
		await press(t('bulk.approve.write_only'));
		expect(errorLine()).toBe(`${t('bulk.resume.refused.shopify_off')} ${t('bulk.halt.shopifyWriteOff_before_selfhost')}`);
	});
});
