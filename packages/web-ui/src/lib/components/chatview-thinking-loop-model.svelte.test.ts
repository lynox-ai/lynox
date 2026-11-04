import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readable } from 'svelte/store';

// The thinking-loop note may add one line: that another main model can help, and where to pick it
// (ux U-116). It is a way out only for whom it is open: the owner, on an instance without
// `locks.provider`. A mandate cannot change the configuration, and a locked instance has no choice.

// As in chatview-onboarding-mandate: the client entry of `svelte` stands in for its server entry.
const CLIENT_ENTRY = vi.hoisted(() => {
	const { createRequire: req } = require('node:module') as typeof import('node:module');
	const { dirname: dir, join: jn } = require('node:path') as typeof import('node:path');
	return jn(dir(req(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
});
vi.mock('svelte', async () => import(/* @vite-ignore */ CLIENT_ENTRY));
type SvelteClient = {
	mount: (c: unknown, o: { target: Element }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
};

vi.mock('$app/stores', () => ({ page: readable({ url: new URL('http://localhost/app') }) }));
vi.mock('$app/navigation', () => ({
	goto: vi.fn(), afterNavigate: vi.fn(), beforeNavigate: vi.fn(), onNavigate: vi.fn(), invalidate: vi.fn(), invalidateAll: vi.fn(),
}));
vi.mock('./MarkdownRenderer.svelte', () => ({ default: () => {} }));

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const settle = async (): Promise<void> => { for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0)); };

let svelte: SvelteClient;
let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let t: (key: string) => string;

/** A thread whose last turn ended on the thinking-loop note, under `config` as `GET /api/config`. */
async function render(config: Record<string, unknown>, code = 'thinking_loop'): Promise<void> {
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
		const url = String(input);
		if (url.includes('/threads/loop/messages')) {
			return json({ messages: [{ role: 'user', content: 'Werte aus' }, { role: 'assistant', content: '', note: { code } }], activeRun: null });
		}
		if (url.endsWith('/config')) return json(config);
		if (url.endsWith('/onboarding/status')) return json({ knowledgeDone: true, skipped: true, durableMemory: false, firstSessionAt: 'x' });
		if (url.endsWith('/sessions')) return json({ sessionId: 'loop' });
		if (url.endsWith('/runs/active')) return json({ runs: [] });
		if (url.endsWith('/artifacts')) return json({ artifacts: [] });
		return json({});
	}));
	const store = await import('../stores/chat.svelte.js');
	await store.resumeThread('loop');
	await settle();
	const { default: ChatView } = await import('./ChatView.svelte');
	component = svelte.mount(ChatView, { target });
	svelte.flushSync();
	await settle();
	svelte.flushSync();
}

const line = (): Element | null => target.querySelector('[data-model-choice]');

beforeEach(async () => {
	vi.stubGlobal('navigator', { onLine: true });
	svelte = (await import('svelte')) as unknown as SvelteClient;
	(await import('../stores/settings-viewer.svelte.js')).resetSettingsViewer();
	({ t } = await import('../i18n.svelte.js'));
	(await import('../i18n.svelte.js')).setLocale('de');
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(async () => {
	if (component) svelte.unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
	localStorage.clear();
	(await import('../stores/chat.svelte.js')).newChat();
});

describe('the thinking-loop note and the choice of model', () => {
	it('the owner of an instance without a provider lock is told where to choose another model', async () => {
		await render({ viewer: 'owner', locks: {} });
		expect(target.textContent).toContain(t('chat.note.thinking_loop'));
		expect(line()?.textContent).toBe('Das hängt auch vom Modell ab: In den Einstellungen unter „Konfiguration“ › „Modell-Strategie“ kannst du eine andere wählen.');
	});

	it('on a managed instance too: its locks cover custom endpoints, limits and presets, not the choice of model', async () => {
		// The shape the server sends for a managed tier (http-api.ts, GET /api/config).
		await render({ viewer: 'owner', locks: {
			custom_provider_endpoints: { reason: 'managed-tier' },
			limits: { reason: 'managed-tier' },
			custom_endpoints: { reason: 'managed-tier' },
			tier_preset: { reason: 'managed-tier' },
		} });
		expect(line()).not.toBeNull();
	});

	it('not when the answer says nothing about the locks', async () => {
		await render({ viewer: 'owner' });
		expect(target.textContent).toContain(t('chat.note.thinking_loop'));
		expect(line()).toBeNull();
	});

	it('not on an instance whose provider is locked', async () => {
		await render({ viewer: 'owner', locks: { provider: { reason: 'managed-tier' } } });
		// Positive control in the same render: the note itself is there, only the line is not.
		expect(target.textContent).toContain(t('chat.note.thinking_loop'));
		expect(line()).toBeNull();
	});

	it('not in a mandate\'s session', async () => {
		await render({ viewer: 'mandate', locks: {} });
		expect(target.textContent).toContain(t('chat.note.thinking_loop'));
		expect(line()).toBeNull();
	});

	it('not while the server has not said whose session it is, nor under another note', async () => {
		await render({ locks: {} });
		expect(target.textContent).toContain(t('chat.note.thinking_loop'));
		expect(line()).toBeNull();
		svelte.unmount(component!);
		component = undefined;
		(await import('../stores/chat.svelte.js')).newChat();
		(await import('../stores/settings-viewer.svelte.js')).resetSettingsViewer();
		await render({ viewer: 'owner', locks: {} }, 'tool_loop_break');
		expect(target.textContent).toContain(t('chat.note.tool_loop_break'));
		expect(line()).toBeNull();
	});

	it('the English line names the same places', async () => {
		(await import('../i18n.svelte.js')).setLocale('en');
		await render({ viewer: 'owner', locks: {} });
		expect(line()?.textContent).toBe('This also depends on the model: under Settings › “Configuration” › “Model strategy” you can choose another one.');
		// The places it names are the labels the settings pages show.
		for (const key of ['nav.settings', 'settings.config', 'llm.preset.heading']) expect(line()?.textContent).toContain(t(key));
	});
});
