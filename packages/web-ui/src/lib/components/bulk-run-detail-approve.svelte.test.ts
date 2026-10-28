import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t } from '../i18n.svelte.js';
import type { BulkRunDetailData, BulkTarget } from './bulk-runs.js';

// The approval of a preview: the owner sees every target, why lynox leaves one out, can take one
// out of the write, and cannot press an approval the engine would refuse for want of a target.

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

const fieldsDiff = (before: string, after: string): BulkTarget['diff'] =>
	({ kind: 'fields', fields: [{ field: 'title', before, after }] }) as BulkTarget['diff'];

function makeRun(o: Partial<BulkRunDetailData> = {}): BulkRunDetailData {
	return {
		id: 'r1', createdAt: '2026-10-28T00:00:00Z', targetSystem: 'http:demo.myshopify.com', phase: 'previewed', total: 3,
		changes: { update: 1, create: 0, delete: 0, unchanged: 1, invalid: 1 }, applied: 0, failed: 0, conflicts: 0, sentUnknown: 0, undone: 0,
		kind: 'apply', atomic: false, sourceRunId: null, writeMethod: null, probeConfirmed: false, writeForm: 'measured', haltReason: null, haltKey: null,
		costUsd: 0, costCapUsd: null, judge: null, maxTargets: null, failedOnce: null, failureLimit: 0, resumeOpen: 0, resumeTries: 0, deselected: 0,
		checksum: 'c1', writeFormNote: null, writeFormConfirmation: null, judgeModel: null, resumesAt: null, probe: null, undoable: 0,
		listFirstPage: null, listStartChecksum: null, listNote: null, judgeRule: null, judgeRuleHash: null, judgeServedBy: null, judgeOwnKey: false,
		...o,
	};
}
const TARGETS: BulkTarget[] = [
	{ seq: 1, key: 'gid://shopify/Product/1', change: 'update', diff: fieldsDiff('Alt', 'Neu'), error: null, deselected: false },
	{ seq: 2, key: 'gid://shopify/Product/2', change: 'unchanged', diff: { kind: 'none' } as BulkTarget['diff'], error: null, deselected: false },
	{ seq: 3, key: 'gid://shopify/Product/3', change: 'invalid', diff: { kind: 'none' } as BulkTarget['diff'], error: 'not_found', deselected: false },
];

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let run: BulkRunDetailData;
let targets: BulkTarget[];
let posts: { url: string; body: unknown }[];
let gets: string[];
let refuseDeselect: string | null;

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	run = makeRun();
	targets = TARGETS.map((x) => ({ ...x }));
	posts = [];
	gets = [];
	refuseDeselect = null;
	vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
		const u = String(url);
		const reply = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
		if (init?.method === 'POST') {
			const body = JSON.parse(String(init.body)) as unknown;
			posts.push({ url: u, body });
			const m = /\/targets\/(\d+)\/deselect$/.exec(u);
			if (m && refuseDeselect !== null) return reply({ error: 'engine English', code: refuseDeselect }, 409);
			if (m) {
				const seq = Number(m[1]);
				targets = targets.map((x) => (x.seq === seq ? { ...x, deselected: true } : x));
				run = { ...run, checksum: 'c2', deselected: run.deselected + 1, changes: { ...run.changes, update: run.changes.update - 1 } };
				return reply({ checksum: 'c2' });
			}
			return reply({});
		}
		gets.push(u);
		if (u.endsWith('/config')) return reply({ managed: true });
		const page = /\/targets\?offset=(\d+)&limit=(\d+)$/.exec(u);
		if (page) return reply({ targets: targets.slice(Number(page[1]), Number(page[1]) + Number(page[2])) });
		return reply(run);
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

const buttonByText = (text: string): HTMLButtonElement | undefined =>
	[...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);

describe('approving a preview', () => {
	it('shows why lynox leaves a product out, and folds the unchanged one until asked', async () => {
		await render();
		expect(target.textContent).toContain(t('bulk.invalid.not_found'));
		expect(target.textContent).toContain('Product/1');
		expect(target.textContent).not.toContain('Product/2');
		buttonByText(t('bulk.preview.show_unchanged').replace('{n}', '1'))!.click();
		await settle();
		expect(target.textContent).toContain('Product/2');
	});

	it('takes a product out against the checksum it showed, and then shuts an approval with nothing left', async () => {
		await render();
		const approve = buttonByText(t('bulk.approve.write_one'))!;
		expect(approve.disabled).toBe(false);
		buttonByText(t('bulk.deselect.off'))!.click();
		await settle();
		expect(posts).toEqual([{ url: expect.stringMatching(/\/bulk\/runs\/r1\/targets\/1\/deselect$/) as unknown as string, body: { checksum: 'c1' } }]);
		expect(target.textContent).toContain(t('bulk.deselect.taken_out'));
		expect(buttonByText(t('bulk.deselect.on'))).toBeDefined();
		const shut = buttonByText(t('bulk.approve.write_one'))!;
		expect(shut.disabled).toBe(true);
		expect(shut.getAttribute('aria-describedby')).toBe('bulk-approve-nothing');
		expect(target.querySelector('#bulk-approve-nothing')?.textContent).toBe(t('bulk.nothing.products'));
	});

	it('offers no way out on a product lynox leaves out, and none on an unchanged one', async () => {
		await render();
		buttonByText(t('bulk.preview.show_unchanged').replace('{n}', '1'))!.click();
		await settle();
		expect([...target.querySelectorAll('button')].filter((b) => b.textContent?.trim() === t('bulk.deselect.off'))).toHaveLength(1);
	});

	it('loads every target of a preview before it offers the approval, page by page', async () => {
		targets = Array.from({ length: 501 }, (_, i) => ({ ...TARGETS[0]!, seq: i + 1, key: `gid://shopify/Product/${i + 1}` }));
		run = makeRun({ total: 501, changes: { update: 501, create: 0, delete: 0, unchanged: 0, invalid: 0 } });
		await render();
		expect(gets.filter((u) => u.includes('/targets?'))).toEqual([
			expect.stringMatching(/offset=0&limit=500$/), expect.stringMatching(/offset=500&limit=500$/),
		]);
		expect(target.textContent).toContain('Product/501');
	});

	it('offers no approval when the pages list fewer targets than the run counts (L1)', async () => {
		run = makeRun({ total: 4 });
		await render();
		expect(target.textContent).toContain(t('common.load_failed'));
		expect(buttonByText(t('bulk.approve.write_one'))).toBeUndefined();
		expect(target.textContent).not.toContain('Product/1');
	});

	it('words a refused take-out by its code, not by the engine\'s English (U-040)', async () => {
		refuseDeselect = 'not_writing';
		await render();
		buttonByText(t('bulk.deselect.off'))!.click();
		await settle();
		expect(target.textContent).toContain(t('bulk.deselect.refused.not_writing'));
		expect(target.textContent).not.toContain('engine English');
	});

	it('shows the engine\'s text for a refusal it has no sentence for', async () => {
		refuseDeselect = 'something_else';
		await render();
		buttonByText(t('bulk.deselect.off'))!.click();
		await settle();
		expect(target.textContent).toContain('engine English');
	});
});
