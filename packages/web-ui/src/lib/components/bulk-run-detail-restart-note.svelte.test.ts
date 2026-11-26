import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t } from '../i18n.svelte.js';
import type { BulkRunDetailData } from './bulk-runs.js';
import { BULK_HALT_REASONS } from '../../../../../src/core/bulk-ledger.js';

// A planned run that no restart moves on says what does help (U-232): plan it again as a rule,
// neither on a self-hosted instance, and nothing beside a missing setting of lynox's, whose own
// sentence says it already.

const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element; props?: Record<string, unknown> }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

function haltedRun(haltKey: keyof typeof BULK_HALT_REASONS): BulkRunDetailData {
	return {
		id: 'r1', createdAt: '2026-11-16T07:00:00Z', targetSystem: 'http:demo.myshopify.com', phase: 'planned', total: 3,
		changes: { update: 3, create: 0, delete: 0, unchanged: 0, invalid: 0 }, applied: 0, failed: 0, conflicts: 0, sentUnknown: 0, undone: 0,
		kind: 'apply', atomic: false, sourceRunId: null, writeMethod: null, probeConfirmed: false, writeForm: 'unmeasured', haltReason: BULK_HALT_REASONS[haltKey], haltKey,
		costUsd: 0, costCapUsd: null, judge: null, maxTargets: null, failedOnce: 0, failureLimit: 0, resumeOpen: 0, resumeTries: 0, resumeSends: 0, deselected: 0,
		checksum: null, writeFormNote: null, writeFormConfirmation: null, judgeModel: null, resumesAt: null, probe: null, undoable: 0,
		listFirstPage: null, listStartChecksum: null, listNote: null, listFilters: null, judgeRule: null, judgeRuleHash: null, judgeServedBy: null, judgeOwnKey: false,
		undoneBy: null,
	} as BulkRunDetailData;
}

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let run: BulkRunDetailData;

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
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

async function render(haltKey: keyof typeof BULK_HALT_REASONS): Promise<string | null> {
	run = haltedRun(haltKey);
	const { default: BulkRunDetail } = await import('./BulkRunDetail.svelte');
	component = mount(BulkRunDetail, { target, props: { runId: 'r1', onBack: () => {}, onOpen: () => {} } });
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
	return target.querySelector('[data-testid="bulk-restart-none"]')?.textContent ?? null;
}

describe('the note beside a run no restart moves on', () => {
	it('asks to plan again where that helps', async () => {
		expect(await render('contract')).toBe(t('bulk.restart.none'));
	});

	it('says neither helps on a self-hosted instance', async () => {
		expect(await render('shopifySelfHosted')).toBe(t('bulk.restart.none_self_hosted'));
		expect(target.querySelector('[data-testid="bulk-restart"]')).not.toBeNull();
	});

	it('says nothing beside a missing setting of lynox\'s', async () => {
		expect(await render('shopifyNoApiVersion')).toBeNull();
		// Nor the section with its rule over nothing (U-232).
		expect(target.querySelector('[data-testid="bulk-restart"]')).toBeNull();
		// The halt's own sentence stands: the page did render, only the note is left out.
		expect(target.textContent).toContain(t('bulk.halt.shopifyNoApiVersion'));
	});
});
