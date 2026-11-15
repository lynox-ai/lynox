import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readable } from 'svelte/store';
import { t } from '../i18n.svelte.js';

// The overview asks for three summaries at once, the page most likely to reach the engine's
// rate limit. When none of them loads, it names the failure the last one had.

vi.mock('$app/stores', () => ({ page: readable({ url: new URL('http://localhost/app/activity?tab=overview') }) }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('./MarkdownRenderer.svelte', () => ({ default: () => {} }));

const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element; props?: Record<string, unknown> }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

let summaryStatus = 429;
let target: HTMLElement;
let component: Record<string, unknown> | undefined;

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const u = String(url);
		if (u.includes('/usage/summary')) return new Response('{}', { status: summaryStatus, headers: { 'Content-Type': 'application/json' } });
		return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
	}));
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
});

async function render(): Promise<void> {
	const { default: ActivityOverview } = await import('./ActivityOverview.svelte');
	component = mount(ActivityOverview, { target });
	for (let i = 0; i < 10; i++) { await new Promise((r) => setTimeout(r, 0)); await tick(); flushSync(); }
}

describe('the activity overview', () => {
	it('says a 429 on its summaries is too many requests', async () => {
		summaryStatus = 429;
		await render();
		expect(target.textContent).toContain(t('common.rate_limited'));
		expect(target.textContent).not.toContain(t('common.load_failed'));
	});

	it('keeps the general sentence for another failure', async () => {
		summaryStatus = 503;
		await render();
		expect(target.textContent).toContain(t('common.load_failed'));
		expect(target.textContent).not.toContain(t('common.rate_limited'));
	});
});
