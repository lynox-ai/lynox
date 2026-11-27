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

// The status line at the head of the stamp and takeover reviews: it stays in sight while it is
// short, says when it is cut, and opened it scrolls with the rest. jsdom lays nothing out, so a cut
// line is one whose content is higher than its box, set here as the browser would report it.

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
const sizes = new Map<string, { scroll: number; client: number }>();
const realScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
const realClient = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

async function show(text: string, size?: { scroll: number; client: number }): Promise<void> {
	if (size) sizes.set(text, size);
	const { default: DialogStatusLine } = await import('./DialogStatusLine.svelte');
	component = mount(DialogStatusLine, { target, props: { text, testid: 'line' } });
	await settle();
}

const wrap = (): HTMLElement => target.querySelector<HTMLElement>('[data-dialog-status]')!;
const line = (): HTMLElement => target.querySelector<HTMLElement>('[data-testid="line"]')!;
const more = (): HTMLButtonElement | null => target.querySelector<HTMLButtonElement>('[data-dialog-status-more]');
const sticks = (): boolean => wrap().className.split(/\s+/).includes('[@media(min-height:30rem)]:sticky');

beforeEach(() => {
	sizes.clear();
	Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get(this: HTMLElement) { return sizes.get(this.textContent ?? '')?.scroll ?? 0; } });
	Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get(this: HTMLElement) { return sizes.get(this.textContent ?? '')?.client ?? 0; } });
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	if (realScroll) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', realScroll);
	if (realClient) Object.defineProperty(HTMLElement.prototype, 'clientHeight', realClient);
});

describe('the status line of a review dialog', () => {
	it('a short line stays in sight, is a status, and offers nothing to open', async () => {
		await show('Die Schritte haben sich geändert.', { scroll: 40, client: 40 });
		expect(line().getAttribute('role')).toBe('status');
		expect(line().textContent).toBe('Die Schritte haben sich geändert.');
		expect(sticks()).toBe(true);
		// Opaque ground and a line below it, so the review scrolling under it does not show through.
		expect(wrap().className).toContain('bg-bg');
		expect(wrap().className).toContain('[@media(min-height:30rem)]:border-b');
		expect(more()).toBeNull();
	});

	it('a line cut to three lines says so with a button, and opened it is whole and scrolls with the rest', async () => {
		const long = 'Ein langer Grund. '.repeat(30);
		await show(long, { scroll: 200, client: 60 });
		expect(line().className.split(/\s+/)).toContain('line-clamp-3');
		expect(more()?.textContent?.trim()).toBe('Mehr anzeigen');
		expect(more()?.getAttribute('aria-expanded')).toBe('false');
		expect(sticks()).toBe(true);
		more()!.click();
		await settle();
		expect(line().className.split(/\s+/)).not.toContain('line-clamp-3');
		expect(more()?.textContent?.trim()).toBe('Weniger anzeigen');
		expect(more()?.getAttribute('aria-expanded')).toBe('true');
		expect(sticks()).toBe(false);
		more()!.click();
		await settle();
		expect(line().className.split(/\s+/)).toContain('line-clamp-3');
		expect(sticks()).toBe(true);
	});

	it('another reason starts folded again', async () => {
		const long = 'Ein langer Grund. '.repeat(30);
		const other = 'Ein anderer langer Grund. '.repeat(30);
		sizes.set(other, { scroll: 200, client: 60 });
		sizes.set(long, { scroll: 200, client: 60 });
		const props = $state({ text: long, testid: 'line' });
		const { default: DialogStatusLine } = await import('./DialogStatusLine.svelte');
		component = mount(DialogStatusLine, { target, props });
		await settle();
		more()!.click();
		await settle();
		expect(sticks()).toBe(false);
		props.text = other;
		await settle();
		expect(line().textContent).toBe(other);
		expect(sticks()).toBe(true);
		expect(more()?.getAttribute('aria-expanded')).toBe('false');
	});
});
