import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readable } from 'svelte/store';

// The owner's introduction in an empty chat (ux 1148 cut): setting the instance up is the owner's,
// and the answers it asks for are saved through an owner-only route. A mandate's session never
// runs it, so nothing it types there can be lost on a refusal; the owner's session still does.

// `svelte` resolves to its server entry under node, where `mount` throws and `onMount` never runs.
// The component is compiled for the client, so the client entry, loaded by path, stands in for
// `svelte` here: for mounting, and for the `onMount` that loads the introduction's state.
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
// The renderer's own parse is not what this file tests.
vi.mock('./MarkdownRenderer.svelte', () => ({ default: () => {} }));

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const settle = async (): Promise<void> => { for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0)); };

let svelte: SvelteClient;
let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let t: (key: string) => string;
/** Every request other than a GET, as `METHOD path`. */
let writes: string[];
/** Holds `GET /api/config` until released, to look at the page while the answer is out. */
let configGate: Promise<void>;

async function renderFor(viewer: 'mandate' | 'owner'): Promise<void> {
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		const path = url.split('?')[0]!;
		if (init?.method !== undefined && init.method !== 'GET') {
			writes.push(`${init.method} ${path.replace(/^.*\/api/, '/api')}`);
			return json({ error: 'Only the owner of this instance can do this.' }, viewer === 'owner' ? 200 : 403);
		}
		if (path.endsWith('/onboarding/status')) return json({ knowledgeDone: false, skipped: false, durableMemory: false, firstSessionAt: null });
		if (path.endsWith('/config')) { await configGate; return json({ viewer }); }
		return json({});
	}));
	const { default: ChatView } = await import('./ChatView.svelte');
	component = svelte.mount(ChatView, { target });
	svelte.flushSync();
	await settle();
	svelte.flushSync();
}

beforeEach(async () => {
	vi.stubGlobal('navigator', { onLine: true });
	// No module reset: a component compiled for the client and the `svelte` it mounts with must be
	// one instance. The viewer is the only state shared across mounts, and it is reset here.
	svelte = (await import('svelte')) as unknown as SvelteClient;
	(await import('../stores/settings-viewer.svelte.js')).resetSettingsViewer();
	({ t } = await import('../i18n.svelte.js'));
	(await import('../i18n.svelte.js')).setLocale('de');
	target = document.createElement('div');
	document.body.appendChild(target);
	writes = [];
	configGate = Promise.resolve();
});

afterEach(() => {
	if (component) svelte.unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
});

describe('ChatView and the owner\'s introduction', () => {
	it('does not run it in a mandate\'s session, and writes none of its flags', async () => {
		await renderFor('mandate');
		expect(target.textContent).not.toContain(t('onboard.skip_onboarding'));
		expect(writes.filter((w) => w.includes('/onboarding/'))).toEqual([]);
	});

	it('does not show it while the server has not said whose session it is', async () => {
		let release!: () => void;
		configGate = new Promise((r) => { release = r; });
		await renderFor('owner');
		expect(target.textContent).not.toContain(t('onboard.skip_onboarding'));
		expect(writes.filter((w) => w.includes('/onboarding/'))).toEqual([]);
		release();
		await settle();
		svelte.flushSync();
		// Twin in the same test: the answer arrives, and the owner gets the introduction.
		expect(target.textContent).toContain(t('onboard.skip_onboarding'));
	});

	it('runs it in the owner\'s, and stamps the first session', async () => {
		await renderFor('owner');
		expect(target.textContent).toContain(t('onboard.skip_onboarding'));
		expect(writes).toContain('POST /api/onboarding/flags/first_session_at');
	});
});
