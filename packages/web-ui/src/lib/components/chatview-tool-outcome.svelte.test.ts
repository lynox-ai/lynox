import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readable } from 'svelte/store';

// A tool row says ✓ only when the call did what was asked (U-291). A call that returned without
// doing it (a soft failure) shows a muted "unsuccessful" in place of the ✓; a hard error keeps ✗.
// Seeded as the server sends a reopened chat, so this is the state after a reload.

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

function message(toolCalls: Array<Record<string, unknown>>): unknown {
	return {
		seq: 0, role: 'assistant', content: '', created_at: '2026-11-16T10:00:00Z',
		blocks: toolCalls.map((_, index) => ({ type: 'tool_call', index })),
		toolCalls,
	};
}

describe('ChatView tool rows after a reload', () => {
	it('shows unsuccessful for a soft failure, ✗ for an error and ✓ for a done call, each with words for a screen reader', async () => {
		serve((url) => url.endsWith('/threads/t1/messages')
			? json({ messages: [message([
				{ name: 'api_setup', input: { action: 'create', id: 'shop' }, result: 'Error: nothing was saved.', status: 'done', unsuccessful: true },
				{ name: 'bash', input: { command: 'false' }, result: 'boom', status: 'error' },
				{ name: 'read_file', input: { path: 'notes.md' }, result: 'hello', status: 'done' },
			])] })
			: undefined);
		await openThenRender('t1');
		const rows = [...target.querySelectorAll('div.border-l-2')] as HTMLElement[];
		expect(rows.length).toBe(3);
		const [soft, hard, done] = rows as [HTMLElement, HTMLElement, HTMLElement];
		expect(soft.textContent).toContain(t('chat.tool.unsuccessful'));
		expect(soft.textContent).not.toContain('✓');
		expect(soft.textContent).not.toContain('✗');
		expect(soft.className).not.toContain('border-danger');
		expect(hard.textContent).toContain('✗');
		expect(hard.querySelector('.sr-only')?.textContent).toBe(t('chat.tool.status_error'));
		expect(done.textContent).toContain('✓');
		expect(done.querySelector('.sr-only')?.textContent).toBe(t('chat.tool.status_done'));
		expect(done.textContent).not.toContain(t('chat.tool.unsuccessful'));
	});

	it('one unsuccessful call in a folded row makes the row say so', async () => {
		serve((url) => url.endsWith('/threads/t1/messages')
			? json({ messages: [message([
				{ name: 'read_file', input: { path: 'a.md' }, result: 'a', status: 'done' },
				{ name: 'read_file', input: { path: 'b.md' }, result: 'missing', status: 'done', unsuccessful: true },
			])] })
			: undefined);
		await openThenRender('t1');
		const rows = [...target.querySelectorAll('div.border-l-2')] as HTMLElement[];
		expect(rows.length).toBe(1);
		expect(rows[0]!.textContent).toContain(t('chat.tool.unsuccessful'));
		expect(rows[0]!.textContent).not.toContain('✓');
	});
});
