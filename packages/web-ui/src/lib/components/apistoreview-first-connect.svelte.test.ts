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

	const TAKE_OVER = 'Diese Verbindung hat eine Person mit Zugang eingerichtet; verbinden kann sie nur diese Person. Willst du sie selbst verbinden, sag lynox im Chat, dass du sie übernimmst. Danach kannst du sie hier verbinden.';
	const ANNA = 'mandate:anna@example.com';
	const ago = (): string => new Date(Date.now() - DAY).toISOString();

	// The owner on a profile a person with access set up: the way to take it over stands where the
	// first connect would, below the app credentials' Save, and only where the engine says the
	// owner's save goes through (`owner_may_take_over`, the condition the save itself asks).
	it('the owner, never connected: no first connect; the way to take it over, once, below Save in the form', async () => {
		serve('owner', [{ ...shop, created_by: ANNA, reader_may_connect: false, owner_may_take_over: true }]);
		await render();
		const form = q('preset-client-form');
		expect(form).not.toBeNull();
		expect(q('api-connect-first')).toBeNull();
		expect(q('api-connect-first-link')).toBeNull();
		expect(q('api-connect-first-not-yours')).toBeNull();
		const line = q('api-set-up-by-member');
		expect(line?.textContent).toBe(TAKE_OVER);
		expect(all('api-set-up-by-member')).toBe(1);
		expect(form?.contains(line)).toBe(true);
		const save = [...form!.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Speichern');
		expect(save).toBeDefined();
		expect(save!.compareDocumentPosition(line!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it('the owner, the person who set it up connected it and their access lasts: no way to take it over, their connection shown', async () => {
		serve('owner', [{ ...shop, created_by: ANNA, reader_may_connect: false, owner_may_take_over: false, oauth_grant: { connection: true, state: 'connected', connected_by: ANNA, connected_by_reader: false } }]);
		await render();
		expect(q('api-set-up-by-member')).toBeNull();
		expect(q('api-connection')).not.toBeNull();
		expect(q('api-connect-first-link')).toBeNull();
	});

	it('the owner, that person\'s grant revoked while their access lasts: no way to take it over, no reconnect', async () => {
		serve('owner', [{ ...shop, created_by: ANNA, reader_may_connect: false, owner_may_take_over: false, oauth_grant: { connection: true, state: 'revoked', revoked_at: ago(), connected_by: ANNA } }]);
		await render();
		expect(q('api-set-up-by-member')).toBeNull();
		expect(q('api-reconnect')).toBeNull();
		expect(q('api-reconnect-not-yours')).toBeNull();
	});

	it('the owner, that person\'s access ended: the way to take it over, once', async () => {
		serve('owner', [{ ...shop, created_by: ANNA, reader_may_connect: false, owner_may_take_over: true, oauth_grant: { connection: true, state: 'connected', connected_by: ANNA, connected_by_reader: false } }]);
		await render();
		expect(q('api-set-up-by-member')?.textContent).toBe(TAKE_OVER);
		expect(all('api-set-up-by-member')).toBe(1);
	});

	it('the owner, an own connection on a profile a person with access set up: not shown as connected, the way once', async () => {
		serve('owner', [{ ...shop, created_by: ANNA, reader_may_connect: false, owner_may_take_over: true, oauth_grant: { connection: true, state: 'connected', connected_by: 'owner', connected_by_reader: true, unused: true } }]);
		await render();
		expect(q('api-connection')).toBeNull();
		expect(all('api-set-up-by-member')).toBe(1);
	});

	it('the owner, such a profile signing in without a built-in provider: the way on its own line', async () => {
		serve('owner', [{ id: 'crm', name: 'CRM', base_url: 'https://crm.example', description: '', auth: { type: 'oauth2', oauth: {} }, created_by: ANNA, reader_may_connect: false, owner_may_take_over: true }]);
		await render();
		expect(q('preset-client-form')).toBeNull();
		expect(q('api-set-up-by-member')?.textContent).toBe(TAKE_OVER);
	});

	it('control: the owner\'s connection on the owner\'s profile is shown as connected', async () => {
		serve('owner', [{ ...shop, oauth_grant: { connection: true, state: 'connected', connected_by: 'owner', connected_by_reader: true } }]);
		await render();
		expect(q('api-connection')).not.toBeNull();
		expect(q('api-set-up-by-member')).toBeNull();
	});

	it('the person who set it up, client pair released: the first connect', async () => {
		serve('mandate', [{ ...shop, created_by: 'mandate:anna@example.com', reader_may_connect: true, reader_client_withheld: false }]);
		await render();
		const link = q('api-connect-first-member') as HTMLAnchorElement | null;
		expect(link?.getAttribute('href')).toBe('/api/oauth/connect/shop');
		expect(link?.textContent).toBe('Konto verbinden');
		expect(q('api-connect-first-withheld')).toBeNull();
	});

	it('the person who set it up, client pair not released: who has to act, no link', async () => {
		serve('mandate', [{ ...shop, created_by: 'mandate:anna@example.com', reader_may_connect: true, reader_client_withheld: true }]);
		await render();
		expect(q('api-connect-first-withheld')?.textContent).toBe('Verbinden kannst du diese Verbindung, sobald der Inhaber dir ihren App-Zugang freigegeben hat. Bitte den Inhaber darum.');
		expect(q('api-connect-first-member')).toBeNull();
	});

	it('another person with access (no field from the server): neither link nor release line', async () => {
		serve('mandate', [{ ...shop, created_by: 'mandate:anna@example.com', reader_may_connect: false }]);
		await render();
		expect(q('api-connect-first-member')).toBeNull();
		expect(q('api-connect-first-withheld')).toBeNull();
		expect(q('api-connect-first-not-yours')).not.toBeNull();
	});

	it('the owner, a profile the owner set up: the first connect', async () => {
		serve('owner', [{ ...shop, created_by: 'owner' }]);
		await render();
		expect(q('api-connect-first-link')?.getAttribute('href')).toBe('/api/oauth/connect/shop');
	});

	it('the owner, no secret saved: no button, the form is the step before', async () => {
		serve('owner', [shop], false);
		await render();
		expect(q('preset-client-form')).not.toBeNull();
		expect(q('api-connect-first-link')).toBeNull();
	});

	it('the owner, already connected: no first connect', async () => {
		serve('owner', [{ ...shop, oauth_grant: { connection: true, state: 'connected', connected_by: 'owner' } }]);
		await render();
		expect(q('preset-client-form')).not.toBeNull();
		expect(q('api-connect-first-link')).toBeNull();
	});

	// A save records a grant for every new oauth2 profile before anyone connected it: the engine
	// says it is no connection (`connection: false`), and the profile is still to connect.
	const minted = { grant_id: 'g-1', connected_by_reader: true, connection: false };

	it('the owner, a never-connected profile carrying the record a save makes: the first connect', async () => {
		serve('owner', [{ ...shop, oauth_grant: minted }]);
		await render();
		expect(q('api-connect-first-link')?.getAttribute('href')).toBe('/api/oauth/connect/shop');
		expect(q('api-connection')).toBeNull();
	});

	it('the person who set it up, client pair released, the record a save makes: the first connect', async () => {
		serve('mandate', [{ ...shop, created_by: 'mandate:anna@example.com', reader_may_connect: true, reader_client_withheld: false, oauth_grant: { ...minted, connected_by_reader: false } }]);
		await render();
		expect(q('api-connect-first-member')?.getAttribute('href')).toBe('/api/oauth/connect/shop');
	});

	it('the person who set it up, client pair not released, the record a save makes: who has to act', async () => {
		serve('mandate', [{ ...shop, created_by: 'mandate:anna@example.com', reader_may_connect: true, reader_client_withheld: true, oauth_grant: { ...minted, connected_by_reader: false } }]);
		await render();
		expect(q('api-connect-first-withheld')).not.toBeNull();
		expect(q('api-connect-first-member')).toBeNull();
	});

	// What a revoked grant shows does not depend on `connection`: its own reconnect link, never the first connect.
	it.each([[true], [false]])('the owner, grant revoked (connection %s): the reconnect link only', async (connection) => {
		serve('owner', [{ ...shop, oauth_grant: { connection, state: 'revoked', revoked_at: new Date(Date.now() - DAY).toISOString() } }]);
		await render();
		expect(all('api-reconnect')).toBe(1);
		expect(q('api-connect-first-link')).toBeNull();
	});

	it('the owner, grant revoked: the reconnect link only, not a second one', async () => {
		serve('owner', [{ ...shop, oauth_grant: { connection: true, state: 'revoked', revoked_at: new Date(Date.now() - DAY).toISOString() } }]);
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

	it('a mandate, a profile with an API key (nothing to connect): no sentence', async () => {
		serve('mandate', [{ ...shop, id: 'crm', auth: { type: 'bearer' }, reader_may_connect: false }]);
		await render();
		expect(q('api-connect-first-not-yours')).toBeNull();
	});

	it('a mandate the server lets connect it (its own profile): no refusal sentence', async () => {
		serve('mandate', [{ ...shop, reader_may_connect: true }]);
		await render();
		expect(q('api-connect-first-not-yours')).toBeNull();
	});

	it('the owner, an erasure still held but no grant left: the revocation view\'s link only, no second one', async () => {
		const notice = { recordId: 1, connectionId: 'shop', revokedAt: new Date(Date.now() - DAY).toISOString(), holdUntil: new Date(Date.now() + 13 * DAY).toISOString(), deadline: new Date(Date.now() + 29 * DAY).toISOString(), reconnected: false };
		serve('owner', [shop], true, [notice]);
		await render();
		expect(q('api-revoked')).not.toBeNull();
		expect(all('api-reconnect')).toBe(1);
		expect(q('api-connect-first-link')).toBeNull();
	});

	it('the owner, an erasure past its hold and no grant left: the first connect is the way back', async () => {
		const notice = { recordId: 1, connectionId: 'shop', revokedAt: new Date(Date.now() - 20 * DAY).toISOString(), holdUntil: new Date(Date.now() - 6 * DAY).toISOString(), deadline: new Date(Date.now() + 9 * DAY).toISOString(), reconnected: false };
		serve('owner', [shop], true, [notice]);
		await render();
		expect(q('api-revoked')).not.toBeNull();
		expect(q('api-reconnect')).toBeNull();
		expect(q('api-connect-first-link')?.getAttribute('href')).toBe('/api/oauth/connect/shop');
	});

	it('a session the server lets not connect it, profile revoked: the reconnect refusal only, not the first-connect sentence', async () => {
		serve('mandate', [{ ...shop, reader_may_connect: false, oauth_grant: { connection: true, state: 'revoked', revoked_at: new Date(Date.now() - DAY).toISOString() } }]);
		await render();
		expect(q('api-reconnect-not-yours')).not.toBeNull();
		expect(q('api-connect-first-not-yours')).toBeNull();
	});
});
