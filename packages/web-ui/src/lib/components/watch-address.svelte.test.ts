import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import WatchAddress from './WatchAddress.svelte';

// The component is compiled for the client, so it is mounted with the client entry, loaded by path.
const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element; props?: Record<string, unknown> }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
};
const { mount, unmount, flushSync } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

let target: HTMLElement;
let component: Record<string, unknown> | undefined;

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
});
afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
});

function render(props: Record<string, unknown>): HTMLElement {
	component = mount(WatchAddress, { target, props: { testid: 'addr', ...props } });
	flushSync();
	return target.querySelector('[data-testid="addr"]') as HTMLElement;
}

// Each piece its own box, broken inside only when longer than a line; `<wbr>` only between pieces.
// That a fitting address stays whole is a rendering fact jsdom cannot check; this pins the markup.
const W = (x: string): string => `<span class="inline-block max-w-full break-all">${x}</span>`;
const markup = (el: Element): string => el.innerHTML.replace(/<!---->/g, '');

describe('a watched page\'s address', () => {
	it('breaks only after a dot or slash, never at the hyphen inside the host, with the host set off', () => {
		const el = render({ host: 'https://preise.lieferant-beispiel.ch', rest: '/preise/heizoel' });
		expect(el.textContent).toBe('https://preise.lieferant-beispiel.ch/preise/heizoel');
		expect(markup(el)).toBe(
			`<span class="inline-block max-w-full font-medium text-text">${W('https://')}<wbr>${W('preise.')}<wbr>${W('lieferant-beispiel.')}<wbr>${W('ch')}</span>`
			+ '<wbr>'
			+ `<span class="inline-block max-w-full ">${W('/')}<wbr>${W('preise/')}<wbr>${W('heizoel')}</span>`,
		);
	});

	it('is one box up to the line\'s width, so an address that fits moves to the next line whole', () => {
		const el = render({ host: 'https://preise.lieferant-beispiel.ch', rest: '/p' });
		expect(el.tagName).toBe('SPAN');
		expect(el.classList.contains('inline-block')).toBe(true);
		expect(el.classList.contains('max-w-full')).toBe(true);
	});

	it('without a path shows the host alone, with no break after it', () => {
		const el = render({ host: 'https://shop.example' });
		expect(el.textContent).toBe('https://shop.example');
		expect(el.children).toHaveLength(1);
		expect(markup(el).endsWith('</span></span>')).toBe(true);
	});
});
