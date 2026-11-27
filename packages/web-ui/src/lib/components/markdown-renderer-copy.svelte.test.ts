import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// "Copy text" on an artifact card in the chat: what it copies for each kind of card, what it says
// afterwards (in a chat that only reads, where the text goes next), and the card that gets none.

const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element; props?: Record<string, unknown> }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

vi.mock('shiki', () => ({
	codeToHtml: async (code: string) => `<pre class="shiki"><code>${code.replace(/</g, '&lt;')}</code></pre>`,
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

const toasts = vi.hoisted(() => [] as { text: string; kind: string }[]);
vi.mock('../stores/toast.svelte.js', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	addToast: (text: string, kind: string) => { toasts.push({ text, kind }); },
}));

const chat = vi.hoisted(() => ({ contained: false }));
vi.mock('../stores/chat.svelte.js', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getThreadContained: () => chat.contained,
}));

// Spelled in two parts: a module parser reads the comment opener as an HTML-like comment.
const OPEN = '<!' + '--';
const fence = (lang: string, body: string): string => '```' + lang + '\n' + body + '\n```';
const markdownCard = (title: string, body: string): string =>
	fence('artifact', `${OPEN} type: markdown -->\n${OPEN} title: ${title} -->\n${body}`);
const dataCard = (body: string): string => fence('artifact', `${OPEN} type: csv -->\n${OPEN} title: Liste -->\n${body}`);
const htmlCard = (body: string): string =>
	fence('html', `<!DOCTYPE html><html><head><title>Regel</title><style>p { color: red }</style></head><body>${body}</body></html>`);

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let written: string[];
let writeFails: boolean;

async function settle(ms = 0): Promise<void> {
	if (ms > 0) await new Promise((r) => setTimeout(r, ms));
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

async function render(content: string): Promise<void> {
	const { default: MarkdownRenderer } = await import('./MarkdownRenderer.svelte');
	component = mount(MarkdownRenderer, { target, props: { content } });
	// Past the 400 ms debounce of the rich blocks.
	await settle(500);
}

const copyButton = (): HTMLButtonElement | null => target.querySelector<HTMLButtonElement>('.artifact-container button[data-action="copy"]');

async function clickCopy(): Promise<void> {
	const btn = copyButton();
	if (!btn) throw new Error('no copy button');
	btn.click();
	await settle();
}

beforeEach(() => {
	toasts.length = 0;
	chat.contained = false;
	written = [];
	writeFails = false;
	Object.defineProperty(navigator, 'clipboard', {
		configurable: true,
		value: {
			writeText: async (text: string) => {
				if (writeFails) throw new Error('denied');
				written.push(text);
			},
		},
	});
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.restoreAllMocks();
});

describe('"Copy text" on an artifact card', () => {
	it('copies what lynox wrote in a markdown card, says so, and leaves the card closed', async () => {
		await render(markdownCard('Regeltext', '# Regel\n\nKürze jede Beschreibung auf drei Sätze.'));
		const btn = copyButton();
		expect(btn?.textContent).toMatch(/Text kopieren|Copy text/);
		expect(btn?.getAttribute('aria-label')).toMatch(/^(Regeltext kopieren|Copy Regeltext)$/);
		await clickCopy();
		expect(written).toEqual(['# Regel\n\nKürze jede Beschreibung auf drei Sätze.']);
		expect(toasts).toEqual([{ text: expect.stringMatching(/^(Kopiert|Copied)$/), kind: 'success' }]);
		expect(target.querySelector('.artifact-container')?.classList.contains('artifact-collapsed')).toBe(true);
	});

	it('says where the text goes next in a chat that only reads', async () => {
		chat.contained = true;
		await render(markdownCard('Regeltext', 'Kürze jede Beschreibung.'));
		await clickCopy();
		expect(written).toEqual(['Kürze jede Beschreibung.']);
		expect(toasts.map((x) => x.text)).toEqual([expect.stringMatching(/neuen Chat ins Eingabefeld|input of the new chat/)]);
	});

	it('copies the file of a data card as it is', async () => {
		await render(dataCard('sku,title\nA1,Teekanne'));
		await clickCopy();
		expect(written).toEqual(['sku,title\nA1,Teekanne']);
	});

	it('copies the text an html card shows, without its tags, styles or scripts', async () => {
		await render(htmlCard('<h1>Regel</h1><p>Drei Sätze je Beschreibung.</p><script>window.secret = 1;</script><table><tr><td>A1</td><td>Teekanne</td></tr></table>'));
		await clickCopy();
		expect(written).toEqual(['Regel\n\nDrei Sätze je Beschreibung.\n\nA1\tTeekanne']);
	});

	it('gives an html card that shows no text no copy button', async () => {
		await render(htmlCard('<svg width="10" height="10"><rect width="10" height="10"/></svg><script>draw();</script>'));
		expect(target.querySelector('.artifact-container'), 'positive control: the card is there').not.toBeNull();
		expect(copyButton()).toBeNull();
	});

	it('says that copying failed, and nothing else, when the clipboard refuses', async () => {
		writeFails = true;
		await render(markdownCard('Regeltext', 'Kürze jede Beschreibung.'));
		await clickCopy();
		expect(written).toEqual([]);
		expect(toasts).toEqual([{ text: expect.stringMatching(/Kopieren hat nicht geklappt|Could not copy/), kind: 'error' }]);
	});
});
