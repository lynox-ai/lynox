import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// `svelte` resolves to its server entry under node, where `mount` throws. The component is compiled
// for the client, so it is mounted with the client entry, loaded by path.
const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element; props?: Record<string, unknown> }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

// Built at run time, so no literal here has the shape of a credential.
const SECRET = ['typed', 'app', 'secret', String(Date.now())].join('-');

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let calls: Array<{ url: string; method: string; body: string | undefined; contentType: string | null }>;
let putStatus: number;
// Answers for the PUTs in order, each used once; when empty, `putStatus` decides. A string body
// is sent as it is, so a reply can be something that is not JSON.
let putReplies: Array<{ status: number; body: Record<string, unknown> | string }>;
// Set, the next PUT waits on it, so a test can look at the form while the save is under way.
let putHeld: Promise<void> | null;
// Set, the PUT fails as a network error would.
let putThrows: boolean;
let getStatus: number;
let getExtra: Record<string, unknown>;

beforeEach(async () => {
	// The texts asserted below are the English ones; the locale otherwise follows the machine.
	(await import('../i18n.svelte.js')).setLocale('en');
	target = document.createElement('div');
	document.body.appendChild(target);
	calls = [];
	putStatus = 200;
	putReplies = [];
	getStatus = 200;
	getExtra = {};
	putHeld = null;
	putThrows = false;
	vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
		const method = init?.method ?? 'GET';
		calls.push({ url: String(url), method, body: typeof init?.body === 'string' ? init.body : undefined, contentType: new Headers(init?.headers).get('Content-Type') });
		if (method === 'PUT') {
			if (putHeld) await putHeld;
			if (putThrows) throw new TypeError('Failed to fetch');
			const next = putReplies.shift();
			if (next) return new Response(typeof next.body === 'string' ? next.body : JSON.stringify(next.body), { status: next.status });
			return new Response(JSON.stringify(putStatus === 200 ? { ok: true } : { error: 'x' }), { status: putStatus });
		}
		if (getStatus !== 200) return new Response(JSON.stringify({ error: 'x' }), { status: getStatus });
		return new Response(JSON.stringify({
			preset: 'shopify', client_id_key: 'SHOPIFY_CLIENT_ID', client_secret_key: 'SHOPIFY_CLIENT_SECRET',
			client_id: null, client_secret_set: false, redirect_uri: 'https://tenant.example/api/oauth/callback',
			reads_other_names: false, ...getExtra,
		}), { status: 200, headers: { 'Content-Type': 'application/json' } });
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

async function open(profileId = 'shop-admin'): Promise<void> {
	const { default: PresetClientForm } = await import('./PresetClientForm.svelte');
	component = mount(PresetClientForm, { target, props: { profileId } });
	await settle();
}

function idInput(): HTMLInputElement {
	return target.querySelector<HTMLInputElement>('input[type="text"]')!;
}

function secretInput(): HTMLInputElement | null {
	return target.querySelector<HTMLInputElement>('[data-testid="preset-client-secret"]');
}

function type(input: HTMLInputElement, value: string): void {
	input.value = value;
	input.dispatchEvent(new Event('input'));
	flushSync();
}

function button(label: string): HTMLButtonElement | undefined {
	return [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
}

function puts(): Array<Record<string, unknown>> {
	return calls.filter((c) => c.method === 'PUT').map((c) => JSON.parse(c.body ?? '{}') as Record<string, unknown>);
}

function notice(): HTMLElement | null {
	return target.querySelector<HTMLElement>('[role="status"]');
}

async function fillAndSave(): Promise<void> {
	await open();
	type(idInput(), 'client-1');
	type(secretInput()!, SECRET);
	button('Save')!.click();
	await settle();
}

describe('PresetClientForm', () => {
	it('sends the secret once in the body, and renders it nowhere after the save', async () => {
		await fillAndSave();

		const put = calls.find((c) => c.method === 'PUT');
		expect(JSON.parse(put?.body ?? '{}')).toEqual({ client_id: 'client-1', client_secret: SECRET });
		expect(calls.every((c) => !c.url.includes(SECRET))).toBe(true);
		// The field is gone and nothing on the page holds the value.
		expect(target.querySelector('[data-testid="preset-client-secret"]')).toBeNull();
		expect([...target.querySelectorAll('input')].some((i) => i.value === SECRET)).toBe(false);
		expect(target.innerHTML).not.toContain(SECRET);
		expect(target.textContent).toContain('Client Secret is saved. Its value is not shown.');
		expect(target.textContent).toContain('Saved. You can connect now.');
	});

	it('says that only the owner may enter the app on a 403', async () => {
		putStatus = 403;
		await fillAndSave();

		expect(target.textContent).toContain('Only the owner of this instance can enter the app credentials.');
		expect(target.textContent).not.toContain('Saved. You can connect now.');
	});

	it('asks before replacing the app the other profiles use, and replaces it only on the confirmation', async () => {
		putReplies = [{ status: 409, body: { error: 'x', code: 'replaces_app' } }];
		await fillAndSave();

		expect(target.textContent).toContain('This replaces the app that all Shopify connections on this instance use.');
		expect(target.textContent).not.toContain('Saved. You can connect now.');
		const confirm = [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Replace app');
		expect(confirm, 'confirm button').toBeDefined();
		confirm!.click();
		await settle();

		const puts = calls.filter((c) => c.method === 'PUT').map((c) => JSON.parse(c.body ?? '{}') as Record<string, unknown>);
		expect(puts).toEqual([
			{ client_id: 'client-1', client_secret: SECRET },
			{ client_id: 'client-1', client_secret: SECRET, replace_app: true },
		]);
		expect(target.textContent).toContain('Saved. You can connect now.');
		expect(target.querySelector('[data-testid="preset-client-replace"]')).toBeNull();
	});

	it('shows no form for a profile that reads its app from names of its own', async () => {
		getExtra = { reads_other_names: true };
		const { default: PresetClientForm } = await import('./PresetClientForm.svelte');
		component = mount(PresetClientForm, { target, props: { profileId: 'shop-admin' } });
		await settle();

		expect(target.textContent).toContain('This profile uses app credentials that lynox stored differently in the past.');
		expect(target.querySelector('input')).toBeNull();
	});

	it('shows no form, only the owner-only note, when the engine refuses the read', async () => {
		getStatus = 403;
		const { default: PresetClientForm } = await import('./PresetClientForm.svelte');
		component = mount(PresetClientForm, { target, props: { profileId: 'shop-admin' } });
		await settle();

		expect(target.textContent).toContain('Only the owner of this instance can enter the app credentials.');
		expect(target.querySelector('input')).toBeNull();
	});

	it('keeps password managers away from the secret field', async () => {
		const { default: PresetClientForm } = await import('./PresetClientForm.svelte');
		component = mount(PresetClientForm, { target, props: { profileId: 'shop-admin' } });
		await settle();

		const secret = target.querySelector<HTMLInputElement>('[data-testid="preset-client-secret"]')!;
		expect(secret.getAttribute('autocomplete')).toBe('new-password');
		expect(secret.hasAttribute('data-1p-ignore')).toBe(true);
		expect(secret.getAttribute('data-lpignore')).toBe('true');
	});

	it('names the provider and shows the redirect address', async () => {
		const { default: PresetClientForm } = await import('./PresetClientForm.svelte');
		component = mount(PresetClientForm, { target, props: { profileId: 'shop-admin' } });
		await settle();

		expect(target.textContent).toContain('App credentials for Shopify');
		expect(target.textContent).toContain('https://tenant.example/api/oauth/callback');
	});

	it('says the load failed, and shows no form, when the engine answers with an error', async () => {
		getStatus = 500;
		await open();

		expect(target.textContent).toContain('Failed to load. Is the engine reachable?');
		expect(target.querySelector('input')).toBeNull();
	});

	it.each([
		['the owner-only note', 403, 'Only the owner of this instance can enter the app credentials.'],
		['a failed load', 500, 'Failed to load. Is the engine reachable?'],
	])('drops %s when it loads another profile that it can read', async (_label, status, text) => {
		getStatus = status;
		const props = $state({ profileId: 'shop-admin' });
		const { default: PresetClientForm } = await import('./PresetClientForm.svelte');
		component = mount(PresetClientForm, { target, props });
		await settle();
		expect(target.textContent).toContain(text);

		getStatus = 200;
		props.profileId = 'shop-other';
		await settle();
		expect(calls.at(-1)?.url).toMatch(/\/api-profiles\/shop-other\/client$/);
		expect(target.textContent).not.toContain(text);
		expect(target.querySelector('[data-testid="preset-client-form"]')).not.toBeNull();
	});

	it('asks for the profile by its id, encoded', async () => {
		await open('shop/admin');

		expect(calls[0]?.url).toMatch(/\/api-profiles\/shop%2Fadmin\/client$/);
	});

	it('fills in the stored client id, and keeps the stored secret behind the replace button', async () => {
		getExtra = { client_id: 'client-1', client_secret_set: true };
		await open();

		expect(idInput().value).toBe('client-1');
		expect(secretInput()).toBeNull();
		button('Replace Client Secret')!.click();
		flushSync();
		expect(secretInput()).not.toBeNull();
	});

	it('keeps the client id field plain text that no browser fills or checks', async () => {
		await open();

		expect(idInput().getAttribute('autocomplete')).toBe('off');
		expect(idInput().getAttribute('spellcheck')).toBe('false');
		expect(secretInput()!.type).toBe('password');
	});

	it.each([
		['no client id', '', SECRET],
		['a client id of spaces', '   ', SECRET],
		['no client secret', 'client-1', ''],
		['a client secret of spaces', 'client-1', '   '],
	])('does not save with %s', async (_label, id, secret) => {
		await open();
		type(idInput(), id);
		type(secretInput()!, secret);

		expect(button('Save')!.disabled).toBe(true);
	});

	it('saves the stored client id typed with spaces around it alone, trimmed and without the secret', async () => {
		getExtra = { client_id: 'client-1', client_secret_set: true };
		await open();
		type(idInput(), ' client-1 ');

		expect(button('Save')!.disabled).toBe(false);
		button('Save')!.click();
		await settle();
		expect(puts()).toEqual([{ client_id: 'client-1' }]);
		expect(calls.find((c) => c.method === 'PUT')?.contentType).toBe('application/json');
		// What is stored stays stored: the secret field stays closed.
		expect(secretInput()).toBeNull();
	});

	it('opens the secret field for a different client id, and closes it once the new app is saved', async () => {
		getExtra = { client_id: 'client-1', client_secret_set: true };
		await open();
		type(idInput(), 'client-2');
		expect(secretInput()).not.toBeNull();
		type(secretInput()!, SECRET);
		button('Save')!.click();
		await settle();

		expect(puts()).toEqual([{ client_id: 'client-2', client_secret: SECRET }]);
		expect(secretInput()).toBeNull();
	});

	it('empties and closes a replaced secret once it is saved', async () => {
		getExtra = { client_id: 'client-1', client_secret_set: true };
		await open();
		button('Replace Client Secret')!.click();
		flushSync();
		type(secretInput()!, SECRET);
		button('Save')!.click();
		await settle();

		expect(secretInput()).toBeNull();
		button('Replace Client Secret')!.click();
		flushSync();
		expect(secretInput()!.value).toBe('');
	});

	it('shows the save as under way, and takes no second click meanwhile', async () => {
		putReplies = [{ status: 409, body: { error: 'x', code: 'replaces_app' } }];
		await fillAndSave();
		const confirm = button('Replace app')!;
		let release!: () => void;
		putHeld = new Promise((r) => { release = r; });
		confirm.click();
		await settle();

		expect(button('Saving...')?.disabled).toBe(true);
		expect(confirm.disabled).toBe(true);
		release();
		await settle();
		expect(button('Save')).toBeDefined();
	});

	it('says a refused save in red, and a stored one in green', async () => {
		putStatus = 500;
		await fillAndSave();

		expect(notice()?.textContent).toBe('Saving failed. Nothing was changed.');
		expect(notice()?.className).toContain('text-danger');
		expect(target.textContent).not.toContain('Saved. You can connect now.');

		putStatus = 200;
		button('Save')!.click();
		await settle();
		expect(notice()?.textContent).toBe('Saved. You can connect now.');
		expect(notice()?.className).toContain('text-success');
		expect(notice()?.className).not.toContain('text-danger');
	});

	it('says the save failed when the request does not get through', async () => {
		putThrows = true;
		await fillAndSave();

		expect(notice()?.textContent).toBe('Saving failed. Nothing was changed.');
	});

	it('clears the last notice when the next answer is the question', async () => {
		putReplies = [{ status: 500, body: { error: 'x' } }, { status: 409, body: { error: 'x', code: 'replaces_app' } }];
		await fillAndSave();
		expect(notice()).not.toBeNull();
		button('Save')!.click();
		await settle();

		expect(target.querySelector('[data-testid="preset-client-replace"]')).not.toBeNull();
		expect(notice()).toBeNull();
	});

	it('takes the replace question only from a 409', async () => {
		putReplies = [{ status: 400, body: { error: 'x', code: 'replaces_app' } }];
		await fillAndSave();

		expect(target.querySelector('[data-testid="preset-client-replace"]')).toBeNull();
		expect(notice()?.textContent).toBe('Saving failed. Nothing was changed.');
	});

	it('drops the question when the confirmed save fails, also with a 409 that is not JSON', async () => {
		putReplies = [{ status: 409, body: { error: 'x', code: 'replaces_app' } }, { status: 409, body: 'not json' }];
		await fillAndSave();
		button('Replace app')!.click();
		await settle();

		expect(target.querySelector('[data-testid="preset-client-replace"]')).toBeNull();
		expect(notice()?.textContent).toBe('Saving failed. Nothing was changed.');
	});

	it('drops the question when the confirmed save answers with a server error', async () => {
		putReplies = [{ status: 409, body: { error: 'x', code: 'replaces_app' } }, { status: 500, body: { error: 'x' } }];
		await fillAndSave();
		button('Replace app')!.click();
		await settle();

		expect(target.querySelector('[data-testid="preset-client-replace"]')).toBeNull();
	});

	it.each([
		['the client id', () => idInput()],
		['the client secret', () => secretInput()!],
	])('asks again after an edit of %s', async (_label, field) => {
		putReplies = [{ status: 409, body: { error: 'x', code: 'replaces_app' } }];
		await fillAndSave();
		expect(target.querySelector('[data-testid="preset-client-replace"]')).not.toBeNull();
		type(field(), 'edited');

		expect(target.querySelector('[data-testid="preset-client-replace"]')).toBeNull();
	});

	it('swaps the form for the note when a save learns the profile reads names of its own', async () => {
		putReplies = [{ status: 409, body: { error: 'x', code: 'reads_other_names' } }];
		await fillAndSave();

		expect(target.querySelector('[data-testid="preset-client-other-names"]')?.textContent).toContain('This profile uses app credentials that lynox stored differently in the past.');
		expect(target.querySelector('input')).toBeNull();
	});
});
