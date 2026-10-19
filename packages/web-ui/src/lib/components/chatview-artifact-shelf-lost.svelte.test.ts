import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readable } from 'svelte/store';

// The artifact chips under the chat carry the same "content missing" badge as the gallery for an
// artifact whose file holds only the engine's placeholder (`lostOnSave`, set by the store), so the
// chat does not offer it as a document. A real turn goes through the chat store, the artifact list
// comes from `/artifacts`, then ChatView renders the shelf.

// `svelte` resolves to its server entry under node, where `mount` throws; mount with the client entry.
const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
};
// Loaded after `vi.resetModules()` with the stores and ChatView, so all share one runtime.
let svelte: SvelteClient;

vi.mock('$app/stores', () => ({ page: readable({ url: new URL('http://localhost/app') }) }));
vi.mock('$app/navigation', () => ({
	goto: vi.fn(), afterNavigate: vi.fn(), beforeNavigate: vi.fn(), onNavigate: vi.fn(), invalidate: vi.fn(), invalidateAll: vi.fn(),
}));
// The real renderer does not parse in this project's transform; nothing here reads it.
vi.mock('./MarkdownRenderer.svelte', () => ({
	default: (anchor: Comment, props: { content: string }) => {
		const el = document.createElement('div');
		el.textContent = props.content;
		anchor.before(el);
	},
}));

function sseStream(): { body: ReadableStream<Uint8Array>; send: (type: string, data: unknown) => void; close: () => void } {
	const enc = new TextEncoder();
	let ctrl!: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
	return {
		body,
		send: (type, data) => ctrl.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)),
		close: () => ctrl.close(),
	};
}

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const settle = async (): Promise<void> => { for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0)); };

const META = {
	description: '',
	type: 'markdown',
	createdAt: '2026-10-09T19:34:00.000Z',
	updatedAt: '2026-10-09T19:34:00.000Z',
	threadId: 't1',
	version: 1,
};
const LOST = { ...META, id: 'aaaaaaaa', title: 'Pitch', lostOnSave: true };
const FINE = { ...META, id: 'bbbbbbbb', title: 'Fine', createdAt: '2026-10-09T19:35:00.000Z' };

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let store: typeof import('../stores/chat.svelte.js');

beforeEach(async () => {
	vi.stubGlobal('navigator', { onLine: true });
	vi.resetModules();
	svelte = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;
	store = await import('../stores/chat.svelte.js');
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

/** Runs a turn in thread t1, renders ChatView with the given artifacts, opens the shelf, returns its chips. */
async function chips(artifacts: unknown[]): Promise<HTMLAnchorElement[]> {
	const run = sseStream();
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
		const url = String(input);
		if (url.endsWith('/sessions')) return json({ sessionId: 't1' });
		if (url.endsWith('/sessions/t1/run')) return new Response(run.body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
		if (url.endsWith('/threads/t1')) return json({ thread: null });
		if (url.endsWith('/runs/active')) return json({ runs: [] });
		if (url.endsWith('/threads/t1/messages')) return json({ messages: [] });
		if (url.endsWith('/artifacts')) return json({ artifacts });
		return json({});
	}));
	const turn = store.sendMessage('write the pitch');
	await settle();
	run.send('done', { agent: 'lynox' });
	run.close();
	await turn; await settle();

	const { default: ChatView } = await import('./ChatView.svelte');
	component = svelte.mount(ChatView, { target });
	svelte.flushSync();
	await settle();
	const toggle = [...target.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find((b) => /\d+ · /.test(b.textContent ?? ''));
	if (!toggle) throw new Error('the artifact shelf did not render — the fixture is wrong');
	toggle.click();
	svelte.flushSync();
	await settle();
	return [...target.querySelectorAll<HTMLAnchorElement>('a[href^="/app/artifacts?id="]')];
}

const chip = (all: HTMLAnchorElement[], id: string): HTMLAnchorElement => {
	const found = all.find((a) => a.getAttribute('href') === `/app/artifacts?id=${id}`);
	if (!found) throw new Error(`no chip for ${id}`);
	return found;
};

describe('the artifact chips under the chat mark an artifact whose content is missing', () => {
	it('the chip of a lost artifact carries the badge, the chip of a whole one does not', async () => {
		const all = await chips([LOST, FINE]);
		expect(all).toHaveLength(2);
		const lost = chip(all, 'aaaaaaaa');
		expect(lost.querySelector('[data-testid="artifact-chip-lost-badge"]')?.textContent).toMatch(/^(Content missing|Inhalt fehlt)$/);
		expect(lost.title).toMatch(/^Pitch — (Content missing|Inhalt fehlt)$/);
		const fine = chip(all, 'bbbbbbbb');
		expect(fine.querySelector('[data-testid="artifact-chip-lost-badge"]')).toBeNull();
		expect(fine.title).toBe('Fine');
	});
});
