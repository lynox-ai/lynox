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
/** Where the field starts on the screen: not at 0, so a step measured from the screen's top and not the field's is caught. */
const FIELD_TOP = 40;
let fieldBottom = 100;
/** Screen lines each value line takes (1 unless the test wraps it). */
let wraps: number[] = [];
let fieldHeights = { client: 100, scroll: 0 };
let stackOver = 0;
const realRect = Element.prototype.getBoundingClientRect;
const realStyle = window.getComputedStyle;
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

type Seg = { kind: 'frame' | 'value'; text: string };
async function show(headIn: string | Seg[], lines: string[]): Promise<void> {
	const head: Seg[] = typeof headIn === 'string' ? (headIn ? [{ kind: 'frame', text: headIn }] : []) : headIn;
	const total = lines.reduce((a, _l, i) => a + (wraps[i] ?? 1) * LINE, 0);
	fieldHeights = { client: Math.min(fieldBottom, total), scroll: total };
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
	wraps = [];
	stackOver = 0;
	window.getComputedStyle = ((el: Element) => ({ lineHeight: el.hasAttribute('data-prompt-field') ? `${LINE}px` : '' })) as unknown as typeof window.getComputedStyle;
	tooLow = false;
	Element.prototype.getBoundingClientRect = function (this: Element) {
		if (this.hasAttribute('data-prompt-field')) return rect(FIELD_TOP, FIELD_TOP + fieldBottom);
		if (this.hasAttribute('data-prompt-line')) {
			const f = this.closest<HTMLElement>('[data-prompt-field]')!;
			const i = [...f.children].indexOf(this);
			const top = wraps.slice(0, i).reduce((a, w) => a + w * LINE, 0) + Math.max(0, i - wraps.length) * LINE;
			return rect(FIELD_TOP + top - f.scrollTop, FIELD_TOP + top + (wraps[i] ?? 1) * LINE - f.scrollTop);
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
	window.getComputedStyle = realStyle;
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
		// The visible text is the button's name, count included; the arrow is not read out.
		expect(readMore()?.hasAttribute('aria-label')).toBe(false);
		expect(readMore()?.querySelector('[aria-hidden="true"]')?.textContent).toBe('↓');
		expect(host.querySelector('[data-prompt-fade]')).not.toBeNull();
	});

	it('counts a line cut in half at the edge, in the singular', async () => {
		fieldBottom = 105;
		await show('⚠ Command: delete files (cannot be undone) — "', fourteen.slice(0, 5));
		expect(readMore()?.textContent).toBe('Read 1 more line ↓');
	});

	it('counts a long one-line value by the screen lines it still hides', async () => {
		wraps = [12];
		await show([{ kind: 'frame', text: '⚠ File access: "' }], [`/srv/${'d/'.repeat(150)}secret"`]);
		// 12 screen lines, 100 px show 4 of them and a third of the fifth: 8 screen lines still hidden.
		expect(readMore()?.textContent).toBe('Read 8 more lines ↓');
	});

	it('says it in German on a German instance', async () => {
		setLocale('de');
		await show('⚠ Befehl: Dateien löschen (nicht rückgängig zu machen) — "', fourteen);
		expect(readMore()?.textContent).toBe('10 weitere Zeilen lesen ↓');
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

	it('scrolls on to the line cut at the edge when the hint is clicked, so it stands whole at the top', async () => {
		await show('⚠ Command: delete files (cannot be undone) — "', fourteen);
		let by: ScrollToOptions | undefined;
		field().scrollBy = ((o: ScrollToOptions) => { by = o; }) as HTMLElement['scrollBy'];
		readMore()!.click();
		// 100 px show lines 1 to 4 whole (to 92 px); line 5 is cut and goes to the top.
		expect(by?.top).toBe(4 * LINE);
	});

	it('scrolls on to the first line that reaches under the fade, even by a little', async () => {
		const realOffset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
		Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get(this: HTMLElement) { return this.hasAttribute('data-prompt-fade') ? 32 : 0; } });
		try {
			await show('⚠ Command: delete files (cannot be undone) — "', fourteen);
			let by: ScrollToOptions | undefined;
			field().scrollBy = ((o: ScrollToOptions) => { by = o; }) as HTMLElement['scrollBy'];
			readMore()!.click();
			// The fade covers 68 to 100 px. Line 3 (46 to 69) reaches 1 px under it and goes to the top;
			// a step of the field less the fade (68) would cut it off at the top instead.
			expect(by?.top).toBe(2 * LINE);
		} finally {
			if (realOffset) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', realOffset);
			else delete (HTMLElement.prototype as { offsetHeight?: unknown }).offsetHeight;
		}
	});

	it('takes a line that ends right at the edge as seen', async () => {
		fieldBottom = 4 * LINE;
		await show('⚠ Command: delete files (cannot be undone) — "', fourteen);
		let by: ScrollToOptions | undefined;
		field().scrollBy = ((o: ScrollToOptions) => { by = o; }) as HTMLElement['scrollBy'];
		readMore()!.click();
		expect(by?.top).toBe(4 * LINE);
	});

	it('scrolls on from where the field already stands, not from its start', async () => {
		await show('⚠ Command: delete files (cannot be undone) — "', fourteen);
		await scrollFieldTo(30);
		let by: ScrollToOptions | undefined;
		field().scrollBy = ((o: ScrollToOptions) => { by = o; }) as HTMLElement['scrollBy'];
		readMore()!.click();
		// Scrolled by 30, the field shows to 130 px of the value: line 6 (115 to 138) is cut and goes to the top.
		expect(by?.top).toBe(5 * LINE - 30);
	});

	it('brings a line cut at the edge to the top even when it starts less than a line below the top', async () => {
		fieldBottom = 30;
		await show('⚠ Command: delete files (cannot be undone) — "', fourteen);
		await scrollFieldTo(10);
		let by: ScrollToOptions | undefined;
		field().scrollBy = ((o: ScrollToOptions) => { by = o; }) as HTMLElement['scrollBy'];
		readMore()!.click();
		// The field shows 10 to 40 px of the value; line 2 (23 to 46) starts 13 px below its top.
		expect(by?.top).toBe(LINE - 10);
	});

	it('reads one long wrapped value on by whole screen lines, to the one cut at the edge', async () => {
		wraps = [12];
		await show([{ kind: 'frame', text: '⚠ File access: "' }], [`/srv/${'d/'.repeat(150)}secret"`]);
		let by: ScrollToOptions | undefined;
		field().scrollBy = ((o: ScrollToOptions) => { by = o; }) as HTMLElement['scrollBy'];
		readMore()!.click();
		// 100 px show screen lines 1 to 4 whole; the fifth is cut and goes to the top.
		expect(by?.top).toBe(4 * LINE);
	});

	it('reads a long wrapped value on by whole screen lines from its own top when it is already scrolled', async () => {
		wraps = [12];
		await show([{ kind: 'frame', text: '⚠ File access: "' }], [`/srv/${'d/'.repeat(150)}secret"`]);
		await scrollFieldTo(30);
		let by: ScrollToOptions | undefined;
		field().scrollBy = ((o: ScrollToOptions) => { by = o; }) as HTMLElement['scrollBy'];
		readMore()!.click();
		// The line's top is 30 px above the field's; screen line 6 (115 to 138 of it) is cut at the edge.
		expect(by?.top).toBe(5 * LINE - 30);
	});

	it('reads one long wrapped value on to the screen line the fade cuts, where the fade is taller than a line', async () => {
		const realOffset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
		Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get(this: HTMLElement) { return this.hasAttribute('data-prompt-fade') ? 32 : 0; } });
		try {
			wraps = [12];
			await show([{ kind: 'frame', text: '⚠ File access: "' }], [`/srv/${'d/'.repeat(150)}secret"`]);
			let by: ScrollToOptions | undefined;
			field().scrollBy = ((o: ScrollToOptions) => { by = o; }) as HTMLElement['scrollBy'];
			readMore()!.click();
			// The fade covers 68 to 100 px: screen line 3 (46 to 69) reaches 1 px under it and goes to
			// the top; a step of the field less the fade (68) would leave it cut at the top.
			expect(by?.top).toBe(2 * LINE);
		} finally {
			if (realOffset) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', realOffset);
			else delete (HTMLElement.prototype as { offsetHeight?: unknown }).offsetHeight;
		}
	});

	it('watches each line too, so a field held at its full height still re-measures when its lines change size', async () => {
		const watched: Element[] = [];
		(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe(el: Element): void { watched.push(el); } unobserve(): void {} disconnect(): void {} };
		await show('⚠ Command: delete files (cannot be undone) — "', fourteen);
		const lines = [...host.querySelectorAll('[data-prompt-line]')];
		expect(lines).toHaveLength(14);
		for (const line of lines) expect(watched).toContain(line);
		expect(watched).toContain(field());
	});

	it('gives an empty line a break of its own, so it keeps its height and copies as one line', async () => {
		await show('⚠ Command: write a file — "', ['a', '', '', 'b']);
		const lines = [...host.querySelectorAll<HTMLElement>('[data-prompt-line]')];
		expect(lines.map((l) => [l.textContent, l.querySelectorAll('br').length])).toEqual([['a', 0], ['', 1], ['', 1], ['b', 0]]);
	});

	it('puts the hint on its own row under the field, where it covers no line', async () => {
		await show('⚠ Command: delete files (cannot be undone) — "', fourteen);
		const wrapper = field().parentElement!;
		expect(wrapper.contains(readMore())).toBe(false);
		expect(wrapper.compareDocumentPosition(readMore()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(readMore()!.className).not.toMatch(/\babsolute\b/);
		// The fade stays on the field.
		expect(wrapper.querySelector('[data-prompt-fade]')).not.toBeNull();
	});

	it('shows a short value in the head as a value, not merged into the frame', async () => {
		await show([{ kind: 'frame', text: '⚠ External tool "' }, { kind: 'value', text: 'Merge' }, { kind: 'frame', text: '": delete files (cannot be undone) — "' }], fourteen);
		const head = host.querySelector<HTMLElement>('[data-prompt-head]')!;
		expect(head.textContent).toBe('⚠ External tool "Merge": delete files (cannot be undone) — "');
		const values = [...head.querySelectorAll('[data-prompt-value]')].map((v) => v.textContent);
		expect(values).toEqual(['Merge']);
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
