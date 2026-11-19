import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readable } from 'svelte/store';

// Register 1112, ux U-091, as ChatView draws it: a chat the engine refuses this reader shows the
// reason in the page's language where the history would be, not the empty start page; a live run
// it refuses shows the reason above the input, with the history kept.

const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
};
let svelte: SvelteClient;

vi.mock('$app/stores', () => ({ page: readable({ url: new URL('http://localhost/app') }) }));
vi.mock('$app/navigation', () => ({
	goto: vi.fn(), afterNavigate: vi.fn(), beforeNavigate: vi.fn(), onNavigate: vi.fn(), invalidate: vi.fn(), invalidateAll: vi.fn(),
}));
vi.mock('./MarkdownRenderer.svelte', () => ({
	default: (anchor: Comment, props: { content: string }) => {
		const el = document.createElement('div');
		el.className = 'md-probe';
		el.textContent = props.content;
		anchor.before(el);
	},
}));

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const settle = async (): Promise<void> => { for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0)); };

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let store: typeof import('../stores/chat.svelte.js');
let t: (key: string) => string;

function serve(route: (url: string) => Response | undefined): void {
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
		const url = String(input);
		const r = route(url);
		if (r) return r;
		if (url.endsWith('/sessions')) return json({ sessionId: 'shop' });
		if (url.endsWith('/runs/active')) return json({ runs: [] });
		if (url.endsWith('/artifacts')) return json({ artifacts: [] });
		return json({});
	}));
}

async function openThenRender(id: string): Promise<void> {
	await store.resumeThread(id);
	await settle();
	const { default: ChatView } = await import('./ChatView.svelte');
	component = svelte.mount(ChatView, { target });
	svelte.flushSync();
	await settle();
}

beforeEach(async () => {
	vi.stubGlobal('navigator', { onLine: true });
	vi.resetModules();
	svelte = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;
	store = await import('../stores/chat.svelte.js');
	t = (await import('../i18n.svelte.js')).t;
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	if (component) svelte.unmount(component);
	component = undefined;
	target.remove();
	store.newChat();
	vi.unstubAllGlobals();
});

describe('ChatView on a chat this reader may not read', () => {
	it('shows the reason where the history would be', async () => {
		// Refused where opening a chat is refused: `POST /sessions`.
		serve((url) => (url.endsWith('/sessions') ? json({ error: 'engine sentence', code: 'contained_thread' }, 403) : undefined));
		await openThenRender('shop');
		expect(target.querySelector('[data-thread-read-refused]')?.textContent).toBe(t('contained.thread_read_refused'));
		expect(target.textContent).not.toContain('engine sentence');
		expect(target.querySelector('[data-thread-read-refused-bar]')).toBeNull();
	});

	it('shows nothing of it on a chat it may read', async () => {
		serve((url) => (url.includes('/threads/notes/messages') ? json({ messages: [], activeRun: null }) : undefined));
		await openThenRender('notes');
		expect(target.querySelector('[data-thread-read-refused]')).toBeNull();
		expect(target.querySelector('[data-thread-read-refused-bar]')).toBeNull();
	});

	it('a refused live run: the reason above the input, the history kept', async () => {
		serve((url) => {
			if (url.includes('/threads/mine/messages')) return json({ messages: [{ role: 'user', content: 'hi' }], activeRun: { runId: 'r1', status: 'running', lastPersistedSeq: 0 } });
			if (url.includes('/runs/r1/stream')) return json({ error: 'engine sentence', code: 'run_chat_unknown' }, 403);
			return undefined;
		});
		await openThenRender('mine');
		expect(target.querySelector('[data-thread-read-refused-bar]')?.textContent).toBe(t('contained.run_chat_unknown'));
		expect(target.querySelector('[data-thread-read-refused]')).toBeNull();
	});
});
