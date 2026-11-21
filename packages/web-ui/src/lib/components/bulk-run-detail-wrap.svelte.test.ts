import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getLocale, setLocale } from '../i18n.svelte.js';
import type { BulkRunDetailData } from './bulk-runs.js';

// A store handle can be longer than a phone's line. The run page puts every word of the heading, the
// target and the halt line's host in its own box (WrapParts), so a word wider than the line breaks
// inside instead of pushing the page sideways. jsdom does not lay out, so this pins the boxes the
// page renders, not where a line breaks.

const HOST = 'bergschuh-outlet-schweiz-sommer-kollektion-24.myshopify.com';
const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element; props?: Record<string, unknown> }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

// A write run that halted because the store access ended; it names the store in its heading, its
// target and its halt line.
function haltedRun(): BulkRunDetailData {
	return {
		id: 'r1', createdAt: '2026-11-12T07:50:00Z', targetSystem: `http:${HOST}`, phase: 'writing', total: 2,
		changes: { update: 2, create: 0, delete: 0, unchanged: 0, invalid: 0 }, applied: 2, failed: 0, conflicts: 0, sentUnknown: 0, undone: 2,
		kind: 'apply', atomic: false, sourceRunId: null, writeMethod: null, probeConfirmed: true, writeForm: 'unmeasured', haltReason: 'storeAccessEnded', haltKey: 'storeAccessEnded',
		costUsd: 0, costCapUsd: null, judge: null, maxTargets: 2, failedOnce: 0, failureLimit: 0, resumeOpen: 0, resumeTries: 0, resumeSends: 0, deselected: 0,
		checksum: null, writeFormNote: null, writeFormConfirmation: null, judgeModel: null, resumesAt: null, probe: null, undoable: 0,
		listFirstPage: null, listStartChecksum: null, listNote: null, listFilters: null, judgeRule: null, judgeRuleHash: null, judgeServedBy: null, judgeOwnKey: false,
		undoneBy: null,
	};
}

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let run: BulkRunDetailData;

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	run = haltedRun();
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

const boxes = (el: Element | null | undefined): string[] =>
	[...(el?.querySelectorAll('span.inline-block.max-w-full.break-all') ?? [])].map((s) => s.textContent ?? '');

describe('the run page with a store handle longer than a line', () => {
	it('puts each word of the heading, the target and the halt line\'s host in its own breakable box', async () => {
		const before = getLocale();
		onTestFinished(() => setLocale(before));
		setLocale('en');
		await render();
		expect(boxes(target.querySelector('[data-testid="bulk-heading"]'))).toEqual(['2', 'targets', '·', 'bergschuh-outlet-schweiz-sommer-kollektion-24.', 'myshopify.', 'com']);
		const dds = [...target.querySelectorAll('dd')].filter((d) => d.textContent?.includes(HOST));
		expect(dds).toHaveLength(2);
		expect(boxes(dds[0])).toEqual(['bergschuh-outlet-schweiz-sommer-kollektion-24.', 'myshopify.', 'com']);
		// In the halt line the sentence's period goes into the host's last box, so it never starts a line alone.
		expect(boxes(dds[1])).toEqual(['bergschuh-outlet-schweiz-sommer-kollektion-24.', 'myshopify.', 'com.']);
	});
});
