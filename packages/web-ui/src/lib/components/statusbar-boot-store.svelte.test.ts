import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t } from '../i18n.svelte.js';

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
// StatusBar imports `onDestroy` from `svelte`, which would also resolve to the server entry; the
// component gets the same client runtime it is mounted with.
vi.mock('svelte', async () => {
	const { createRequire: req } = await import('node:module');
	const path = await import('node:path');
	return import(/* @vite-ignore */ path.join(path.dirname(req(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js'));
});

let target: HTMLElement;
let component: Record<string, unknown> | undefined;

/** Answers every poll; `/providers/status` carries `extra`, `/health` says `degraded` either way. */
function stubFetch(extra: Record<string, unknown>): void {
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const u = String(url);
		const body = u.endsWith('/providers/status')
			? { providers: [{ provider: 'Anthropic', indicator: 'none', description: '' }], ...extra }
			: u.endsWith('/health')
				? { status: 'degraded', version: '0.0.0', build_sha: null }
				: {};
		return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
	}));
}

beforeEach(() => {
	// jsdom has no ResizeObserver; the bar's scroll fade only needs one to exist.
	vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
});

async function render(): Promise<void> {
	const { default: StatusBar } = await import('./StatusBar.svelte');
	component = mount(StatusBar, { target });
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

const alerts = (): string[] => [...target.querySelectorAll('[role="alert"]')].map((e) => e.textContent?.trim() ?? '');

const line = (keys: string[]): string => keys.map((k) => t(k)).join(' ');
const ENGINE = 'status.boot_store_missing_engine';
const HISTORY = 'status.boot_store_missing_history';
const SELF = 'status.boot_store_missing_selfhost';
const MANAGED = 'status.boot_store_missing_managed';

describe('the status bar line for a boot store that did not open (U-162)', () => {
	it('shows one line with the store sentence and the self-host close when the poll names a store', async () => {
		stubFetch({ boot_stores_missing: ['engine.db'] });
		await render();
		for (const k of [ENGINE, SELF]) expect(t(k)).not.toBe(k);
		expect(alerts()).toEqual([line([ENGINE, SELF])]);
	});

	it('names both stores in one line, with the close once, and the managed close when alerted', async () => {
		stubFetch({ boot_stores_missing: ['history.db', 'engine.db'], boot_stores_alerted: true });
		await render();
		expect(alerts()).toEqual([line([ENGINE, HISTORY, MANAGED])]);
	});

	it("shows nothing without the field (a mandate's poll never carries it), even when health says degraded", async () => {
		stubFetch({});
		await render();
		expect(alerts()).toEqual([]);
	});

	it('ignores names it does not know, and an empty list', async () => {
		stubFetch({ boot_stores_missing: ['vault.db', 42] });
		await render();
		expect(alerts()).toEqual([]);
		if (component) unmount(component);
		component = undefined;
		stubFetch({ boot_stores_missing: [] , boot_stores_alerted: true });
		await render();
		expect(alerts()).toEqual([]);
	});

	it('says the team is alerted only for a literal true, never for a look-alike', async () => {
		stubFetch({ boot_stores_missing: ['engine.db'], boot_stores_alerted: 'true' });
		await render();
		expect(alerts()).toEqual([line([ENGINE, SELF])]);
	});

	it('stands next to the vault key line when both are reported', async () => {
		stubFetch({ boot_stores_missing: ['history.db'], vault_key: 'missing_over_encrypted_data' });
		await render();
		expect(alerts()).toEqual([line([HISTORY, SELF]), t('status.vault_key_missing')]);
	});
});
