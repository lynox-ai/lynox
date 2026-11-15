import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readable } from 'svelte/store';
import { t } from '../i18n.svelte.js';
import { resetSettingsViewer } from '../stores/settings-viewer.svelte.js';

// The engine answers a burst of requests with 429. The bulk pages then say that, not "Is the
// engine reachable?", and the list does not add "no runs yet" under a failed load.

vi.mock('$app/stores', () => ({ page: readable({ url: new URL('http://localhost/app/activity?tab=bulk') }) }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element; props?: Record<string, unknown> }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

type Answer = 'ok-empty' | 'rate-limited' | 'network';
let answer: Answer;
let target: HTMLElement;
let component: Record<string, unknown> | undefined;

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	resetSettingsViewer();
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const u = String(url);
		const reply = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
		if (u.endsWith('/config')) return reply({ managed: true, viewer: 'owner' });
		if (answer === 'network') throw new TypeError('Failed to fetch');
		if (answer === 'rate-limited') return new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '4' } });
		if (u.endsWith('/bulk/runs')) return reply({ runs: [] });
		if (u.endsWith('/merges')) return reply({ merges: [] });
		return reply({}, 404);
	}));
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	resetSettingsViewer();
	vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) { await new Promise((r) => setTimeout(r, 0)); await tick(); flushSync(); }
}

async function renderList(): Promise<void> {
	const { default: BulkRunsView } = await import('./BulkRunsView.svelte');
	component = mount(BulkRunsView, { target });
	await settle();
}

describe('the list of bulk runs', () => {
	it('says a 429 is too many requests, and not that there are no runs', async () => {
		answer = 'rate-limited';
		await renderList();
		expect(target.textContent).toContain(t('common.rate_limited'));
		expect(target.textContent).not.toContain(t('common.load_failed'));
		expect(target.textContent).not.toContain(t('bulk.empty'));
	});

	it('says a network error is a failed load, and not that there are no runs', async () => {
		answer = 'network';
		await renderList();
		expect(target.textContent).toContain(t('common.load_failed'));
		expect(target.textContent).not.toContain(t('common.rate_limited'));
		expect(target.textContent).not.toContain(t('bulk.empty'));
	});

	it('says there are no runs after a load that found none', async () => {
		answer = 'ok-empty';
		await renderList();
		expect(target.textContent).toContain(t('bulk.empty'));
		expect(target.textContent).not.toContain(t('common.load_failed'));
		expect(target.textContent).not.toContain(t('common.rate_limited'));
	});
});

describe('a run\'s page', () => {
	for (const [what, said, notSaid] of [
		['rate-limited', 'common.rate_limited', 'common.load_failed'],
		['network', 'common.load_failed', 'common.rate_limited'],
	] as const) {
		it(`says ${said} when the run's load is ${what}`, async () => {
			answer = what;
			const { default: BulkRunDetail } = await import('./BulkRunDetail.svelte');
			component = mount(BulkRunDetail, { target, props: { runId: 'r1', onBack: () => {}, onOpen: () => {} } });
			await settle();
			expect(target.textContent).toContain(t(said));
			expect(target.textContent).not.toContain(t(notSaid));
		});
	}
});
