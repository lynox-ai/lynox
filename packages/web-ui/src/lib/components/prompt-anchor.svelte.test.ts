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

/** A stand-in IntersectionObserver: the test says what the browser would report for each target. */
class FakeIO {
	static all: FakeIO[] = [];
	readonly targets = new Set<Element>();
	constructor(private readonly cb: (entries: unknown[]) => void) { FakeIO.all.push(this); }
	observe(el: Element): void { this.targets.add(el); }
	unobserve(el: Element): void { this.targets.delete(el); }
	disconnect(): void { this.targets.clear(); }
	report(el: Element, visiblePx: number, heightPx = 300): void {
		if (!this.targets.has(el)) return;
		this.cb([{ target: el, isIntersecting: visiblePx > 0, intersectionRect: { height: visiblePx }, boundingClientRect: { height: heightPx } }]);
	}
}
function report(el: Element, visiblePx: number, heightPx?: number): void {
	for (const io of FakeIO.all) io.report(el, visiblePx, heightPx);
	flushSync();
}

const realIO = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
let host: HTMLElement;
let app: Record<string, unknown> | null = null;

function card(kind = 'permission'): HTMLElement {
	const el = document.createElement('div');
	el.setAttribute('data-pending-prompt', '');
	el.setAttribute('data-prompt-kind', kind);
	el.textContent = 'Delete the release branch?';
	document.body.appendChild(el);
	return el;
}
async function anchor(promptId = 'p1'): Promise<void> {
	app = mount(PromptAnchor, { target: host, props: { prompt: { kind: 'permission', question: 'Delete the release branch?', promptId }, promptCount: 1, runStartedAt: null } });
	flushSync();
	await tick();
}
const bar = (): Element | null => host.querySelector('[data-prompt-anchor]');

beforeEach(() => {
	FakeIO.all = [];
	(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIO;
	document.body.innerHTML = '';
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = realIO;
});

describe('the bar above the input points to a question that is off screen', () => {
	it('stays away while the question card is on screen, so the question shows once', async () => {
		const c = card();
		await anchor();
		report(c, 300);
		expect(bar()).toBeNull();
	});

	it('shows, with the question, once the card is scrolled out of view, and goes again when it is back', async () => {
		const c = card();
		await anchor();
		report(c, 300);
		report(c, 0);
		expect(bar()?.textContent).toContain('Delete the release branch?');
		report(c, 300);
		expect(bar()).toBeNull();
	});

	it('counts a sliver of the card\'s bottom edge as out of view: the question text is at its top', async () => {
		const c = card();
		await anchor();
		report(c, 20);
		expect(bar()).not.toBeNull();
		report(c, 48);
		expect(bar()).toBeNull();
	});

	it('counts a card smaller than a line as in view when all of it shows', async () => {
		const c = card();
		await anchor();
		report(c, 30, 30);
		expect(bar()).toBeNull();
	});

	it('does not flash before the browser reports', async () => {
		card();
		await anchor();
		expect(bar()).toBeNull();
	});

	it('follows the card when the next question replaces it', async () => {
		const first = card();
		await anchor();
		report(first, 300);
		first.remove();
		const second = card();
		await tick();
		await new Promise((r) => setTimeout(r, 0));
		report(second, 0);
		expect(bar()).not.toBeNull();
		report(first, 300); // the old card no longer counts
		expect(bar()).not.toBeNull();
	});

	it('shows when there is no card to watch or no observer, as it always did', async () => {
		await anchor();
		expect(bar()).not.toBeNull();
		if (app) unmount(app);
		app = null;
		(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = undefined;
		card();
		await anchor();
		expect(bar()).not.toBeNull();
	});

	it('never takes the focus when it appears', async () => {
		const c = card();
		const input = document.createElement('textarea');
		document.body.appendChild(input);
		input.focus();
		await anchor();
		report(c, 0);
		expect(bar()).not.toBeNull();
		expect(document.activeElement).toBe(input);
		expect(bar()?.querySelector('button')?.tabIndex).not.toBe(-1);
	});
});
