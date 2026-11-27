import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// The copy button on an artifact card in the chat: what it copies for each kind of card (the text
// a markdown card shows, the file of a data card), what it says afterwards, and the card that gets
// none. What the card cannot show, the copy cannot carry.

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

async function render(content: string, containedChat = false): Promise<void> {
	const { default: MarkdownRenderer } = await import('./MarkdownRenderer.svelte');
	component = mount(MarkdownRenderer, { target, props: { content, containedChat } });
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

const NBSP = String.fromCharCode(0xa0);

describe('the copy button on an artifact card', () => {
	it('copies the text a markdown card shows, says so, and leaves the card closed', async () => {
		await render(markdownCard('Regeltext', '# Regel\n\nKürze jede Beschreibung auf drei Sätze.'));
		const btn = copyButton();
		expect(btn?.textContent).toMatch(/^(Text kopieren|Copy text)$/);
		expect(btn?.getAttribute('aria-label')).toMatch(/^(Text kopieren: Regeltext|Copy text: Regeltext)$/);
		await clickCopy();
		expect(written).toEqual(['Regel\n\nKürze jede Beschreibung auf drei Sätze.']);
		expect(toasts).toEqual([{ text: expect.stringMatching(/^(Kopiert|Copied)$/), kind: 'success' }]);
		expect(target.querySelector('.artifact-container')?.classList.contains('artifact-collapsed')).toBe(true);
	});

	it('says where the text goes next in a chat that only reads', async () => {
		await render(markdownCard('Regeltext', 'Kürze jede Beschreibung.'), true);
		await clickCopy();
		expect(written).toEqual(['Kürze jede Beschreibung.']);
		expect(toasts.map((x) => x.text)).toEqual([expect.stringMatching(/^(Kopiert\. Füge ihn im neuen Chat ins Eingabefeld ein\.|Copied\. Paste it into the input of the new chat\.)$/)]);
	});

	it('shows a markdown card without style or class, so inline styles and classes hide nothing it copies', async () => {
		await render(markdownCard('Regeltext', '<p>Sichtbar.</p><p><span style="font-size:0">Klein.</span> <span class="sr-only">Klasse.</span></p>'));
		const shownBody = target.querySelector('.artifact-md-body');
		expect(shownBody?.textContent, 'positive control: the card shows its paragraphs').toContain('Sichtbar.');
		expect(shownBody?.querySelectorAll('[style], [class]')).toHaveLength(0);
		await clickCopy();
		// Both spans show in the card now, so the copy carries exactly what the card shows.
		expect(written).toEqual(['Sichtbar.\n\nKlein. Klasse.']);
	});

	it('leaves out what a markdown card does not show: hidden elements, a closed details, comments', async () => {
		await render(markdownCard('Regeltext', `<p>Sichtbar.</p><p hidden>Versteckt.</p><p aria-hidden="true">Stumm.</p><details><summary>Mehr</summary>Zugeklappt.</details>${OPEN} Kommentar -->`));
		await clickCopy();
		expect(written).toEqual(['Sichtbar.\n\nMehr']);
	});

	it('takes out the characters a reader does not see, and says so', async () => {
		const hidden = String.fromCodePoint(0x2028) + String.fromCodePoint(0xe0041) + String.fromCodePoint(0x200b);
		await render(markdownCard('Regeltext', `Kürze${hidden} jede Beschreibung.`));
		await clickCopy();
		expect(written).toEqual(['Kürze jede Beschreibung.']);
		expect(toasts.map((x) => x.text)).toEqual([expect.stringMatching(/^(Kopiert\. lynox hat unsichtbare Zeichen aus dem Text entfernt\.|Copied\. lynox removed invisible characters from the text\.)$/)]);
	});

	it('copies the file of a data card the preview shows in full', async () => {
		await render(dataCard('sku,title\nA1,Teekanne'));
		expect(copyButton()?.textContent).toMatch(/^(Text kopieren|Copy text)$/);
		expect(target.querySelector('.artifact-data-more')).toBeNull();
		await clickCopy();
		expect(written).toEqual(['sku,title\nA1,Teekanne']);
	});

	it('says on the button and in the toast how many lines it copies when the preview shows fewer', async () => {
		const rows = ['sku,title', ...Array.from({ length: 60 }, (_, i) => `A${i},Teekanne ${i}`)];
		await render(dataCard(rows.join('\n')));
		expect(copyButton()?.textContent).toMatch(new RegExp(`^(Alle 61${NBSP}Zeilen kopieren|Copy all 61${NBSP}lines)$`));
		expect(copyButton()?.getAttribute('aria-label')).toMatch(new RegExp(`^(Alle 61${NBSP}Zeilen kopieren: Liste|Copy all 61${NBSP}lines: Liste)$`));
		expect(target.querySelector('.artifact-data-more')?.textContent).toMatch(new RegExp(`^(60 von 61${NBSP}Zeilen angezeigt|60 of 61${NBSP}lines shown)$`));
		await clickCopy();
		expect(written).toEqual([rows.join('\n')]);
		expect(toasts.map((x) => x.text)).toEqual([expect.stringMatching(new RegExp(`^(Kopiert: 61${NBSP}Zeilen\\.|Copied: 61${NBSP}lines\\.)$`))]);
	});

	it('gives an html card no copy button', async () => {
		await render(htmlCard('<h1>Regel</h1><p>Drei Sätze je Beschreibung.</p>'));
		expect(target.querySelector('.artifact-container button[data-action="expand"]'), 'positive control: the card and its buttons are there').not.toBeNull();
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
