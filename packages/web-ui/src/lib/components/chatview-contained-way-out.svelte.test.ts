import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readable } from 'svelte/store';

// The way out of a chat that only reads, as ChatView draws it: the line under the run that made
// the chat read-only, the bar above the input while it stays so, the button under a refused store
// write or bulk plan (keyed on the reason, not on the text), and the new chat it opens with the
// user's words in the input, unsent.

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
let contained: boolean;
let runBodies: Array<Record<string, unknown>>;

function serve(events: Array<[string, Record<string, unknown>]>): void {
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith('/sessions')) return json({ sessionId: 't1' });
		if (url.endsWith('/run')) {
			runBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			const enc = new TextEncoder();
			const body = new ReadableStream<Uint8Array>({
				start(c) {
					for (const [name, data] of events) c.enqueue(enc.encode(`event: ${name}\ndata: ${JSON.stringify({ agent: 'lynox', ...data })}\n\n`));
					c.enqueue(enc.encode(`event: done\ndata: ${JSON.stringify({ agent: 'lynox' })}\n\n`));
					c.close();
				},
			});
			return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
		}
		if (url.endsWith('/threads/t1')) return json({ thread: { skip_extraction: contained ? 1 : 0, contained } });
		if (url.endsWith('/runs/active')) return json({ runs: [] });
		if (url.endsWith('/threads/t1/messages')) return json({ messages: [] });
		if (url.endsWith('/artifacts')) return json({ artifacts: [] });
		return json({});
	}));
}

/** One refused call, with the reason the engine streams (or none). */
const refused = (contained?: string): Array<[string, Record<string, unknown>]> => [
	['tool_call', { name: 'http_request', input: { url: 'https://shop.myshopify.com/admin/api/2025-01/products/1.json', method: 'PUT' } }],
	['tool_result', { name: 'http_request', result: 'Not sent: this chat only reads.', isError: true, ...(contained ? { contained } : {}) }],
];

async function turnThenRender(text: string, events: Array<[string, Record<string, unknown>]>): Promise<void> {
	serve(events);
	await store.sendMessage(text, undefined, undefined, { typed: true });
	await settle();
	const { default: ChatView } = await import('./ChatView.svelte');
	component = svelte.mount(ChatView, { target });
	svelte.flushSync();
	await settle();
}

const buttons = (): Element[] => [...target.querySelectorAll('[data-plan-new-chat]')];
const inHistory = (): Element[] => buttons().filter((b) => !b.closest('[data-contained-bar]'));

beforeEach(async () => {
	vi.stubGlobal('navigator', { onLine: true });
	vi.resetModules();
	svelte = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;
	store = await import('../stores/chat.svelte.js');
	target = document.createElement('div');
	document.body.appendChild(target);
	contained = false;
	runBodies = [];
});

afterEach(() => {
	if (component) svelte.unmount(component);
	component = undefined;
	target.remove();
	store.newChat();
	vi.unstubAllGlobals();
});

describe('ChatView in a chat that only reads', () => {
	it('shows the line under the run that made it read-only, and the bar above the input', async () => {
		contained = true;
		await turnThenRender('Zeig mir Produkte mit schwachen Beschreibungen', []);
		expect(target.querySelectorAll('[data-contained-notice]')).toHaveLength(1);
		expect(target.querySelector('[data-contained-bar]')).not.toBeNull();
	});

	it('shows neither in a chat that does not', async () => {
		await turnThenRender('Hallo', []);
		expect(target.querySelector('[data-contained-notice]')).toBeNull();
		expect(target.querySelector('[data-contained-bar]')).toBeNull();
		expect(buttons()).toEqual([]);
	});

	it('puts the button under a refused store write, keyed on the reason', async () => {
		contained = true;
		await turnThenRender('Verbessere die', refused('contained_write'));
		// The line and the reply each carry one; the bar its own.
		expect(inHistory()).toHaveLength(2);
	});

	it('puts the button under a refused bulk plan', async () => {
		contained = true;
		await turnThenRender('Verbessere die', refused('contained_plan'));
		expect(inHistory()).toHaveLength(2);
	});

	it('puts none under another refused call, or a refusal whose text alone says so', async () => {
		contained = true;
		await turnThenRender('Schick das per Mail', refused('contained_call'));
		expect(inHistory(), 'only the line carries one').toHaveLength(1);
		component && svelte.unmount(component);
		component = undefined;
		store.newChat();
		target.replaceChildren();
		await turnThenRender('Verbessere die', refused());
		expect(inHistory(), 'only the line carries one').toHaveLength(1);
	});

	it('opens a new chat with the user\'s words in the input, unsent, and the line that says where it came from', async () => {
		contained = true;
		await turnThenRender('Verbessere die Beschreibungen', refused('contained_write'));
		const sent = runBodies.length;
		(target.querySelector('[data-contained-bar] [data-plan-new-chat]') as HTMLButtonElement).click();
		svelte.flushSync();
		await settle();
		const input = target.querySelector('textarea') as HTMLTextAreaElement;
		expect(input.value).toBe('Verbessere die Beschreibungen');
		expect(runBodies.length, 'nothing is sent by opening it').toBe(sent);
		expect(target.querySelector('[data-contained-bar]')).toBeNull();
		expect(target.querySelector('[data-contained-origin]')).not.toBeNull();
		expect(target.querySelector('[data-contained-removed-hidden]')).toBeNull();
	});

	it('says so when hidden characters were taken out of the copied text', async () => {
		contained = true;
		await turnThenRender('Verbessere die' + String.fromCodePoint(0xe0041, 0xe0042), []);
		(target.querySelector('[data-contained-bar] [data-plan-new-chat]') as HTMLButtonElement).click();
		svelte.flushSync();
		await settle();
		expect((target.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Verbessere die');
		expect(target.querySelector('[data-contained-removed-hidden]')).not.toBeNull();
	});
});
