import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setLocale, getLocale } from '../i18n.svelte.js';
import { noteSettingsViewer, providerResetNotice, resetSettingsViewer } from '../stores/settings-viewer.svelte.js';
import ProviderResetLine from './ProviderResetLine.svelte';

// `svelte` resolves to its server entry under node, where `mount` throws. The component is compiled
// for the client, so it is mounted with the client entry, loaded by path.
const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element; props?: Record<string, unknown> }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
};
const { mount, unmount, flushSync } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

// The engine put the provider back on Anthropic while the Shopify exchange is on. The line says why;
// the owner ends it with "Got it", a mandate reads it without the button.

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let locale: ReturnType<typeof getLocale>;

beforeEach(() => {
	locale = getLocale();
	resetSettingsViewer();
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	resetSettingsViewer();
	vi.unstubAllGlobals();
	setLocale(locale);
});

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
}

function show(viewer: 'owner' | 'mandate'): void {
	noteSettingsViewer({ viewer, locks: {}, provider_reset: { from: 'Mistral' } });
	component = mount(ProviderResetLine, { target });
	flushSync();
}

describe('the line about the provider the engine changed', () => {
	it('tells the owner in German, with the button that ends it', async () => {
		setLocale('de');
		vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200 })));
		show('owner');
		expect(target.textContent).toContain('lynox hat auf Anthropic gewechselt, weil Mistral auf dieser Instanz nicht verfügbar ist.');
		const button = target.querySelector('button');
		expect(button?.textContent).toBe('Verstanden');

		button!.click();
		await settle();
		expect(providerResetNotice()).toBeNull();
		expect(target.querySelector('[data-provider-reset]')).toBeNull();
	});

	it('tells the owner in English', () => {
		setLocale('en');
		show('owner');
		expect(target.textContent).toContain('lynox switched to Anthropic because Mistral is not available on this instance.');
		expect(target.querySelector('button')?.textContent).toBe('Got it');
	});

	it('shows a mandate the line without the button', () => {
		setLocale('de');
		show('mandate');
		expect(target.textContent).toContain('weil Mistral auf dieser Instanz nicht verfügbar ist.');
		expect(target.querySelector('button')).toBeNull();
	});

	it('shows nothing without a change', () => {
		noteSettingsViewer({ viewer: 'owner', locks: {}, provider_reset: null });
		component = mount(ProviderResetLine, { target });
		flushSync();
		expect(target.querySelector('[data-provider-reset]')).toBeNull();
	});

	it('asks the server again on mount and when the tab comes back, so a restart is seen without a reload', async () => {
		setLocale('de');
		const body = (reset: unknown): Response => new Response(JSON.stringify({ viewer: 'owner', locks: {}, provider_reset: reset }), { status: 200 });
		let answer: unknown = { from: 'Mistral' };
		const fetchMock = vi.fn(async () => body(answer));
		vi.stubGlobal('fetch', fetchMock);
		noteSettingsViewer({ viewer: 'owner', locks: {}, provider_reset: null });
		component = mount(ProviderResetLine, { target });
		await settle();
		expect(target.textContent).toContain('weil Mistral auf dieser Instanz nicht verfügbar ist.');

		answer = null;
		document.dispatchEvent(new Event('visibilitychange'));
		await settle();
		expect(target.querySelector('[data-provider-reset]')).toBeNull();

		answer = { from: 'Mistral' };
		window.dispatchEvent(new CustomEvent('lynox:provider-changed'));
		await settle();
		expect(target.querySelector('[data-provider-reset]')).not.toBeNull();
	});
});
