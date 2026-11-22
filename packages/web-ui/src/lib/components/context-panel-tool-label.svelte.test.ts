import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getLocale, setLocale, t } from '../i18n.svelte.js';
import { clearContext, setContext } from '../stores/context-panel.svelte.js';
import { toolCallLabel } from '../utils/tool-call-label.js';

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

/**
 * The tools the engine defines by a literal name, read from its sources: `definition: { name: '…' }`.
 * A tool named by a constant or built at run time is not found here.
 */
function registeredToolNames(): string[] {
	// The test runs from the repo root or from this package; the engine's sources sit at the root.
	let root = process.cwd();
	while (!existsSync(join(root, 'src/tools/builtin')) && dirname(root) !== root) root = dirname(root);
	const engineSrc = join(root, 'src');
	const names = new Set<string>();
	for (const entry of readdirSync(engineSrc, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
		const text = readFileSync(join(entry.parentPath, entry.name), 'utf8');
		for (const m of text.matchAll(/definition:\s*\{\s*name:\s*'([a-z_]+)'/g)) names.add(m[1]!);
	}
	return [...names].sort();
}

describe('ContextPanel header for every tool defined by a literal name', () => {
	const tools = registeredToolNames();

	it('finds the engine\'s tools', () => {
		// A broken scan would pass every check below on an empty list.
		expect(tools.length).toBeGreaterThan(50);
		expect(tools).toEqual(expect.arrayContaining(['api_setup', 'write_file', 'ask_user', 'plan_task', 'google_calendar']));
	});

	it.each(['de', 'en'] as const)('names each tool as the chat does (%s)', async (locale) => {
		setLocale(locale);
		const ContextPanel = (await import('./ContextPanel.svelte')).default;
		const differ: string[] = [];
		for (const name of tools) {
			setContext({ type: 'tool', toolName: name, toolInput: {}, title: name });
			component = mount(ContextPanel, { target });
			flushSync();
			const shown = target.querySelector('aside span.text-xs.font-medium')?.textContent;
			const chat = toolCallLabel(name, {}, t)?.action ?? name;
			if (shown !== chat) differ.push(`${name}: panel ${shown}, chat ${chat}`);
			unmount(component);
			component = undefined;
			clearContext();
		}
		expect(differ).toEqual([]);
	});

	it('names the tools the panel named before by the chat\'s word', () => {
		setLocale('de');
		expect(toolCallLabel('write_file', {}, t)?.action).toBe('Datei geschrieben');
		expect(toolCallLabel('ask_user', {}, t)?.action).toBe('Frage an dich');
		expect(toolCallLabel('plan_task', {}, t)?.action).toBe('Plan erstellt');
		expect(toolCallLabel('google_calendar', {}, t)?.action).toBe('Kalender');
	});
});
