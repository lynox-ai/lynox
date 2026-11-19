import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readable } from 'svelte/store';

// The button under an answer whose bulk_plan call recorded a run: it opens the run's page under
// Activity › Bulk runs, with the id the engine streamed (the ledger's, never the model's text), and
// the model's follow-up chips that name that id are not shown (U-361).

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
/** What `GET /api/config` answers: the line of a chat opened from a read-only one reads it. */
let config: Record<string, unknown>;
let configStatus: number;
/** What `/threads/t1/messages` returns: the server's transcript, which never carries the run id. */
let transcript: unknown[];

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
		if (url.endsWith('/threads/t1/messages')) return json({ messages: transcript });
		if (url.endsWith('/artifacts')) return json({ artifacts: [] });
		if (url.endsWith('/config')) return json(config, configStatus);
		return json({});
	}));
}

const RUN = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b';
const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

/** A bulk_plan call that recorded the run `runId` names, as the engine streams it. */
const planned = (runId: unknown): Array<[string, Record<string, unknown>]> => [
	['tool_call', { name: 'bulk_plan', input: { target_system: 'workspace', source_file: 'plan.json' } }],
	['tool_result', { name: 'bulk_plan', result: `Dry run recorded — nothing was written to any target.\nBulk run ${String(runId)} (workspace, phase previewed)` }],
	['bulk_run_planned', { runId }],
];

const chips = (...suggestions: Array<{ label: string; task: string }>): Array<[string, Record<string, unknown>]> => [
	['tool_call', { name: 'suggest_follow_ups', input: { suggestions } }],
];

const links = (): HTMLAnchorElement[] => [...target.querySelectorAll<HTMLAnchorElement>('a[data-open-bulk-run]')];
const chipLabels = (): string[] => [...target.querySelectorAll('button')]
	.map((b) => b.querySelector('span.block')?.textContent ?? '')
	.filter((l) => l !== '');

beforeEach(async () => {
	vi.stubGlobal('navigator', { onLine: true });
	vi.resetModules();
	svelte = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;
	store = await import('../stores/chat.svelte.js');
	target = document.createElement('div');
	document.body.appendChild(target);
	contained = false;
	runBodies = [];
	config = {};
	configStatus = 200;
	transcript = [];
});

afterEach(() => {
	if (component) svelte.unmount(component);
	component = undefined;
	target.remove();
	store.newChat();
	vi.unstubAllGlobals();
});

async function turnThenRender(text: string, events: Array<[string, Record<string, unknown>]>): Promise<void> {
	serve(events);
	await store.sendMessage(text, undefined, undefined, { typed: true });
	await settle();
	const { default: ChatView } = await import('./ChatView.svelte');
	component = svelte.mount(ChatView, { target });
	svelte.flushSync();
	await settle();
}

describe('the button that opens a bulk run bulk_plan recorded', () => {
	it.each([
		['de', 'Massenlauf öffnen'],
		['en', 'Open bulk run'],
	] as const)('links the answer to the run\'s page under Activity › Bulk runs, labelled in the interface\'s language (%s)', async (lang, label) => {
		const i18n = await import('../i18n.svelte.js');
		i18n.setLocale(lang);
		await turnThenRender('Plane den Lauf', planned(RUN));
		expect(links()).toHaveLength(1);
		expect(links()[0]!.getAttribute('href')).toBe(`/app/activity?tab=bulk&run=${RUN}`);
		expect(links()[0]!.textContent?.trim()).toBe(label);
		// Inside the answer it belongs to.
		expect(links()[0]!.closest('.ai-message-wrap')).not.toBeNull();
	});

	it('is not shown for an answer whose plan was refused, which streams no run', async () => {
		await turnThenRender('Hallo', [
			['tool_call', { name: 'bulk_plan', input: { target_system: 'workspace' } }],
			['tool_result', { name: 'bulk_plan', result: 'Error: Give exactly one of source_file, source_collection or source_list.' }],
		]);
		expect(links()).toEqual([]);
	});

	it.each([
		['a path', '../settings'],
		['an address', 'https://evil.example/run'],
		['a script', 'javascript:alert(1)'],
		['an id with a query', `${RUN}&tab=history`],
		['upper-case hex', RUN.toUpperCase()],
		['a number', 42],
	])('is not shown when the streamed id is not in the ledger\'s form (%s)', async (_kind, runId) => {
		await turnThenRender('Plane den Lauf', planned(runId));
		expect(links()).toEqual([]);
	});

	it('appears under the answer in a chat already on screen when the run is recorded', async () => {
		serve([...planned(RUN), ['text', { text: 'Geplant.' }]]);
		const { default: ChatView } = await import('./ChatView.svelte');
		component = svelte.mount(ChatView, { target });
		svelte.flushSync();
		await settle();
		expect(links()).toEqual([]);
		await store.sendMessage('Plane den Lauf', undefined, undefined, { typed: true });
		await settle();
		svelte.flushSync();
		expect(links().map((a) => a.getAttribute('href'))).toEqual([`/app/activity?tab=bulk&run=${RUN}`]);
	});

	it('stays on the server\'s answer whose bulk_plan call reported the run, when the page was reloaded mid-answer', async () => {
		await turnThenRender('Plane den Lauf', [...planned(RUN), ['text', { text: 'Geplant. Du findest ihn unter Aktivität.' }]]);
		// The server kept the answer only up to the tool round.
		transcript = [
			{ role: 'user', content: 'Plane den Lauf' },
			{ role: 'assistant', content: '', toolCalls: [{ name: 'bulk_plan', input: {}, status: 'done', result: `Dry run recorded.\nBulk run ${RUN} (workspace, phase previewed)` }] },
		];
		await new Promise((r) => setTimeout(r, 600));
		await store.resumeThread('t1');
		await settle();
		svelte.flushSync();
		expect(links().map((a) => a.getAttribute('href'))).toEqual([`/app/activity?tab=bulk&run=${RUN}`]);
	});

	it('opens the last run when one answer recorded two', async () => {
		await turnThenRender('Plane zwei Läufe', [...planned(OTHER), ...planned(RUN)]);
		expect(links().map((a) => a.getAttribute('href'))).toEqual([`/app/activity?tab=bulk&run=${RUN}`]);
	});

	it('drops the model\'s chips that name the run\'s id and keeps the others', async () => {
		await turnThenRender('Plane den Lauf', [
			...planned(RUN),
			...chips(
				{ label: `Stand von ${RUN.slice(0, 8)}`, task: `Zeig den Stand von Lauf ${RUN}` },
				{ label: 'Weitere Produkte', task: 'Plane dasselbe für die Kategorie Hunde' },
			),
		]);
		expect(chipLabels()).toEqual(['Weitere Produkte']);
	});

	it.each([
		['the thread is opened again', 'resumeThread'],
		['the view reconciles with the server', 'reconcileThread'],
	] as const)('stays on its answer when the chat takes the server\'s transcript (%s)', async (_kind, adopt) => {
		await turnThenRender('Plane den Lauf', [...planned(RUN), ['text', { text: 'Geplant.' }]]);
		expect(links()).toHaveLength(1);
		transcript = [{ role: 'user', content: 'Plane den Lauf' }, { role: 'assistant', content: 'Geplant.' }];
		// The chat keeps its copy in the browser half a second after a change; a thread opened again reads it.
		await new Promise((r) => setTimeout(r, 600));
		if (adopt === 'resumeThread') await store.resumeThread('t1');
		else await store.reconcileThread();
		await settle();
		svelte.flushSync();
		// The server's list replaced the local one: the answer is the server's row now.
		expect(store.getMessages().at(-1)).not.toHaveProperty('toolCalls');
		expect(links().map((a) => a.getAttribute('href'))).toEqual([`/app/activity?tab=bulk&run=${RUN}`]);
	});

	it('keeps the model\'s chips that name another run\'s id', async () => {
		await turnThenRender('Plane den Lauf', [
			...planned(RUN),
			...chips({ label: 'Alter Lauf', task: `Zeig den Stand von Lauf ${OTHER}` }),
		]);
		expect(chipLabels()).toEqual(['Alter Lauf']);
	});
});
