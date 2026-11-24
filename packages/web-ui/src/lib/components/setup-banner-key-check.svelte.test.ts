import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { setLocale, getLocale } from '../i18n.svelte.js';
import { resetSettingsViewer } from '../stores/settings-viewer.svelte.js';
import { PROVIDER_LIST_KEY_CODE, keyCheckError } from '../utils/setup-key-check.js';

// The client build of svelte: `mount` under the node condition is the server one.
const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: HTMLElement }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

// The sentences released for the setup banner (U-307), word for word.
const DE = 'Diese Instanz ist mit einem Shopify-Store verbunden. Dann schickt lynox Text nur über einen Zugang, den lynox selbst verwaltet, nicht über einen eigenen Key. Dein Key wurde nicht geprüft und nicht gespeichert. Schreib an support@lynox.ai, damit wir das mit dir klären.';
const EN = 'This instance is connected to a Shopify store. lynox then sends text only through access that lynox manages itself, not through a key of your own. Your key was not checked and not saved. Write to support@lynox.ai so we can sort this out with you.';
// What the engine sends beside the code: its own sentence, in English, for the other places it is shown.
const ENGINE_REFUSAL = 'Nothing was sent: on an instance connected to a Shopify store, lynox sends text only to Anthropic or Fireworks, '
	+ 'and the model chosen for this runs elsewhere. Choose an Anthropic or Fireworks model in the settings.';

const localeBefore = getLocale();
let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let writes: string[];

beforeEach(() => {
	resetSettingsViewer();
	writes = [];
	target = document.createElement('div');
	document.body.appendChild(target);
	localStorage.removeItem('lynox-setup-dismissed');
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
	setLocale(localeBefore);
});

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

/** The owner's banner on a tier where they bring their own key, the key check answering `check`. */
async function renderBanner(check: Record<string, unknown>): Promise<void> {
	vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
		const path = String(url).split('?')[0]!;
		if (path.endsWith('/secrets/validate-key')) return Response.json(check);
		if (init?.method !== undefined && init.method !== 'GET') { writes.push(`${init.method} ${path}`); return Response.json({}); }
		if (path.endsWith('/secrets/status')) return Response.json({ provider: 'anthropic', managed: 'hosted', configured: { api_key: false } });
		if (path.endsWith('/config')) return Response.json({ managed: 'hosted', viewer: 'owner' });
		return Response.json({ error: 'not found' }, { status: 404 });
	}));
	const { default: Banner } = await import('./SetupBanner.svelte');
	component = mount(Banner, { target });
	await settle();
}

async function typeKeyAndSave(): Promise<void> {
	const input = target.querySelector<HTMLInputElement>('#setup-api-key');
	expect(input, 'the key field').not.toBeNull();
	input!.value = ['sk', 'ant', 'api03', 'typed-by-the-owner'].join('-');
	input!.dispatchEvent(new Event('input', { bubbles: true }));
	await settle();
	const save = [...target.querySelectorAll('button')].find((b) => !b.disabled && /Speichern|Save/.test(b.textContent ?? ''));
	expect(save, 'the save button').toBeDefined();
	save!.click();
	await settle();
}

function shownError(): string | undefined {
	return target.querySelector('p.text-danger')?.textContent?.trim();
}

describe('the setup banner when the key check is refused for a store-connected instance', () => {
	it('says why in the page\'s language, word for word, German and English', () => {
		const check = { state: 'invalid' as const, error: ENGINE_REFUSAL, code: PROVIDER_LIST_KEY_CODE };
		setLocale('de');
		expect(keyCheckError(check)).toBe(DE);
		setLocale('en');
		expect(keyCheckError(check)).toBe(EN);
		// Another refusal keeps the engine's reason.
		expect(keyCheckError({ state: 'invalid', error: 'Invalid API key (401)' })).toBe('Invalid API key (401)');
	});

	it('shows the sentence under the key field and saves nothing', async () => {
		setLocale('de');
		await renderBanner({ state: 'invalid', error: ENGINE_REFUSAL, code: 'provider_list_own_key' });
		await typeKeyAndSave();
		expect(shownError()).toBe(DE);
		expect(writes).toEqual([]);
	});

	it('control: a key the check accepts is saved', async () => {
		setLocale('de');
		await renderBanner({ state: 'valid' });
		await typeKeyAndSave();
		expect(shownError()).toBeUndefined();
		expect(writes).toContain('PUT /api/secrets/ANTHROPIC_API_KEY');
	});

	it('compares against the code the engine sends', () => {
		const server = readFileSync(join(__dirname, '../../../../../src/server/http-api.ts'), 'utf8');
		const sent = /export const PROVIDER_LIST_KEY_CODE = '([^']+)';/.exec(server)?.[1];
		expect(sent).toBeDefined();
		expect(PROVIDER_LIST_KEY_CODE).toBe(sent);
	});
});
