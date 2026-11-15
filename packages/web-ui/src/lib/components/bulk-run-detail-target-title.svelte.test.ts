import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { resetSettingsViewer } from '../stores/settings-viewer.svelte.js';
import type { BulkRunDetailData, BulkTarget } from './bulk-runs.js';

// A Shopify product target is named by the title the store answered the preview's read with,
// set as text, with the link into the admin below it. Without a title the link stands alone.

const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element; props?: Record<string, unknown> }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

const HOST = 'demo.myshopify.com';

function makeRun(o: Partial<BulkRunDetailData> = {}): BulkRunDetailData {
	return {
		id: 'r1', createdAt: '2026-11-15T07:50:00Z', targetSystem: `http:${HOST}`, phase: 'previewed', total: 2,
		changes: { update: 2, create: 0, delete: 0, unchanged: 0, invalid: 0 }, applied: 0, failed: 0, conflicts: 0, sentUnknown: 0, undone: 0,
		kind: 'apply', atomic: false, sourceRunId: null, writeMethod: null, probeConfirmed: false, writeForm: 'measured', haltReason: null, haltKey: null,
		costUsd: 0, costCapUsd: null, judge: null, maxTargets: 2, failedOnce: 0, failureLimit: 0, resumeOpen: 0, resumeTries: 0, resumeSends: 0, deselected: 0,
		checksum: 'c1', writeFormNote: null, writeFormConfirmation: null, judgeModel: null, resumesAt: null, probe: null, undoable: 0,
		listFirstPage: null, listStartChecksum: null, listNote: null, listFilters: null, judgeRule: null, judgeRuleHash: null, judgeServedBy: null, judgeOwnKey: false,
		undoneBy: null,
		...o,
	};
}
const seo = (n: number, title?: string): BulkTarget => ({
	seq: n, key: `gid://shopify/Product/${String(n)}`, change: 'update',
	diff: { kind: 'fields', fields: [{ field: 'seo_title', before: null, after: `Neu ${String(n)}` }] },
	error: null, deselected: false, ...(title === undefined ? {} : { title }),
}) as BulkTarget;

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let targets: BulkTarget[];

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	resetSettingsViewer();
	targets = [];
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const u = String(url);
		const reply = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
		if (u.endsWith('/config')) return reply({ managed: true, viewer: 'owner' });
		const page = /\/targets\?offset=(\d+)&limit=(\d+)$/.exec(u);
		if (page) return reply({ targets: targets.slice(Number(page[1]), Number(page[1]) + Number(page[2])) });
		return reply(makeRun());
	}));
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
});

async function render(): Promise<void> {
	const { default: BulkRunDetail } = await import('./BulkRunDetail.svelte');
	component = mount(BulkRunDetail, { target, props: { runId: 'r1', onBack: () => {}, onOpen: () => {} } });
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

const titles = (): string[] => [...target.querySelectorAll('[data-testid="bulk-target-title"]')].map((e) => e.textContent ?? '');
const links = (): HTMLAnchorElement[] => [...target.querySelectorAll<HTMLAnchorElement>('[data-testid="bulk-target-admin"]')];

describe('a product target in the preview', () => {
	it('is named by its title, with the admin link below it', async () => {
		targets = [seo(1, 'Bio-Tee Rooibos'), seo(2, 'Grüntee Sencha')];
		await render();
		expect(titles()).toEqual(['Bio-Tee Rooibos', 'Grüntee Sencha']);
		expect(links().map((a) => a.textContent)).toEqual(['Produkt 1↗', 'Produkt 2↗']);
		expect(links()[0]!.getAttribute('href')).toBe(`https://${HOST}/admin/products/1`);
		const title = target.querySelector('[data-testid="bulk-target-title"]')!;
		expect(title.compareDocumentPosition(links()[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it('shows a title holding markup as text, never as an element', async () => {
		targets = [seo(1, '<b>Fett</b><img src=x onerror="alert(1)">'), seo(2, 'Grüntee Sencha')];
		await render();
		expect(titles()).toEqual(['<b>Fett</b><img src=x onerror="alert(1)">', 'Grüntee Sencha']);
		const cell = target.querySelector('[data-testid="bulk-target-title"]')!;
		expect(cell.querySelector('b, img')).toBeNull();
	});

	it('without a title, is named by its link alone, as before', async () => {
		targets = [seo(1), seo(2, '')];
		await render();
		expect(titles()).toEqual([]);
		expect(links().map((a) => a.textContent)).toEqual(['Produkt 1↗', 'Produkt 2↗']);
	});
});
