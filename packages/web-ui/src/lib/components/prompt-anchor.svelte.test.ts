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
const { default: PromptAnchor } = await import('./PromptAnchor.svelte');

// jsdom does no layout: each element's box is set by the test, as the browser would lay it out.
const boxes = new Map<Element, { top: number; bottom: number }>();
function place(el: Element, top: number, bottom: number): void { boxes.set(el, { top, bottom }); }
const realRect = Element.prototype.getBoundingClientRect;
const realRaf = globalThis.requestAnimationFrame;

let host: HTMLElement;
let stack: HTMLElement;
let app: Record<string, unknown> | null = null;

function card(kind = 'permission'): HTMLElement {
	const el = document.createElement('div');
	el.setAttribute('data-pending-prompt', '');
	el.setAttribute('data-prompt-kind', kind);
	el.textContent = 'Delete the release branch?';
	stack.appendChild(el);
	return el;
}
async function anchor(promptId = 'p1'): Promise<void> {
	app = mount(PromptAnchor, { target: host, props: { prompt: { kind: 'permission', question: 'Delete the release branch?', promptId }, promptCount: 1, runStartedAt: null } });
	flushSync();
	await tick();
}
/** The user scrolls (or the page changes): the bar re-measures on the next frame. */
async function scrolled(): Promise<void> {
	stack.dispatchEvent(new Event('scroll'));
	flushSync();
	await tick();
}
const bar = (): Element | null => host.querySelector('[data-prompt-anchor]');

beforeEach(() => {
	document.body.innerHTML = '';
	boxes.clear();
	Element.prototype.getBoundingClientRect = function (this: Element) {
		const b = boxes.get(this) ?? { top: 0, bottom: 0 };
		return { top: b.top, bottom: b.bottom, height: b.bottom - b.top, left: 0, right: 0, width: 0, x: 0, y: b.top, toJSON: () => ({}) } as DOMRect;
	};
	globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => { cb(0); return 1; };
	Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
	stack = document.createElement('div');
	stack.setAttribute('data-chat-stack', '');
	document.body.appendChild(stack);
	place(stack, 500, 800);
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	Element.prototype.getBoundingClientRect = realRect;
	globalThis.requestAnimationFrame = realRaf;
});

describe('the bar above the input points to a question that is off screen', () => {
	it('stays away while the question card is on screen, so the question shows once', async () => {
		place(card(), 520, 700);
		await anchor();
		expect(bar()).toBeNull();
	});

	it('shows, with the question, once the card\'s top has scrolled out of its stack, and goes when it is back', async () => {
		const c = card();
		place(c, 520, 900);
		await anchor();
		expect(bar()).toBeNull();
		place(c, 420, 800); // scrolled under the stack's top edge; the buttons still show
		await scrolled();
		expect(bar()?.textContent).toContain('Delete the release branch?');
		place(c, 520, 900);
		await scrolled();
		expect(bar()).toBeNull();
	});

	it('shows when the card\'s opening line is below the visible part', async () => {
		place(card(), 780, 1000);
		await anchor();
		expect(bar()).not.toBeNull();
	});

	it('follows the card when the next question replaces it', async () => {
		const first = card();
		place(first, 520, 700);
		await anchor();
		expect(bar()).toBeNull();
		first.remove();
		const second = card();
		place(second, 300, 700);
		await new Promise((r) => setTimeout(r, 0)); // the MutationObserver's delivery
		flushSync();
		await tick();
		expect(bar()).not.toBeNull();
	});

	it('shows when there is no card to point to, as it always did', async () => {
		await anchor();
		expect(bar()).not.toBeNull();
	});

	it('never takes the focus when it appears, and its button stays in the tab order', async () => {
		const c = card();
		const input = document.createElement('textarea');
		document.body.appendChild(input);
		input.focus();
		place(c, 520, 700);
		await anchor();
		place(c, 100, 700);
		await scrolled();
		expect(bar()).not.toBeNull();
		expect(document.activeElement).toBe(input);
		expect(bar()?.querySelector('button')?.tabIndex).toBe(0);
	});

	it('stops listening once it is gone', async () => {
		const c = card();
		place(c, 520, 700);
		await anchor();
		if (app) unmount(app);
		app = null;
		place(c, 100, 700);
		await scrolled();
		expect(host.querySelector('[data-prompt-anchor]')).toBeNull();
	});
});

describe('the bar\'s answer button', () => {
	it('takes the user to the card\'s top, where the question opens, and focuses the card', async () => {
		const c = card();
		c.tabIndex = -1;
		const calls: unknown[] = [];
		c.scrollIntoView = (arg?: boolean | ScrollIntoViewOptions): void => { calls.push(arg); };
		place(c, 100, 700);
		await anchor();
		(bar()?.querySelector('button') as HTMLButtonElement).click();
		expect(calls).toEqual([expect.objectContaining({ block: 'start' })]);
		expect(document.activeElement).toBe(c);
	});
});
