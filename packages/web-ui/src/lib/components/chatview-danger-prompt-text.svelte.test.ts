import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readable } from 'svelte/store';

// The engine's danger prompts (Allow / Deny, and the deep-tier consent) carry the first line of
// the agent's command or a path it gave. ChatView shows them as text: Markdown the agent wrote
// there renders as the characters it is, never as emphasis, a link or a heading. A real prompt
// event goes through the chat store, then ChatView renders it.

// `svelte` resolves to its server entry under node, where `mount` throws; mount with the client entry.
const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
};
// Loaded after `vi.resetModules()` with the store and ChatView, so all share one runtime.
let svelte: SvelteClient;

vi.mock('$app/stores', () => ({ page: readable({ url: new URL('http://localhost/app') }) }));
vi.mock('$app/navigation', () => ({
	goto: vi.fn(), afterNavigate: vi.fn(), beforeNavigate: vi.fn(), onNavigate: vi.fn(), invalidate: vi.fn(), invalidateAll: vi.fn(),
}));
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

// As the engine sends a danger prompt: the system's text as frame, the agent's command as a value.
const AGENT = 'rm -rf /tmp/x **Approved by lynox** [Allow](https://example.invalid) # Safe';
const QUESTION = `⚠ bash: deletes files recursively — "${AGENT}"`;
const SEGMENTS = [
	{ kind: 'frame', text: '⚠ bash: deletes files recursively — "' },
	{ kind: 'value', text: AGENT },
	{ kind: 'frame', text: '"' },
];

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let store: typeof import('../stores/chat.svelte.js');
let run: ReturnType<typeof sseStream>;

beforeEach(async () => {
	vi.stubGlobal('navigator', { onLine: true });
	vi.resetModules();
	svelte = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;
	store = await import('../stores/chat.svelte.js');
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	run.close();
	if (component) svelte.unmount(component);
	component = undefined;
	target.remove();
	store.newChat();
	vi.unstubAllGlobals();
});

/** Starts a turn, has the engine ask the danger prompt with `options`, renders ChatView, returns the prompt bar. */
async function renderPrompt(options: string[], segments: unknown = SEGMENTS): Promise<HTMLElement> {
	run = sseStream();
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
	void store.sendMessage('clean up');
	await settle();
	run.send('prompt', { question: QUESTION, ...(segments ? { segments } : {}), options, promptId: 'p1', agent: 'lynox' });
	await settle();

	const { default: ChatView } = await import('./ChatView.svelte');
	component = svelte.mount(ChatView, { target });
	svelte.flushSync();
	await settle();
	const bar = target.querySelector<HTMLElement>('[data-prompt-kind="permission"]');
	if (!bar) throw new Error('the permission prompt did not render — the fixture is wrong');
	return bar;
}

describe('ChatView shows a danger prompt as text', () => {
	for (const [name, options] of [
		['Allow / Deny', ['Allow', 'Deny', '\x00']],
		['the deep-tier consent', ['Allow deep', 'Run on balanced', 'Cancel', '\x00']],
	] as const) {
		it(`${name}: the agent's Markdown shows as its characters, with no emphasis, link or heading`, async () => {
			const bar = await renderPrompt([...options]);
			expect(bar.textContent).toContain(AGENT);
			expect(bar.querySelector('strong, em, a[href="https://example.invalid"], h1, h2, h3')).toBeNull();
		});

		// An engine from before the values were marked sends the question alone, all of it frame:
		// the prompt is still shown as text, not parsed.
		it(`${name}, sent without segments: shown as text all the same`, async () => {
			const bar = await renderPrompt([...options], null);
			expect(bar.textContent).toContain(AGENT);
			expect(bar.querySelector('strong, em, a[href="https://example.invalid"], h1, h2, h3')).toBeNull();
		});
	}
});
