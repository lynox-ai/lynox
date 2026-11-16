import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getLocale, setLocale } from '../i18n.svelte.js';
import { clearContext, setContext } from '../stores/context-panel.svelte.js';

// The side panel names a tool call with the chat's word for it, not the tool's raw name.

// `svelte` resolves to its server entry under node, where `mount` throws. The component is compiled
// for the client, so it is mounted with the client entry, loaded by path.
const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element; props?: Record<string, unknown> }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
};
const { mount, unmount, flushSync } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

const localeBefore = getLocale();
let target: HTMLElement;
let component: Record<string, unknown> | undefined;

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	clearContext();
	setLocale(localeBefore);
});

describe('ContextPanel header for an api_setup call', () => {
	it.each([
		['de', 'API-Profile'],
		['en', 'API profiles'],
	] as const)('reads %s: %s', async (locale, label) => {
		setLocale(locale);
		setContext({ type: 'tool', toolName: 'api_setup', toolInput: { action: 'list' }, title: 'api_setup' });
		const ContextPanel = (await import('./ContextPanel.svelte')).default;
		component = mount(ContextPanel, { target });
		flushSync();
		const header = target.querySelector('aside span.text-xs.font-medium');
		expect(header?.textContent).toBe(label);
	});
});
