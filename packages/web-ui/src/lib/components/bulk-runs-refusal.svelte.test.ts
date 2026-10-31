import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t } from '../i18n.svelte.js';
import { getToasts } from '../stores/toast.svelte.js';

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

const OWNER_ONLY = 'Only the owner of this instance can change the configuration.';

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
/** What a PUT /config answers. */
let refusal: Response;

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
		if (String(url).endsWith('/config') && init?.method === 'PUT') return refusal.clone();
		return Response.json({ bulk_runs: { on: false, source: 'config', allowed: true, db: true, shopify: false } });
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

async function toggleAndReadToast(): Promise<string | undefined> {
	const { default: BulkRunsSetting } = await import('./BulkRunsSetting.svelte');
	component = mount(BulkRunsSetting, { target });
	await settle();
	const before = getToasts().length;
	target.querySelector<HTMLButtonElement>('[role="switch"]')!.click();
	await settle();
	return getToasts().slice(before).find((toast) => toast.type === 'error')?.message;
}

describe('a refused settings save says why (BulkRunsSetting)', () => {
	it('shows the server\'s sentence when a mandate is refused', async () => {
		refusal = Response.json({ error: OWNER_ONLY }, { status: 403 });
		expect(await toggleAndReadToast()).toBe(OWNER_ONLY);
	});

	it('shows its own text when the refusal carries no sentence', async () => {
		refusal = new Response('', { status: 502 });
		expect(await toggleAndReadToast()).toBe(t('tools.save_failed'));
	});
});
