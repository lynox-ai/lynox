import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t, getLocale, setLocale } from '../i18n.svelte.js';
import type { BulkRunDetailData, BulkTarget } from './bulk-runs.js';

// The same start check on writing on: a store's cause no wait and no retry clears takes writing on
// away for that run (a halt's, and the probe's confirm-and-write), with the cause under the button
// and the focus on it. A cause that can clear keeps the button and says the cause as the act's error.

const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element; props?: Record<string, unknown> }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

// Halted while writing, on a failure writing on moves past: one target written, one left.
const RUN: BulkRunDetailData = {
	id: 'r1', createdAt: '2026-11-24T00:00:00Z', targetSystem: 'http:demo.myshopify.com', phase: 'writing', total: 2,
	changes: { update: 2, create: 0, delete: 0, unchanged: 0, invalid: 0 }, applied: 1, failed: 0, conflicts: 0, sentUnknown: 0, undone: 0,
	kind: 'apply', atomic: false, sourceRunId: null, writeMethod: null, probeConfirmed: true, writeForm: 'measured', haltReason: 'engine English', haltKey: 'unavailable',
	costUsd: 0, costCapUsd: null, judge: null, maxTargets: 2, failedOnce: null, failureLimit: 0, resumeOpen: 1, resumeTries: 1, resumeSends: 1, deselected: 0,
	checksum: 'c1', writeFormNote: null, writeFormConfirmation: null, judgeModel: null, resumesAt: null, probe: null, undoable: 0,
	listFirstPage: null, listStartChecksum: null, listNote: null, listFilters: null, judgeRule: null, judgeRuleHash: null, judgeServedBy: null, judgeOwnKey: false,
};
const TARGETS: BulkTarget[] = [1, 2].map((seq) => ({
	seq, key: `gid://shopify/Product/${seq}`, change: 'update', error: null, deselected: false,
	diff: { kind: 'fields', fields: [{ field: 'title', before: 'Alt', after: 'Neu' }] } as BulkTarget['diff'],
}));

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
/** The code the resume route refuses with. */
let refuseWith: string;
let resumes: number;
let confirms: number;
let runGets: number;
let shown: BulkRunDetailData;

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	resumes = 0;
	confirms = 0;
	runGets = 0;
	shown = RUN;
	vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
		const u = String(url);
		const reply = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
		if (init?.method === 'POST') {
			if (u.endsWith('/resume')) { resumes++; return reply({ error: 'engine English', code: refuseWith }, 409); }
			if (u.endsWith('/confirm-probe')) { confirms++; return reply({}); }
			return reply({});
		}
		if (u.endsWith('/config')) return reply({ managed: true, viewer: 'owner' });
		const page = /\/targets\?offset=(\d+)&limit=(\d+)/.exec(u);
		if (page) return reply({ targets: TARGETS.slice(Number(page[1]), Number(page[1]) + Number(page[2])) });
		if (/\/bulk\/runs\/r1$/.test(u)) runGets++;
		return reply(shown);
	}));
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
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

const button = (label: string): HTMLButtonElement =>
	[...target.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label)!;
const errorLines = (): string[] => [...target.querySelectorAll('p.text-danger')].map((p) => p.textContent?.trim() ?? '');
/** The sentences of the block that offers writing on. */
const blockLines = (b: HTMLButtonElement): string[] => [...b.closest('div.space-y-3')!.querySelectorAll('p')].map((p) => p.textContent?.trim() ?? '');

describe('writing on after a start check that can never pass', () => {
	for (const cause of ['shopifySelfHosted', 'shopifyNoApiVersion'] as const) {
		it(`goes off for ${cause} on a halted run, says the cause once before the buttons, and sends no second resume`, async () => {
			refuseWith = `reach_resume_${cause}`;
			await render();
			const writeOn = (): HTMLButtonElement => button(t('bulk.resume.write'));
			expect(writeOn().disabled).toBe(false);
			// Before the press the block says how writing on goes.
			const offered = blockLines(writeOn());
			expect(offered.length).toBeGreaterThan(1);
			const loadsBefore = runGets;
			writeOn().click();
			await settle();
			expect(resumes).toBe(1);
			expect(writeOn().disabled).toBe(true);
			const reason = target.querySelector('[data-testid="bulk-resume-hopeless"]');
			expect(reason?.textContent?.trim()).toBe(t(`bulk.halt.${cause}`));
			expect(writeOn().getAttribute('aria-describedby')).toBe(reason?.id);
			expect(document.activeElement).toBe(reason);
			expect(errorLines()).toEqual([t(`bulk.halt.${cause}`)]);
			// Nothing promises writing on any more: between the halt's cause and the buttons only the reason.
			expect(blockLines(writeOn())).toEqual([t(`bulk.halt.${cause}`)]);
			expect(reason!.compareDocumentPosition(writeOn()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
			expect(target.querySelector('[data-testid="bulk-halt-cause"]')).not.toBeNull();
			expect(runGets).toBe(loadsBefore);
			writeOn().click();
			await settle();
			expect(resumes).toBe(1);
		});
	}

	it('stays on for a cause that can clear, and says it as the act\'s error', async () => {
		refuseWith = 'reach_resume_shopifyUnconfirmed';
		await render();
		const writeOn = (): HTMLButtonElement => button(t('bulk.resume.write'));
		const offered = blockLines(writeOn());
		writeOn().click();
		await settle();
		expect(writeOn().disabled).toBe(false);
		// The way on stays as it was said.
		expect(blockLines(writeOn()).filter((l) => !errorLines().includes(l))).toEqual(offered);
		expect(writeOn().getAttribute('aria-describedby')).toBeNull();
		expect(target.querySelector('[data-testid="bulk-resume-hopeless"]')).toBeNull();
		expect(errorLines()).toEqual([t('bulk.halt.shopifyUnconfirmed')]);
		writeOn().click();
		await settle();
		expect(resumes).toBe(2);
	});

	it('goes off at the probe too: confirming writes on, and the cause stands under it', async () => {
		shown = { ...RUN, haltKey: 'probeRequired', probeConfirmed: false, maxTargets: null, probe: { key: 'gid://shopify/Product/1', fields: ['title'], found: true } };
		refuseWith = 'reach_resume_shopifyNoApiVersion';
		await render();
		const box = target.querySelector<HTMLInputElement>('input[type=checkbox]')!;
		box.click();
		await settle();
		const go = (): HTMLButtonElement => button(t('bulk.probe.continue'));
		expect(go().disabled).toBe(false);
		go().click();
		await settle();
		expect([confirms, resumes]).toEqual([1, 1]);
		expect(go().disabled).toBe(true);
		const reason = target.querySelector('[data-testid="bulk-probe-hopeless"]');
		expect(reason?.textContent?.trim()).toBe(t('bulk.halt.shopifyNoApiVersion'));
		expect(go().getAttribute('aria-describedby')).toBe(reason?.id);
		expect(document.activeElement).toBe(reason);
		expect(errorLines()).toEqual([t('bulk.halt.shopifyNoApiVersion')]);
	});

	it('control: a probe whose resume a cause that can clear refuses keeps its button', async () => {
		shown = { ...RUN, haltKey: 'probeRequired', probeConfirmed: false, maxTargets: null, probe: { key: 'gid://shopify/Product/1', fields: ['title'], found: true } };
		refuseWith = 'reach_resume_shopifyNotCleared';
		await render();
		target.querySelector<HTMLInputElement>('input[type=checkbox]')!.click();
		await settle();
		button(t('bulk.probe.continue')).click();
		await settle();
		expect(button(t('bulk.probe.continue')).disabled).toBe(false);
		expect(target.querySelector('[data-testid="bulk-probe-hopeless"]')).toBeNull();
		expect(errorLines()).toEqual([t('bulk.halt.shopifyNotCleared')]);
	});

	it('says the cause in the page\'s language', async () => {
		const before = getLocale();
		setLocale('de');
		try {
			refuseWith = 'reach_resume_shopifySelfHosted';
			await render();
			button(t('bulk.resume.write')).click();
			await settle();
			expect(target.querySelector('[data-testid="bulk-resume-hopeless"]')?.textContent?.trim())
				.toBe('Shopify-Shops erreicht lynox nur auf Instanzen, die lynox betreibt. Diese Instanz wird selbst betrieben, deshalb lässt sich der Lauf hier nicht fortsetzen.');
		} finally {
			setLocale(before);
		}
	});
});
