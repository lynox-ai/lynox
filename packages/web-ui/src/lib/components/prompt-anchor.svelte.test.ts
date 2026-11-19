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
const { findPromptFormByKind } = await import('../utils/pipeline-status.js');

// jsdom does no layout: each element's box is set by the test, as the browser would lay it out.
const boxes = new Map<Element, { top: number; bottom: number }>();
function place(el: Element, top: number, bottom: number): void { boxes.set(el, { top, bottom }); }
const realRect = Element.prototype.getBoundingClientRect;
const realRaf = globalThis.requestAnimationFrame;
const realCaf = globalThis.cancelAnimationFrame;
/** Queued animation frames: run only when the test says a frame has passed, as a browser would. */
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
function frame(): void { const due = [...frames.values()]; frames.clear(); for (const cb of due) cb(0); }

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
	frame();
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
	frames.clear();
	nextFrame = 1;
	globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => { const id = nextFrame++; frames.set(id, cb); return id; };
	globalThis.cancelAnimationFrame = (id: number): void => { frames.delete(id); };
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
	globalThis.cancelAnimationFrame = realCaf;
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
		frame();
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
		stack.dispatchEvent(new Event('scroll'));
		expect(frames.size).toBe(0);
		expect(host.querySelector('[data-prompt-anchor]')).toBeNull();
	});

	it('measures once per frame however often the stack scrolls', async () => {
		const c = card();
		place(c, 520, 700);
		await anchor();
		for (let i = 0; i < 5; i++) stack.dispatchEvent(new Event('scroll'));
		expect(frames.size).toBe(1);
	});

	it('keeps its listeners when the view changes, instead of setting them up again', async () => {
		const c = card();
		place(c, 520, 700);
		const added: string[] = [];
		const realAdd = document.addEventListener.bind(document);
		document.addEventListener = ((type: string, ...rest: unknown[]) => { added.push(type); return (realAdd as (...a: unknown[]) => void)(type, ...rest); }) as typeof document.addEventListener;
		try {
			await anchor();
			place(c, 100, 700);
			await scrolled();
			place(c, 520, 700);
			await scrolled();
			expect(added.filter((t) => t === 'scroll')).toHaveLength(1);
		} finally {
			document.addEventListener = realAdd;
		}
	});

	it('reads where the question opens, not the card\'s padding or workflow line above it', async () => {
		const c = card();
		const q = document.createElement('pre');
		q.setAttribute('data-prompt-question', '');
		c.appendChild(q);
		place(c, 480, 800); // the card's top line (padding, workflow name) is under the stack's edge…
		place(q, 520, 700); // …the question itself shows
		await anchor();
		expect(bar()).toBeNull();
		place(c, 520, 800);
		place(q, 470, 700); // the card's top shows, the question has gone under the edge
		await scrolled();
		expect(bar()).not.toBeNull();
	});

	it('is not steered by an element a chat message carries outside the prompt stack', async () => {
		const planted = document.createElement('div');
		planted.setAttribute('data-pending-prompt', '');
		planted.setAttribute('data-prompt-kind', 'permission');
		document.body.insertBefore(planted, stack);
		place(planted, 100, 200); // on screen
		const c = card();
		place(c, 300, 700); // the real question is under the stack's top edge
		await anchor();
		expect(bar()).not.toBeNull();
	});
});

describe('the bar\'s answer button', () => {
	it('scrolls only the stack, to the card\'s top where the question opens, and focuses the card', async () => {
		const c = card();
		c.tabIndex = -1;
		let intoView = 0;
		c.scrollIntoView = (): void => { intoView += 1; };
		const scrolls: unknown[] = [];
		stack.scrollTo = ((arg: ScrollToOptions) => { scrolls.push(arg); }) as typeof stack.scrollTo;
		stack.scrollTop = 200;
		place(c, 380, 900); // 120 px above the stack's top (500)
		await anchor();
		(bar()?.querySelector('button') as HTMLButtonElement).click();
		expect(scrolls).toEqual([expect.objectContaining({ top: 80 })]);
		expect(intoView).toBe(0); // the page and other scrolling parents stay where they are
		expect(document.activeElement).toBe(c);
	});
});

describe('finding the question\'s card', () => {
	it('looks only inside the prompt stack, so a chat message carrying the same marker is never taken', () => {
		const planted = document.createElement('div');
		planted.setAttribute('data-pending-prompt', '');
		planted.setAttribute('data-prompt-kind', 'permission');
		document.body.insertBefore(planted, stack);
		const c = card();
		expect(findPromptFormByKind(document, 'permission')).toBe(c);
		expect(findPromptFormByKind(document, null)).toBe(c);
	});

	it('finds nothing without a prompt stack', () => {
		stack.remove();
		const loose = document.createElement('div');
		loose.setAttribute('data-pending-prompt', '');
		document.body.appendChild(loose);
		expect(findPromptFormByKind(document, 'permission')).toBeNull();
	});
});
