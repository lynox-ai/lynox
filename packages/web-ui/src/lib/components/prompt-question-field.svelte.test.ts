import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// `svelte` resolves to its server entry under node, where `mount` throws. The component is compiled
// for the client, so it is mounted with the client entry, loaded by path.
const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element; props?: Record<string, unknown> }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;
const { default: PromptQuestionField } = await import('./PromptQuestionField.svelte');
const { setLocale } = await import('../i18n.svelte.js');

// jsdom does no layout. Each value line is LINE px high and stacked from the field's top; the field
// shows FIELD px of it and is scrolled by its own scrollTop, as a browser would lay it out.
const LINE = 23;
let fieldBottom = 100;
let fieldHeights = { client: 100, scroll: 0 };
let stackOver = 0;
const realRect = Element.prototype.getBoundingClientRect;
const realRaf = globalThis.requestAnimationFrame;
const realCaf = globalThis.cancelAnimationFrame;
const realRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
function frame(): void { const due = [...frames.values()]; frames.clear(); for (const cb of due) cb(0); }
function rect(top: number, bottom: number): DOMRect {
	return { top, bottom, height: bottom - top, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

let host: HTMLElement;
let stack: HTMLElement;
let app: Record<string, unknown> | null = null;
let tooLow = false;

const field = (): HTMLElement => host.querySelector<HTMLElement>('[data-prompt-field]')!;
const readMore = (): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>('[data-prompt-read-more]');

async function show(head: string, lines: string[]): Promise<void> {
	fieldHeights = { client: Math.min(fieldBottom, lines.length * LINE), scroll: lines.length * LINE };
	app = mount(PromptQuestionField, {
		target: host,
		props: { head, lines, get tooLow() { return tooLow; }, set tooLow(v: boolean) { tooLow = v; } },
	});
	flushSync();
	await tick();
	flushSync();
}
/** The person scrolls the field: it re-measures on the next frame. */
async function scrollFieldTo(top: number): Promise<void> {
	field().scrollTop = top;
	field().dispatchEvent(new Event('scroll'));
	frame();
	flushSync();
	await tick();
}

beforeEach(() => {
	setLocale('en');
	document.body.innerHTML = '';
	fieldBottom = 100;
	stackOver = 0;
	tooLow = false;
	Element.prototype.getBoundingClientRect = function (this: Element) {
		if (this.hasAttribute('data-prompt-field')) return rect(0, fieldBottom);
		if (this.hasAttribute('data-prompt-line')) {
			const f = this.closest<HTMLElement>('[data-prompt-field]')!;
			const i = [...f.children].indexOf(this);
			return rect(i * LINE - f.scrollTop, (i + 1) * LINE - f.scrollTop);
		}
		return rect(0, 0);
	};
	frames.clear();
	nextFrame = 1;
	(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe(): void {} unobserve(): void {} disconnect(): void {} };
	globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => { const id = nextFrame++; frames.set(id, cb); return id; };
	globalThis.cancelAnimationFrame = (id: number): void => { frames.delete(id); };
	for (const [prop, get] of [
		['clientHeight', function (this: HTMLElement) { return this.hasAttribute('data-prompt-field') ? fieldHeights.client : this.hasAttribute('data-chat-stack') ? 200 : 0; }],
		['scrollHeight', function (this: HTMLElement) { return this.hasAttribute('data-prompt-field') ? fieldHeights.scroll : this.hasAttribute('data-chat-stack') ? 200 + stackOver : 0; }],
	] as const) Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get });
	stack = document.createElement('div');
	stack.setAttribute('data-chat-stack', '');
	document.body.appendChild(stack);
	host = document.createElement('div');
	stack.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	Element.prototype.getBoundingClientRect = realRect;
	globalThis.requestAnimationFrame = realRaf;
	globalThis.cancelAnimationFrame = realCaf;
	(globalThis as { ResizeObserver?: unknown }).ResizeObserver = realRO;
	delete (HTMLElement.prototype as { clientHeight?: unknown }).clientHeight;
	delete (HTMLElement.prototype as { scrollHeight?: unknown }).scrollHeight;
});

const fourteen = Array.from({ length: 14 }, (_, i) => `rm -rf ./release/build-${i + 1}/artifacts`);

describe('a confirmation\'s question field at little height', () => {
	it('says how many of the value\'s lines lie below the field', async () => {
		await show('⚠ Command: delete files (cannot be undone) — "', fourteen);
		// 100 px show four lines whole (to 92 px); lines 5 to 14 end below the edge.
		expect(readMore()?.textContent).toBe('Read 10 more lines ↓');
		expect(readMore()?.getAttribute('aria-label')).toBe('Show more lines of the question');
		expect(host.querySelector('[data-prompt-fade]')).not.toBeNull();
	});

	it('counts a line cut in half at the edge, in the singular', async () => {
		fieldBottom = 105;
		await show('⚠ Command: delete files (cannot be undone) — "', fourteen.slice(0, 5));
		expect(readMore()?.textContent).toBe('Read 1 more line ↓');
	});

	it('says it in German on a German instance', async () => {
		setLocale('de');
		await show('⚠ Befehl: Dateien löschen (nicht rückgängig zu machen) — "', fourteen);
		expect(readMore()?.textContent).toBe('10 weitere Zeilen lesen ↓');
		expect(readMore()?.getAttribute('aria-label')).toBe('Weitere Zeilen der Frage anzeigen');
	});

	it('follows the scroll and goes away at the end', async () => {
		await show('⚠ Command: delete files (cannot be undone) — "', fourteen);
		await scrollFieldTo(4 * LINE);
		expect(readMore()?.textContent).toBe('Read 6 more lines ↓');
		await scrollFieldTo(14 * LINE - fieldBottom);
		expect(readMore()).toBeNull();
		expect(host.querySelector('[data-prompt-fade]')).toBeNull();
	});

	it('shows no hint for a question that fits', async () => {
		await show('', ['⚠ Command: git push (requires explicit user request) — "git push origin main"']);
		expect(readMore()).toBeNull();
	});

	it('scrolls on by the field\'s height when the hint is clicked', async () => {
		await show('⚠ Command: delete files (cannot be undone) — "', fourteen);
		let by: ScrollToOptions | undefined;
		field().scrollBy = ((o: ScrollToOptions) => { by = o; }) as HTMLElement['scrollBy'];
		readMore()!.click();
		expect(by?.top).toBe(fieldHeights.client);
	});

	it('keeps the head out of the scrolling field, above it', async () => {
		await show('⚠ Command: delete files (cannot be undone) — "', fourteen);
		const head = host.querySelector<HTMLElement>('[data-prompt-head]');
		expect(head?.textContent).toBe('⚠ Command: delete files (cannot be undone) — "');
		expect(field().contains(head)).toBe(false);
		expect(head!.compareDocumentPosition(field()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(field().textContent).not.toContain('Command');
	});

	it('says when not even four lines fit, so the card keeps its height', async () => {
		fieldBottom = 47;
		await show('⚠ Command: delete files (cannot be undone) — "', fourteen);
		expect(tooLow).toBe(true);
	});

	it('lets the card shrink while four lines fit', async () => {
		fieldBottom = 100;
		await show('⚠ Command: delete files (cannot be undone) — "', fourteen);
		expect(tooLow).toBe(false);
	});
});
