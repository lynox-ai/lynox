import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t, getLocale, setLocale } from '../i18n.svelte.js';
import type { BulkRunDetailData, BulkTarget } from './bulk-runs.js';

// A start check that refuses approving on a store's cause no wait and no retry clears: the page
// takes the approval away for that run (a preview's or an undo's) and says the cause under it,
// where the focus goes. A cause that can clear keeps
// the approval and says the cause as the act's error.

const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element; props?: Record<string, unknown> }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

const RUN: BulkRunDetailData = {
	id: 'r1', createdAt: '2026-11-24T00:00:00Z', targetSystem: 'http:demo.myshopify.com', phase: 'previewed', total: 2,
	changes: { update: 2, create: 0, delete: 0, unchanged: 0, invalid: 0 }, applied: 0, failed: 0, conflicts: 0, sentUnknown: 0, undone: 0,
	kind: 'apply', atomic: false, sourceRunId: null, writeMethod: null, probeConfirmed: false, writeForm: 'measured', haltReason: null, haltKey: null,
	costUsd: 0, costCapUsd: null, judge: null, maxTargets: null, failedOnce: null, failureLimit: 0, resumeOpen: 0, resumeTries: 0, resumeSends: 0, deselected: 0,
	checksum: 'c1', writeFormNote: null, writeFormConfirmation: null, judgeModel: null, resumesAt: null, probe: null, undoable: 0,
	listFirstPage: null, listStartChecksum: null, listNote: null, listFilters: null, judgeRule: null, judgeRuleHash: null, judgeServedBy: null, judgeOwnKey: false,
};
const TARGETS: BulkTarget[] = [1, 2].map((seq) => ({
	seq, key: `gid://shopify/Product/${seq}`, change: 'update', error: null, deselected: false,
	diff: { kind: 'fields', fields: [{ field: 'title', before: 'Alt', after: 'Neu' }] } as BulkTarget['diff'],
}));

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
/** The code the approve route refuses with. */
let refuseWith: string;
let approvals: number;
let runGets: number;
/** The run the page is given. */
let shown: BulkRunDetailData;
/** Answers held back until the test lets them through: the approval, and run r2's own answer. */
let holdApprove: Promise<void> | null;
let holdR2: Promise<void> | null;

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	approvals = 0;
	runGets = 0;
	shown = RUN;
	holdApprove = null;
	holdR2 = null;
	vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
		const u = String(url);
		const reply = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
		if (init?.method === 'POST') {
			if (u.endsWith('/approve')) { approvals++; if (holdApprove !== null) await holdApprove; return reply({ error: 'engine English', code: refuseWith }, 409); }
			return reply({});
		}
		if (u.endsWith('/config')) return reply({ managed: true, viewer: 'owner' });
		const page = /\/targets\?offset=(\d+)&limit=(\d+)$/.exec(u);
		if (page) return reply({ targets: TARGETS.slice(Number(page[1]), Number(page[1]) + Number(page[2])) });
		if (/\/bulk\/runs\/r1$/.test(u)) runGets++;
		if (/\/bulk\/runs\/r2$/.test(u)) { if (holdR2 !== null) await holdR2; return reply({ ...shown, id: 'r2' }); }
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

const approveButton = (): HTMLButtonElement =>
	[...target.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === t('bulk.approve.write_one'))!;
const errorLines = (): string[] => [...target.querySelectorAll('p.text-danger')].map((p) => p.textContent?.trim() ?? '');

describe('the approval after a start check that can never pass', () => {
	for (const cause of ['shopifySelfHosted', 'shopifyNoApiVersion'] as const) {
		it(`goes off for ${cause}, says the cause once under it, and sends no second approval`, async () => {
			refuseWith = `reach_approve_${cause}`;
			await render();
			expect(approveButton().disabled).toBe(false);
			const loadsBefore = runGets;
			approveButton().click();
			await settle();
			expect(approvals).toBe(1);
			expect(approveButton().disabled).toBe(true);
			const reason = target.querySelector('[data-testid="bulk-approve-hopeless"]');
			expect(reason?.textContent?.trim()).toBe(t(`bulk.reach.approve.${cause}`));
			expect(approveButton().getAttribute('aria-describedby')).toBe(reason?.id);
			// The pressed button went off under the focus: the focus is on the cause.
			expect(document.activeElement).toBe(reason);
			// Said once, under the approval, not a second time as the act's error line.
			expect(errorLines()).toEqual([t(`bulk.reach.approve.${cause}`)]);
			// A refusal is not a change: the run is not loaded again.
			expect(runGets).toBe(loadsBefore);
			approveButton().click();
			await settle();
			expect(approvals).toBe(1);
		});
	}

	it('stays on for a cause that can clear, and says it as the act\'s error', async () => {
		refuseWith = 'reach_approve_shopifyUnconfirmed';
		await render();
		approveButton().click();
		await settle();
		expect(approveButton().disabled).toBe(false);
		expect(target.querySelector('[data-testid="bulk-approve-hopeless"]')).toBeNull();
		expect(errorLines()).toEqual([t('bulk.reach.approve.shopifyUnconfirmed')]);
		approveButton().click();
		await settle();
		expect(approvals).toBe(2);
	});

	it('goes off for an undo\'s approval too, with its cause under it', async () => {
		shown = { ...RUN, kind: 'undo', sourceRunId: 'src1', probeConfirmed: true };
		refuseWith = 'reach_approve_shopifyNoApiVersion';
		await render();
		const undo = (): HTMLButtonElement => [...target.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === t('bulk.undo.approve'))!;
		expect(undo().disabled).toBe(false);
		undo().click();
		await settle();
		expect(undo().disabled).toBe(true);
		const reason = target.querySelector('[data-testid="bulk-approve-hopeless"]');
		expect(reason?.textContent?.trim()).toBe(t('bulk.reach.approve.shopifyNoApiVersion'));
		expect(undo().getAttribute('aria-describedby')).toBe(reason?.id);
		expect(document.activeElement).toBe(reason);
		expect(errorLines()).toEqual([t('bulk.reach.approve.shopifyNoApiVersion')]);
		undo().click();
		await settle();
		expect(approvals).toBe(1);
	});

	it('leaves a run the page moved away from as it is: no cause, no focus taken', async () => {
		refuseWith = 'reach_approve_shopifySelfHosted';
		let letApprove!: () => void;
		holdApprove = new Promise((r) => { letApprove = r; });
		let letR2!: () => void;
		holdR2 = new Promise((r) => { letR2 = r; });
		const props = $state({ runId: 'r1', onBack: () => {}, onOpen: () => {} });
		const { default: BulkRunDetail } = await import('./BulkRunDetail.svelte');
		component = mount(BulkRunDetail, { target, props });
		await settle();
		approveButton().click();
		await settle();
		// The owner opens another run while the approval is out; that run has not loaded yet.
		props.runId = 'r2';
		await settle();
		const before = document.activeElement;
		letApprove();
		await settle();
		expect(approvals).toBe(1);
		expect(target.querySelector('[data-testid="bulk-approve-hopeless"]')).toBeNull();
		expect(document.activeElement).toBe(before);
		letR2();
		await settle();
		expect(target.querySelector('[data-testid="bulk-approve-hopeless"]')).toBeNull();
	});

	it('offers the approval again once the page has shown another run and comes back', async () => {
		refuseWith = 'reach_approve_shopifySelfHosted';
		const props = $state({ runId: 'r1', onBack: () => {}, onOpen: () => {} });
		const { default: BulkRunDetail } = await import('./BulkRunDetail.svelte');
		component = mount(BulkRunDetail, { target, props });
		await settle();
		approveButton().click();
		await settle();
		expect(approveButton().disabled).toBe(true);
		props.runId = 'r2';
		await settle();
		props.runId = 'r1';
		await settle();
		// Opened again, the run is asked again: the route answers on the next press.
		expect(approveButton().disabled).toBe(false);
		expect(target.querySelector('[data-testid="bulk-approve-hopeless"]')).toBeNull();
	});

	it('offers the approval again after a load the owner set off', async () => {
		refuseWith = 'reach_approve_shopifyNoApiVersion';
		await render();
		approveButton().click();
		await settle();
		expect(approveButton().disabled).toBe(true);
		const loadsBefore = runGets;
		// Taking a target out goes through, but the run read after it does not show it: the page loads the run whole.
		[...target.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === t('bulk.deselect.off'))!.click();
		await settle();
		expect(runGets).toBeGreaterThan(loadsBefore + 1);
		expect(approveButton().disabled).toBe(false);
		expect(target.querySelector('[data-testid="bulk-approve-hopeless"]')).toBeNull();
		approveButton().click();
		await settle();
		expect(approvals).toBe(2);
	});

	it('says the cause in the page\'s language', async () => {
		const before = getLocale();
		setLocale('de');
		try {
			refuseWith = 'reach_approve_shopifySelfHosted';
			await render();
			approveButton().click();
			await settle();
			const reason = target.querySelector('[data-testid="bulk-approve-hopeless"]')?.textContent?.trim();
			expect(reason).toBe(t('bulk.reach.approve.shopifySelfHosted'));
			expect(reason).toMatch(/Instanz/);
		} finally {
			setLocale(before);
		}
	});
});
