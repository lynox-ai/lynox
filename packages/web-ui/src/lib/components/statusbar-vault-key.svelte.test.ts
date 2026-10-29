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

const alertText = (): string | null => target.querySelector('[role="alert"]')?.textContent?.trim() ?? null;

describe('the status bar banner for a keyless boot over encrypted data', () => {
	it('shows the banner when the providers poll carries the field', async () => {
		stubFetch({ vault_key: 'missing_over_encrypted_data', vault_key_stores: ['engine.db'] });
		await render();
		expect(t('status.vault_key_missing')).not.toBe('status.vault_key_missing');
		expect(alertText()).toBe(t('status.vault_key_missing'));
	});

	it('says it could not be checked for unknown', async () => {
		stubFetch({ vault_key: 'unknown' });
		await render();
		expect(alertText()).toBe(t('status.vault_key_unknown'));
	});

	it('shows nothing without the field, even when health says degraded', async () => {
		stubFetch({});
		await render();
		expect(alertText()).toBeNull();
	});

	it('ignores a value it does not know', async () => {
		stubFetch({ vault_key: 'something_else' });
		await render();
		expect(alertText()).toBeNull();
	});
});
