import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { resetSettingsViewer } from '../stores/settings-viewer.svelte.js';

const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

// The actions of a profile carry their names in view (a touch screen shows no tooltip), and the
// halt hints that send the owner here name the button by that label, word for word.

const shop = { id: 'shop', name: 'Shop', base_url: 'https://shop.example', description: '', auth: { type: 'oauth2', oauth: { preset_id: 'shopify' } } };

let target: HTMLElement;
let component: Record<string, unknown> | undefined;

function serve(viewer: 'owner' | 'mandate', profiles: unknown[], secretSet = true, notices: unknown[] = []): void {
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const u = String(url);
		if (u.endsWith('/config')) return Response.json({ viewer });
		if (u.endsWith('/connections/records')) return viewer === 'owner' ? Response.json({ notices }) : Response.json({ error: 'owner only' }, { status: 403 });
		if (u.endsWith('/client')) {
			if (viewer !== 'owner') return Response.json({ error: 'owner only' }, { status: 403 });
			return Response.json({ preset: 'shopify', client_id_key: 'K', client_secret_key: 'S', client_id: secretSet ? 'client-1' : null, client_secret_set: secretSet, redirect_uri: 'https://tenant.example/api/oauth/callback', reads_other_names: false });
		}
		return Response.json({ profiles });
	}));
}

beforeEach(async () => {
	(await import('../i18n.svelte.js')).setLocale('de');
	resetSettingsViewer();
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
	const { default: ApiStoreView } = await import('./ApiStoreView.svelte');
	component = mount(ApiStoreView, { target });
	for (let i = 0; i < 15; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}
const q = (id: string): HTMLElement | null => target.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const all = (id: string): number => target.querySelectorAll(`[data-testid="${id}"]`).length;

describe('the actions of a profile', () => {
	for (const lang of ['de', 'en'] as const) {
		it(`shows "manage in chat" by its name, not by an icon alone, for the owner and a mandate (${lang})`, async () => {
			const { setLocale, t } = await import('../i18n.svelte.js');
			for (const viewer of ['owner', 'mandate'] as const) {
				setLocale(lang);
				resetSettingsViewer();
				serve(viewer, [shop]);
				await render();
				const chat = q('api-manage-in-chat');
				expect(chat?.textContent?.trim(), viewer).toBe(t('apis.manage_in_chat'));
				expect(chat?.textContent?.trim(), viewer).toBe(lang === 'de' ? 'Im Chat verwalten' : 'Manage in chat');
				// In the row of actions, not squeezed into the profile's header beside its text.
				expect(chat?.closest('[data-testid="api-actions"]'), viewer).not.toBeNull();
				// Delete only for the owner, also by its name, in the same row.
				const del = q('api-delete');
				if (viewer === 'owner') {
					expect(del?.textContent?.trim()).toBe(t('apis.delete'));
					expect(del?.closest('[data-testid="api-actions"]')).not.toBeNull();
				} else {
					expect(del).toBeNull();
				}
				if (component) unmount(component);
				component = undefined;
				target.innerHTML = '';
				vi.unstubAllGlobals();
			}
		});
	}

	it('is named word for word by the halt hints that send the owner here, in both languages', async () => {
		const { setLocale, t } = await import('../i18n.svelte.js');
		for (const key of ['bulk.halt.credential_before', 'bulk.halt.unauthorized_before']) {
			setLocale('de');
			expect(t(key), key).toContain(`auf „${t('apis.manage_in_chat')}“`);
			expect(t(key), key).not.toContain('Symbol');
			setLocale('en');
			expect(t(key), key).toContain(`tap “${t('apis.manage_in_chat')}”`);
			expect(t(key), key).not.toContain('icon');
		}
	});
});
