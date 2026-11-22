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

// An older engine asks a batch one question at a time (v1). Here the first question comes
// without its id: that answer is not sent, the open question comes back, and the batch stops,
// so the second answer is not sent to the question that came back.
describe('a v1 batch whose question has no id', () => {
	it('stops after the first answer: no answer of the batch is sent to the question that came back, and focus goes to the sentence', async () => {
		run = sseStream();
		const replies: unknown[] = [];
		const seen: string[] = [];
		vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = String(input);
			seen.push(url.replace(/^.*\/api/, ''));
			if (url.endsWith('/sessions')) return json({ sessionId: 't1' });
			if (url.endsWith('/sessions/t1/run')) return new Response(run.body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
			if (url.endsWith('/sessions/t1/reply')) { replies.push(JSON.parse(String(init?.body ?? '{}'))); return json({ ok: true }); }
			if (url.endsWith('/sessions/t1/pending-prompt')) {
				return json({ pending: true, promptType: 'ask_user', promptId: 'p-open', question: 'Send this mail?', options: ['Yes', 'No'] });
			}
			if (url.endsWith('/threads/t1')) return json({ thread: null });
			if (url.endsWith('/runs/active')) return json({ runs: [] });
			if (url.endsWith('/threads/t1/messages')) return json({ messages: [] });
			if (url.endsWith('/artifacts')) return json({ artifacts: [] });
			return json({});
		}));
		void store.sendMessage('plan it');
		await settle();
		run.send('tool_call', { id: 'tc1', name: 'ask_user', input: { questions: [
			{ question: 'First?', options: ['A', 'B'], header: 'One' },
			{ question: 'Second?', options: ['C', 'D'], header: 'Two' },
		] } });
		await settle();
		run.send('prompt', { question: 'First?', options: ['A', 'B'], agent: 'lynox' });
		await settle();

		const { default: ChatView } = await import('./ChatView.svelte');
		component = svelte.mount(ChatView, { target });
		svelte.flushSync();
		await settle();
		const dialog = target.querySelector<HTMLElement>('[data-pending-prompt]');
		if (!dialog || dialog.getAttribute('data-prompt-kind') !== 'tabs') throw new Error('the batch did not render — the fixture is wrong');
		const click = async (label: string): Promise<void> => {
			const b = [...target.querySelectorAll<HTMLButtonElement>('[data-pending-prompt] button')].find((x) => x.textContent?.replace(/\s+/g, ' ').trim() === label);
			if (!b) throw new Error(`no button "${label}" — the fixture is wrong`);
			b.click();
			svelte.flushSync();
			await settle();
		};
		const { t } = await import('../i18n.svelte.js');
		await click('A');
		await click(t('chat.send'));
		await click('C');
		await click(t('chat.send'));
		for (let i = 0; i < 10; i++) await settle();
		expect(replies, 'an answer of the batch was sent').toEqual([]);
		expect(store.getPendingPermission()?.promptId, `requests: ${seen.join(' ')}`).toBe('p-open');
		// The focus sits on the sentence, not on a button of the card that came back (U-346).
		expect(document.activeElement?.getAttribute('role'), 'focus is not on the sentence').toBe('alert');
	});
});
