import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readable } from 'svelte/store';
import { getLocale, setLocale } from '../i18n.svelte.js';
import { resetSettingsViewer } from '../stores/settings-viewer.svelte.js';
import { bulkStep, type BulkRunDetailData } from './bulk-runs.js';

// The step chips mark the step a run stands at; the word over a halt says whether it can go on
// from there (U-342). An approved run that halted before it sent anything stands at its approval
// and is halted. An aborted run cannot go on: it stands where it was writing and reads
// „Abgebrochen“, or „Ersetzt“ where a newer run took its place. A run that ended before its
// approval marks no step: the page does not know whether it was ever previewed.

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

function makeRun(o: Partial<BulkRunDetailData> = {}): BulkRunDetailData {
	return {
		id: 'r1', createdAt: '2026-11-18T00:00:00Z', targetSystem: 'http:demo.myshopify.com', phase: 'approved', total: 3,
		changes: { update: 3, create: 0, delete: 0, unchanged: 0, invalid: 0 }, applied: 0, failed: 0, conflicts: 0, sentUnknown: 0, undone: 0,
		kind: 'apply', atomic: false, sourceRunId: null, writeMethod: null, probeConfirmed: true, writeForm: 'measured', haltReason: null, haltKey: null,
		costUsd: 0, costCapUsd: null, judge: null, maxTargets: null, failedOnce: null, failureLimit: 0, resumeOpen: 0, resumeTries: 0, resumeSends: 0, deselected: 0,
		checksum: 'c1', writeFormNote: null, writeFormConfirmation: null, judgeModel: null, resumesAt: null, probe: null, undoable: 0,
		listFirstPage: null, listStartChecksum: null, listNote: null, listFilters: null, judgeRule: null, judgeRuleHash: null, judgeServedBy: null, judgeOwnKey: false,
		...o,
	};
}

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let run: BulkRunDetailData;
let locale: ReturnType<typeof getLocale>;

beforeEach(() => {
	locale = getLocale();
	setLocale('de');
	target = document.createElement('div');
	document.body.appendChild(target);
	resetSettingsViewer();
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

/** The marked chip (null where none is marked) and the words in the head's left column. */
async function render(o: Partial<BulkRunDetailData>): Promise<{ chip: string | null; heads: string[] }> {
	run = makeRun(o);
	const { default: BulkRunDetail } = await import('./BulkRunDetail.svelte');
	component = mount(BulkRunDetail, { target, props: { runId: 'r1', onBack: () => {}, onOpen: () => {} } });
	await settle();
	const marked = [...target.querySelectorAll('li[aria-current="step"]')].map((li) => li.textContent?.trim() ?? '');
	expect(marked.length, 'at most one marked step').toBeLessThanOrEqual(1);
	return { chip: marked[0] ?? null, heads: [...target.querySelectorAll('dt')].map((d) => d.textContent?.trim() ?? '') };
}

const halted = { haltKey: 'unavailable', haltReason: 'engine English' };
const ROLLED_BACK = { phase: 'aborted' as const, atomic: true, haltKey: 'atomicRolledBack', haltReason: 'engine English' };

describe('the chip marks where a halted run stands', () => {
	it('an approved run that halted before it sent anything stands at its approval, halted', async () => {
		const { chip, heads } = await render(halted);
		expect(chip).toBe('Freigabe');
		expect(heads).toContain('Angehalten');
	});

	it('once it has written, it stands at its run', async () => {
		expect((await render({ ...halted, applied: 1 })).chip).toBe('Lauf');
	});

	it('an approved run that is working, and a writing one, stand at their run', async () => {
		expect((await render({})).chip).toBe('Lauf');
		unmount(component!);
		component = undefined;
		expect((await render({ phase: 'writing' })).chip).toBe('Lauf');
	});

	it('anything sent counts: a conflict, a failure or a send of unknown outcome', () => {
		const base = { probe: null, haltReason: 'x', haltKey: 'unavailable', phase: 'approved' as const, targetSystem: 'http:h', probeConfirmed: true, probeOwn: false,
			changes: { update: 3, create: 0, delete: 0, unchanged: 0, invalid: 0 }, applied: 0, conflicts: 0, failed: 0, sentUnknown: 0 };
		expect(bulkStep(base)).toBe('approval');
		for (const k of ['applied', 'conflicts', 'failed', 'sentUnknown'] as const) expect(bulkStep({ ...base, [k]: 1 }), k).toBe('run');
	});
});

describe('an aborted run reads that it cannot go on', () => {
	it('an undo rolled back as a whole stands at its run and reads „Abgebrochen“, not „fertig“ next to „Angehalten“', async () => {
		const { chip, heads } = await render({ ...ROLLED_BACK, kind: 'undo', sourceRunId: 'src1' });
		expect(chip).toBe('Lauf');
		expect(heads).toContain('Abgebrochen');
		expect(heads).not.toContain('Angehalten');
	});

	it('so does an apply rolled back as a whole', async () => {
		const { chip, heads } = await render(ROLLED_BACK);
		expect(chip).toBe('Lauf');
		expect(heads).toContain('Abgebrochen');
	});

	it('a run a newer one replaced before its approval reads „Ersetzt“ and marks no step', async () => {
		const { chip, heads } = await render({ phase: 'aborted', haltKey: 'superseded', haltReason: 'engine English', checksum: null });
		expect(chip).toBeNull();
		expect(heads).toContain('Ersetzt');
		expect(heads).not.toContain('Abgebrochen');
	});

	it('a run whose mandate ended before its approval reads „Abgebrochen“ and marks no step', async () => {
		const { chip, heads } = await render({ phase: 'aborted', haltKey: 'mandateEnded', haltReason: 'engine English', checksum: null });
		expect(chip).toBeNull();
		expect(heads).toContain('Abgebrochen');
	});

	it('control: a discarded run keeps its own word and chip', async () => {
		const { chip, heads } = await render({ phase: 'aborted', haltKey: 'discarded', haltReason: 'engine English', checksum: null });
		expect(chip).toBe('verworfen');
		expect(heads).toContain('Verworfen');
	});

	it('control: a run halted while it read or judged before its approval is halted, not aborted', async () => {
		const { heads } = await render({ ...halted, phase: 'planned', checksum: null });
		expect(heads).toContain('Angehalten');
		expect(heads).not.toContain('Abgebrochen');
	});

	it('reads in English as approved', async () => {
		setLocale('en');
		expect((await render(ROLLED_BACK)).heads).toContain('Aborted');
		unmount(component!);
		component = undefined;
		expect((await render({ phase: 'aborted', haltKey: 'superseded', haltReason: 'engine English', checksum: null })).heads).toContain('Replaced');
	});
});
