import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t } from '../i18n.svelte.js';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

// `svelte` resolves to its server entry under node, where `mount` throws. The component is compiled
// for the client, so it is mounted with the client entry, loaded by path.
const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

// A workflow run started from a chat that only reads is marked in the run list and says, above
// its step outputs, what that means; a failed check says so and where to look.

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let runs: Record<string, unknown>[];

const run = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
	id, manifest_name: `wf ${id}`, status: 'completed', total_duration_ms: 1000, total_cost_usd: 0.01, step_count: 1,
	error: null, started_at: '2026-10-30T08:00:00.000Z', ...over,
});

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	runs = [];
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const u = String(url);
		const m = /\/workflows\/([^/?]+)(\/steps)?$/.exec(u);
		let body: unknown = { runs };
		if (m) {
			const r = runs.find((x) => x['id'] === m[1])!;
			body = m[2] ? { steps: [] } : { ...r, manifest_json: '{}', total_tokens_in: 1, total_tokens_out: 1, parent_run_id: null, completed_at: null };
		}
		return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
	const { default: WorkflowsView } = await import('./WorkflowsView.svelte');
	component = mount(WorkflowsView, { target });
	await settle();
}

/** Opens the run's detail by its row button. */
async function open(id: string): Promise<void> {
	const btn = [...target.querySelectorAll('button')].find((b) => b.textContent?.includes(`wf ${id}`))!;
	btn.click();
	await settle();
}

const badgeOf = (id: string): string | null => {
	const btn = [...target.querySelectorAll('button')].find((b) => b.textContent?.includes(`wf ${id}`));
	return btn?.querySelector('[data-run-contained]')?.textContent?.trim() ?? null;
};
const note = (): string | null => target.querySelector('[data-run-contained-note]')?.textContent?.trim() ?? null;

describe('WorkflowsView: a run started from a chat that only reads', () => {
	it('control: a run without the mark shows neither the mark nor the sentence', async () => {
		runs = [run('r-free')];
		await render();
		expect(badgeOf('r-free')).toBeNull();
		await open('r-free');
		expect(note()).toBeNull();
	});

	it('a recorded one: the mark in the list and the sentence above the outputs', async () => {
		runs = [run('r-shop', { contained: true }), run('r-free')];
		await render();
		expect(badgeOf('r-shop')).toBe(t('workflow.run_contained_badge'));
		expect(badgeOf('r-free')).toBeNull();
		await open('r-shop');
		expect(note()).toBe(t('workflow.run_contained_note'));
	});

	it('a failed check: its own mark and sentence, with the way that fits the instance', async () => {
		runs = [run('r-prov', { contained: true, contained_unknown: 'provisioned' }), run('r-self', { contained: true, contained_unknown: 'self-hosted' })];
		await render();
		expect(badgeOf('r-prov')).toBe(t('workflow.run_contained_badge_unknown'));
		await open('r-prov');
		expect(note()).toBe(`${t('workflow.run_contained_note_unknown')} ${t('contained.unknown_way_support')}`);
		await open('r-prov');
		await open('r-self');
		expect(note()).toBe(`${t('workflow.run_contained_note_unknown')} ${t('contained.unknown_way_logs')}`);
	});
});
