import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element; props?: Record<string, unknown> }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
};
const { mount, unmount, flushSync } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

// The run page's heading, target and halt host (U-374, U-383): a line wraps at spaces and after a
// dot, never at a hyphen inside a name. Each word is its own inline-block box, so it moves to the
// next line whole and only a word longer than a line breaks inside (`break-all`); the space after
// a word stays text. That a fitting word stays whole is a rendering fact jsdom cannot check; this
// pins the markup.

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
});

async function render(text: string): Promise<HTMLElement> {
	target = document.createElement('div');
	document.body.appendChild(target);
	const { default: WrapParts } = await import('./WrapParts.svelte');
	component = mount(WrapParts, { target, props: { text } });
	flushSync();
	return target;
}

const B = (x: string): string => `<span class="inline-block max-w-full break-all">${x}</span>`;

describe('a line of the run page in word boxes', () => {
	it('puts each word in its own box, keeps the spaces as text, and adds `<wbr>` after a dot only', async () => {
		const el = await render('Shop-Inhalte · my-very-long-store-name-for-testing-2024.myshopify.com');
		expect(el.textContent).toBe('Shop-Inhalte · my-very-long-store-name-for-testing-2024.myshopify.com');
		expect(el.innerHTML.replace(/<!---->/g, '')).toBe(`${B('Shop-Inhalte')} ${B('·')} ${B('my-very-long-store-name-for-testing-2024.')}<wbr>${B('myshopify.')}<wbr>${B('com')}`);
	});

	it('puts no empty box before a leading space', async () => {
		const el = await render(' Neu');
		expect(el.innerHTML.replace(/<!---->/g, '')).toBe(` ${B('Neu')}`);
	});

	it('gives a word that ends a sentence no `<wbr>` of its own when a space follows', async () => {
		const el = await render('Gestoppt. Neu');
		expect(el.innerHTML.replace(/<!---->/g, '')).toBe(`${B('Gestoppt.')} ${B('Neu')}`);
	});
});
