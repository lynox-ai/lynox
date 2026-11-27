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
const H = (x: string): string => `<span class="inline-block max-w-full break-all font-medium text-text">${x}</span>`;
const markup = (el: Element): string => el.innerHTML.replace(/<!---->/g, '');

describe('a watched page\'s address', () => {
	it('breaks only after a dot or slash, never at the hyphen inside the host; host set off, path flowing on in the same box', () => {
		const el = render({ host: 'https://preise.lieferant-beispiel.ch', rest: '/preise/heizoel' });
		expect(el.textContent).toBe('https://preise.lieferant-beispiel.ch/preise/heizoel');
		expect(markup(el)).toBe(
			`${H('https://')}<wbr>${H('preise.')}<wbr>${H('lieferant-beispiel.')}<wbr>${H('ch')}`
			+ `<wbr>${W('/')}<wbr>${W('preise/')}<wbr>${W('heizoel')}`,
		);
	});

	it('has the box classes that let an address that fits move to the next line whole', () => {
		const el = render({ host: 'https://preise.lieferant-beispiel.ch', rest: '/p' });
		expect(el.tagName).toBe('SPAN');
		expect([...el.classList]).toEqual(['inline-block', 'max-w-full']);
	});

	it('with the bare path "/" ends in that slash, joined to the host by a break point only', () => {
		const el = render({ host: 'https://shop.example', rest: '/' });
		expect(el.textContent).toBe('https://shop.example/');
		expect(markup(el)).toBe(`${H('https://')}<wbr>${H('shop.')}<wbr>${H('example')}<wbr>${W('/')}`);
	});
});
