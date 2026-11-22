import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readable } from 'svelte/store';

// The wiring half of the inline card's "Content missing" badge: ChatView must decide it from the
// save's content, the text the store measured, and write it into the card's fence. A save whose
// content was only the engine's placeholder succeeded before the save refused it, so older threads
// still hold such a save with a success result. A real turn goes through the chat store, then
// ChatView renders it. Setup as in chatview-artifact-card.svelte.test.ts.

// `svelte` resolves to its server entry under node, where `mount` throws; mount with the client entry.
const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
};
// Loaded after `vi.resetModules()` with the store and ChatView, so all three share one runtime.
let svelte: SvelteClient;

vi.mock('$app/stores', () => ({ page: readable({ url: new URL('http://localhost/app') }) }));
vi.mock('$app/navigation', () => ({
	goto: vi.fn(), afterNavigate: vi.fn(), beforeNavigate: vi.fn(), onNavigate: vi.fn(), invalidate: vi.fn(), invalidateAll: vi.fn(),
}));
// The real renderer does not parse in this project's transform; the card is a ```artifact fence
// handed to it as content, which is all these tests read.
vi.mock('./MarkdownRenderer.svelte', () => ({
	default: (anchor: Comment, props: { content: string }) => {
		const el = document.createElement('div');
		el.className = 'md-probe';
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

const DOC = '<h1>Pitch</h1><p>Three budget options.</p>';
// The engine's placeholder as a damaged file holds it (measured on a real instance: 176 bytes).
const PLACEHOLDER = '[evicted after successful save — 5251 chars. The artifact is persisted; its id and file path are in the tool result below. read_file that path if you need the content again.]';

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

/** Runs a turn with one `artifact_save` call and the given result (or none), then renders ChatView. */
async function renderSave(content: string): Promise<string[]> {
	const run = sseStream();
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
		const url = String(input);
		if (url.endsWith('/sessions')) return json({ sessionId: 't1' });
		if (url.endsWith('/sessions/t1/run')) return new Response(run.body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
		if (url.endsWith('/threads/t1')) return json({ thread: null });
		if (url.endsWith('/runs/active')) return json({ runs: [] });
		if (url.endsWith('/threads/t1/messages')) return json({ messages: [] });
		if (url.endsWith('/artifacts')) return json({ artifacts: [] });
		return json({});
	}));
	const turn = store.sendMessage('write the pitch');
	await settle();
	run.send('tool_call', { name: 'artifact_save', input: { title: 'Pitch', content }, agent: 'lynox' });
	await settle();
	run.send('tool_result', { name: 'artifact_save', agent: 'lynox', result: 'Saved artifact "Pitch" (id: ab12cd34, v1).' });
	run.send('done', { agent: 'lynox' });
	run.close();
	await turn; await settle();

	const { default: ChatView } = await import('./ChatView.svelte');
	component = svelte.mount(ChatView, { target });
	svelte.flushSync();
	await settle();
	return [...target.querySelectorAll('.md-probe')].map((el) => el.textContent ?? '').filter((t) => t.includes(content));
}

describe('ChatView marks the card of a save whose content was only the placeholder', () => {
	it('writes the marker into that card\'s fence', async () => {
		const cards = await renderSave(PLACEHOLDER);
		expect(cards, 'positive control: the card is drawn').toHaveLength(1);
		expect(cards[0]).toContain('<!-- lynox-artifact-lost -->');
	});

	it('writes no marker into the card of a document', async () => {
		const cards = await renderSave(DOC);
		expect(cards, 'positive control: the card is drawn').toHaveLength(1);
		expect(cards[0]).not.toContain('lynox-artifact-lost');
	});
});
