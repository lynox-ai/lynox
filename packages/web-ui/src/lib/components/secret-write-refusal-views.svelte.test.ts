import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { resetSettingsViewer } from '../stores/settings-viewer.svelte.js';

// `svelte` resolves to its server entry under node, where `mount` throws. The views are compiled
// for the client, so they are mounted with the client entry, loaded by path.
const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element; props?: Record<string, unknown> }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

const NAME = 'SHOPIFY_CLIENT_SECRET';
let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let putReply: { status: number; body: Record<string, unknown> };

beforeEach(async () => {
	resetSettingsViewer();
	(await import('../i18n.svelte.js')).setLocale('en');
	target = document.createElement('div');
	document.body.appendChild(target);
	vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
		if ((init?.method ?? 'GET') === 'PUT') return new Response(JSON.stringify(putReply.body), { status: putReply.status });
		if (String(url).endsWith('/secrets')) return new Response(JSON.stringify({ names: [NAME] }), { status: 200 });
		return new Response(JSON.stringify({}), { status: 200 });
	}));
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
	for (let i = 0; i < 6; i++) { await new Promise((r) => setTimeout(r, 0)); await tick(); flushSync(); }
}

/** Opens the edit row of the one listed name, types a value, saves, and returns the shown error. */
async function editAndSave(view: unknown): Promise<string> {
	component = mount(view, { target });
	await settle();
	const edit = [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Edit');
	expect(edit, 'edit button').toBeDefined();
	edit!.click();
	flushSync();
	const input = target.querySelector('input[type="password"]') as HTMLInputElement;
	input.value = 'typed-value';
	input.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
	const save = [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save');
	save!.click();
	await settle();
	return target.querySelector('.text-danger.mb-4')?.textContent?.trim() ?? '';
}

const VIEWS = [
	['SecretsView', async () => (await import('./SecretsView.svelte')).default, 'This name is platform-managed'],
	['KeysView', async () => (await import('./KeysView.svelte')).default, 'Save failed'],
] as const;

describe('the settings views name the connection form for a built-in provider client secret', () => {
	it.each(VIEWS)('%s shows the form advice for the marked 403', async (_v, load) => {
		putReply = { status: 403, body: { error: 'x', code: 'preset_client_secret' } };
		expect(await editAndSave(await load())).toContain('Enter it under “App credentials” in its profile (Settings → APIs)');
	});

	it.each(VIEWS)('%s keeps its old message for an unmarked 403', async (_v, load, old) => {
		putReply = { status: 403, body: { error: 'Managed mode: …' } };
		const shown = await editAndSave(await load());
		expect(shown).toContain(old);
		expect(shown).not.toContain('App credentials');
	});
});

/** Types a name and a value into the add form, saves, and returns the shown error. */
async function addAndSave(view: unknown, nameField: string, valueField: string): Promise<string> {
	component = mount(view, { target });
	await settle();
	const name = target.querySelector(nameField) as HTMLInputElement;
	name.value = NAME;
	name.dispatchEvent(new Event('input', { bubbles: true }));
	const value = target.querySelector(valueField) as HTMLInputElement;
	value.value = 'typed-value';
	value.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
	[...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save')!.click();
	await settle();
	return target.querySelector('.text-danger.mb-4')?.textContent?.trim() ?? '';
}

const ADD_FORMS = [
	['SecretsView', async () => (await import('./SecretsView.svelte')).default, '#secret-name', '#secret-value'],
	['KeysView', async () => (await import('./KeysView.svelte')).default, '#name', '#value'],
] as const;

describe('the add form of the settings views on a refused write', () => {
	it.each(ADD_FORMS)('%s names the connection form, keeps the value, and can save again', async (_v, load, nameField, valueField) => {
		putReply = { status: 403, body: { error: 'x', code: 'preset_client_secret' } };
		expect(await addAndSave(await load(), nameField, valueField)).toContain('Enter it under “App credentials” in its profile (Settings → APIs)');
		// Not taken for a save: the typed value stays, and the button is free again.
		expect((target.querySelector(valueField) as HTMLInputElement).value).toBe('typed-value');
		const save = [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save');
		expect(save?.disabled).toBe(false);
	});
});

describe('the edit row of the settings views on a refused write', () => {
	it.each(VIEWS)('%s stays open with its value, and can save again', async (_v, load) => {
		putReply = { status: 403, body: { error: 'x', code: 'preset_client_secret' } };
		await editAndSave(await load());
		const input = target.querySelector('input[type="password"]') as HTMLInputElement | null;
		expect(input?.value).toBe('typed-value');
		const save = [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save');
		expect(save?.disabled).toBe(false);
	});
});

describe('the API profiles view', () => {
	it('gives the connection form to the profiles on a built-in provider, each with its own id', async () => {
		const profile = (id: string, auth: unknown) => ({ id, name: `Profile ${id}`, base_url: 'https://api.example', description: 'd', auth });
		vi.stubGlobal('fetch', vi.fn(async (url: string) => {
			// The owner's session: the connection form is the owner's.
			if (String(url).endsWith('/config')) return new Response(JSON.stringify({ viewer: 'owner' }), { status: 200 });
			if (String(url).endsWith('/api-profiles')) {
				return new Response(JSON.stringify({ profiles: [
					profile('shop-admin', { type: 'oauth2', oauth: { preset_id: 'shopify' } }),
					profile('books', { type: 'oauth2', oauth: { preset_id: 'bexio' } }),
					profile('keyed', { type: 'bearer', oauth: { preset_id: 'shopify' } }),
					profile('own-app', { type: 'oauth2', oauth: {} }),
					profile('empty-preset', { type: 'oauth2', oauth: { preset_id: '' } }),
					profile('odd-preset', { type: 'oauth2', oauth: { preset_id: 7 } }),
					profile('no-auth', undefined),
				] }), { status: 200 });
			}
			return new Response(JSON.stringify({ error: 'x' }), { status: 403 });
		}));
		component = mount((await import('./ApiStoreView.svelte')).default, { target });
		await settle();

		const asked = (vi.mocked(fetch).mock.calls as Array<[string]>).map(([u]) => String(u)).filter((u) => u.endsWith('/client'));
		expect(asked.map((u) => u.replace(/^.*\/api-profiles\//, '')).sort()).toEqual(['books/client', 'shop-admin/client']);
	});
});
