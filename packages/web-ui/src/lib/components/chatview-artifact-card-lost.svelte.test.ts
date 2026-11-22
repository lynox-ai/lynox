import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readable } from 'svelte/store';

// The wiring half of the inline card's "Content missing" badge: ChatView must take it from the
// store's flag on the saved artifact (`lostOnSave`, as the gallery and the chips show it) and write
// it into the card's fence. Not from the call's content: an older thread can hold the placeholder
// there while the file holds the document. A real turn goes through the chat store, then ChatView
// renders it. Setup as in chatview-artifact-card.svelte.test.ts.

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
async function renderSave(content: string, opts: { result: string; lostOnSave: boolean }): Promise<string[]> {
	const run = sseStream();
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
		const url = String(input);
		if (url.endsWith('/sessions')) return json({ sessionId: 't1' });
		if (url.endsWith('/sessions/t1/run')) return new Response(run.body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
		if (url.endsWith('/threads/t1')) return json({ thread: null });
		if (url.endsWith('/runs/active')) return json({ runs: [] });
		if (url.endsWith('/threads/t1/messages')) return json({ messages: [] });
		if (url.endsWith('/artifacts')) return json({ artifacts: [{ id: 'ab12cd34', title: 'Pitch', description: '', type: 'html', createdAt: '2026-10-09T19:34:00.000Z', updatedAt: '2026-10-09T19:34:00.000Z', threadId: 't1', version: 1, ...(opts.lostOnSave ? { lostOnSave: true } : {}) }] });
		return json({});
	}));
	const turn = store.sendMessage('write the pitch');
	await settle();
	run.send('tool_call', { name: 'artifact_save', input: { title: 'Pitch', content }, agent: 'lynox' });
	await settle();
	run.send('tool_result', { name: 'artifact_save', agent: 'lynox', result: opts.result });
	run.send('done', { agent: 'lynox' });
	run.close();
	await turn; await settle();

	// The list is loaded before the mount: the renderer mock above writes its content once and does
	// not follow a later prop change, where the real renderer does.
	const artifactsStore = await import('../stores/artifacts.svelte.js');
	await artifactsStore.loadArtifacts();
	expect(artifactsStore.getArtifacts(), 'the store holds the saved artifact').toHaveLength(1);
	const { default: ChatView } = await import('./ChatView.svelte');
	component = svelte.mount(ChatView, { target });
	svelte.flushSync();
	await settle();
	return [...target.querySelectorAll('.md-probe')].map((el) => el.textContent ?? '').filter((t) => t.includes(content));
}

const SAVED = 'Saved artifact "Pitch" (id: ab12cd34, v1).';

describe('ChatView marks the card of a save the store marks as lost', () => {
	it('writes the marker into the card when the store marks the artifact as lost', async () => {
		const cards = await renderSave(PLACEHOLDER, { result: SAVED, lostOnSave: true });
		expect(cards, 'positive control: the card is drawn').toHaveLength(1);
		expect(cards[0]).toContain('<!-- lynox-artifact-lost -->');
	});

	it('writes no marker when the call holds the placeholder but the store keeps the document', async () => {
		const cards = await renderSave(PLACEHOLDER, { result: SAVED, lostOnSave: false });
		expect(cards, 'positive control: the card is drawn').toHaveLength(1);
		expect(cards[0]).not.toContain('lynox-artifact-lost');
	});

	it('writes no marker when the result names no artifact id', async () => {
		const cards = await renderSave(PLACEHOLDER, { result: 'Saved artifact "Pitch".', lostOnSave: true });
		expect(cards, 'positive control: the card is drawn').toHaveLength(1);
		expect(cards[0]).not.toContain('lynox-artifact-lost');
	});
});
