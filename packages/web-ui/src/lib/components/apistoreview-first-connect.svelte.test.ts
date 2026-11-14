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

// A profile on a built-in provider whose app credentials are saved but which was never connected:
// the owner gets "Connect account" right below the app credentials, a link to the same engine
// route the reconnect uses. A session the server lets not connect it gets a sentence instead.
// A revoked grant keeps its own reconnect link and gets no second one.

const DAY = 24 * 3600 * 1000;
const shop = { id: 'shop', name: 'Shop', base_url: 'https://shop.example', description: '', auth: { type: 'oauth2', oauth: { preset_id: 'shopify' } } };

let target: HTMLElement;
let component: Record<string, unknown> | undefined;

function serve(viewer: 'owner' | 'mandate', profiles: unknown[], secretSet = true): void {
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const u = String(url);
		if (u.endsWith('/config')) return Response.json({ viewer });
		if (u.endsWith('/connections/records')) return viewer === 'owner' ? Response.json({ notices: [] }) : Response.json({ error: 'owner only' }, { status: 403 });
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

describe('the first connect of a profile on a built-in provider', () => {
	it('the owner, app credentials saved, no grant: the sentence and "Konto verbinden" to the engine\'s connect route', async () => {
		serve('owner', [shop]);
		await render();
		expect(q('api-connect-first')?.textContent).toContain('Der App-Zugang ist gespeichert. Verbinde jetzt dein Shopify-Konto, damit lynox es nutzen kann.');
		const link = q('api-connect-first-link') as HTMLAnchorElement | null;
		expect(link?.textContent).toBe('Konto verbinden');
		expect(link?.getAttribute('href')).toBe('/api/oauth/connect/shop');
		expect(link?.hasAttribute('data-sveltekit-reload')).toBe(true);
		expect(q('api-reconnect')).toBeNull();
		expect(q('api-connect-first-not-yours')).toBeNull();
	});

	it('the owner, no secret saved: no button, the form is the step before', async () => {
		serve('owner', [shop], false);
		await render();
		expect(q('preset-client-form')).not.toBeNull();
		expect(q('api-connect-first-link')).toBeNull();
	});

	it('the owner, already connected: no first connect', async () => {
		serve('owner', [{ ...shop, oauth_grant: { state: 'connected', connected_by: 'owner' } }]);
		await render();
		expect(q('preset-client-form')).not.toBeNull();
		expect(q('api-connect-first-link')).toBeNull();
	});

	it('the owner, grant revoked: the reconnect link only, not a second one', async () => {
		serve('owner', [{ ...shop, oauth_grant: { state: 'revoked', revoked_at: new Date(Date.now() - DAY).toISOString() } }]);
		await render();
		expect(all('api-reconnect')).toBe(1);
		expect(q('api-connect-first-link')).toBeNull();
	});

	it('a session the server lets not connect it: the sentence, no button', async () => {
		serve('mandate', [{ ...shop, reader_may_connect: false }]);
		await render();
		expect(q('api-connect-first-not-yours')?.textContent).toBe('Verbinden kann diese Verbindung nur, wer sie eingerichtet hat. Brauchst du sie, wende dich an den Inhaber.');
		expect(q('api-connect-first-link')).toBeNull();
	});

	it('a session the server lets not connect it, profile revoked: the reconnect refusal only, not the first-connect sentence', async () => {
		serve('mandate', [{ ...shop, reader_may_connect: false, oauth_grant: { state: 'revoked', revoked_at: new Date(Date.now() - DAY).toISOString() } }]);
		await render();
		expect(q('api-reconnect-not-yours')).not.toBeNull();
		expect(q('api-connect-first-not-yours')).toBeNull();
	});
});
