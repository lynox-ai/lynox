import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t } from '../i18n.svelte.js';
import { resetSettingsViewer } from '../stores/settings-viewer.svelte.js';
import type { BulkRunDetailData, BulkTarget } from './bulk-runs.js';

// A write run that halted with a send left unclear goes on by checking, not by writing on. The
// page used to put the halt's "then you can continue" above the sentence about checking; now what
// the check needs too comes first and ends with checking, and anything else follows the check.

const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element; props?: Record<string, unknown> }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

const HOST = 'demo.myshopify.com';
const CHECK = `Nachprüfen liest bei ${HOST} nach, ob die Änderung da ist; geschickt wird dabei nichts.`;

function makeRun(o: Partial<BulkRunDetailData> = {}): BulkRunDetailData {
	return {
		id: 'r1', createdAt: '2026-11-14T07:50:00Z', targetSystem: `http:${HOST}`, phase: 'writing', total: 3,
		changes: { update: 3, create: 0, delete: 0, unchanged: 0, invalid: 0 }, applied: 0, failed: 0, conflicts: 0, sentUnknown: 1, undone: 0,
		kind: 'apply', atomic: false, sourceRunId: null, writeMethod: null, probeConfirmed: false, writeForm: 'measured', haltReason: 'unavailable', haltKey: 'unavailable',
		costUsd: 0, costCapUsd: null, judge: null, maxTargets: 1, failedOnce: 0, failureLimit: 0, resumeOpen: 3, resumeTries: 1, resumeSends: 0, deselected: 0,
		checksum: 'c1', writeFormNote: null, writeFormConfirmation: null, judgeModel: null, resumesAt: null, probe: null, undoable: 0,
		listFirstPage: null, listStartChecksum: null, listNote: null, listFilters: null, judgeRule: null, judgeRuleHash: null, judgeServedBy: null, judgeOwnKey: false,
		undoneBy: null,
		...o,
	};
}

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let run: BulkRunDetailData;
let managed: boolean;

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	resetSettingsViewer();
	run = makeRun();
	managed = true;
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const u = String(url);
		const reply = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
		if (u.endsWith('/config')) return reply({ managed, viewer: 'owner' });
		if (/\/targets\?offset=/.test(u)) return reply({ targets: [] as BulkTarget[] });
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

/** The way-on block's lines in page order, from the check button's block. */
function wayOn(): string[] {
	const button = [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === t('bulk.resume.check'));
	expect(button, 'the check button').toBeDefined();
	const block = button!.closest('.space-y-3')!;
	return [...block.querySelectorAll('p')].map((p) => p.textContent?.trim() ?? '');
}

describe('going on by checking', () => {
	it('(a) not reachable: says the check first, the hint about another halt after it, and nothing about continuing', async () => {
		await render();
		const lines = wayOn();
		const hint = `Hält das Nachprüfen gleich wieder an, ist ${HOST} noch nicht erreichbar; versuch es später noch einmal.`;
		expect(lines.indexOf(CHECK)).toBeGreaterThanOrEqual(0);
		expect(lines.indexOf(hint)).toBeGreaterThan(lines.indexOf(CHECK));
		expect(lines.join(' ')).not.toContain('fortsetzen');
	});

	it('(b) no access: says to reconnect first, ending with checking, then the check', async () => {
		run = makeRun({ haltKey: 'unauthorized', haltReason: 'unauthorized' });
		await render();
		const lines = wayOn();
		const reconnect = `Öffne Einstellungen → API-Verbindungen und tippe bei der Verbindung für ${HOST} auf das Chat-Symbol, um den Zugang neu zu verbinden. Danach kannst du nachprüfen.`;
		expect(lines.indexOf(reconnect)).toBeGreaterThanOrEqual(0);
		expect(lines.indexOf(CHECK)).toBeGreaterThan(lines.indexOf(reconnect));
	});

	it('(c) a blocked host: says to ask support first, with the link under it, then the check', async () => {
		run = makeRun({ haltKey: 'blocked', haltReason: 'blocked' });
		await render();
		const lines = wayOn();
		const ask = `Soll lynox ${HOST} erreichen, schreib an support@lynox.ai. Danach kannst du nachprüfen.`;
		const mail = t('bulk.halt.support_mail');
		expect(lines.indexOf(ask)).toBeGreaterThanOrEqual(0);
		expect(lines.indexOf(mail)).toBe(lines.indexOf(ask) + 1);
		expect(lines.indexOf(CHECK)).toBeGreaterThan(lines.indexOf(mail));
	});

	it('writing switched off: says to ask support first, with the link under it, then the check', async () => {
		run = makeRun({ haltKey: 'shopifyWriteOff', haltReason: 'shopifyWriteOff' });
		await render();
		const lines = wayOn();
		const ask = 'Soll lynox in Shopify-Shops nachprüfen und schreiben, schreib an support@lynox.ai. Sobald Bulk-Änderungen freigeschaltet sind, kannst du nachprüfen.';
		expect(lines.indexOf(ask)).toBeGreaterThanOrEqual(0);
		expect(lines.indexOf(CHECK)).toBeGreaterThanOrEqual(0);
		expect(lines.indexOf(t('bulk.halt.support_mail'))).toBe(lines.indexOf(ask) + 1);
		expect(lines.indexOf(CHECK)).toBeGreaterThan(lines.indexOf(t('bulk.halt.support_mail')));
		expect(lines.filter((l) => l === t('bulk.halt.support_mail'))).toHaveLength(1);
	});

	it('writing switched off, self-hosted: says to enable it in the configuration first, then the check, with no support link', async () => {
		managed = false;
		run = makeRun({ haltKey: 'shopifyWriteOff', haltReason: 'shopifyWriteOff' });
		await render();
		const lines = wayOn();
		const enable = t('bulk.halt.shopifyWriteOff_before_check_selfhost');
		expect(lines.indexOf(enable)).toBeGreaterThanOrEqual(0);
		expect(lines.indexOf(CHECK)).toBeGreaterThan(lines.indexOf(enable));
		expect(lines).not.toContain(t('bulk.halt.support_mail'));
	});

	it('writing switched off: the halt says nothing about continuing, managed and self-hosted', async () => {
		for (const tier of [true, false]) {
			managed = tier;
			run = makeRun({ haltKey: 'shopifyWriteOff', haltReason: 'shopifyWriteOff' });
			await render();
			expect(target.textContent, String(tier)).toContain('Bulk-Änderungen an Shopify-Shops sind auf dieser Instanz nicht freigeschaltet. Der Lauf ist angehalten.');
			expect(target.textContent, String(tier)).not.toContain('fortsetzen');
			if (component) unmount(component);
			component = undefined;
			target.innerHTML = '';
		}
	});
});
