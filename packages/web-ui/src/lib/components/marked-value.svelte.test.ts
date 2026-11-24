import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { shownValue, shownWhole } from '../utils/plan-takeover.js';
import { valueSegments } from '../utils/value-breaks.js';

const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = { mount: (c: unknown, o: { target: Element; props?: Record<string, unknown> }) => Record<string, unknown>; unmount: (c: Record<string, unknown>) => void; flushSync: () => void };
const { mount, unmount, flushSync } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

// One value someone else wrote, set apart in MarkedLine's box and broken only by the value rule
// (U-428): after a dot, `@` or `/`, never at a hyphen.
const mounted: Array<{ c: Record<string, unknown>; el: HTMLElement }> = [];
afterEach(() => { for (const m of mounted.splice(0)) { unmount(m.c); m.el.remove(); } });
async function draw(which: 'value' | 'line', text: string): Promise<HTMLElement> {
	const { default: View } = which === 'value' ? await import('./MarkedValue.svelte') : await import('./MarkedLine.svelte');
	const el = document.createElement('div');
	document.body.appendChild(el);
	mounted.push({ c: mount(View, { target: el, props: { text } }), el });
	flushSync();
	return el;
}
const clean = (el: HTMLElement): string => el.innerHTML.replace(/<!---->/g, '');
const BOX = 'rounded-[var(--radius-sm)] border border-text-subtle bg-bg-muted px-1 box-decoration-clone';

describe('one value in its box, broken by the value rule', () => {
	it('cuts pieces that end after a dot or @, never at a hyphen', async () => {
		const pieces = async (v: string): Promise<string[]> => [...(await draw('value', shownValue(v))).querySelectorAll('bdi[data-foreign-value] > span')].map((s) => s.textContent ?? '');
		expect(await pieces('acme-store')).toEqual(['acme-store']);
		expect(await pieces('buero@kunden-crm.example')).toEqual(['buero@', 'kunden-crm.', 'example']);
		expect(await pieces('zentrale-buchhaltung-und-lohnabrechnung.filiale-ostschweiz.ch')).toEqual(['zentrale-buchhaltung-und-lohnabrechnung.', 'filiale-ostschweiz.', 'ch']);
	});

	it('draws the same box as MarkedLine, in the code font, one value set apart', async () => {
		const el = await draw('value', shownValue('acme-store.myshopify.com'));
		const boxes = el.querySelectorAll('bdi[data-foreign-value]');
		expect(boxes.length).toBe(1);
		expect(boxes[0]!.getAttribute('class')).toBe(`${BOX} font-mono inline-block max-w-full`);
		expect(boxes[0]!.textContent).toBe('acme-store.myshopify.com');
		expect(boxes[0]!.querySelectorAll('wbr').length).toBe(2);
	});

	it('keeps a character printed as its code point in one piece, no break inside it', async () => {
		const rlo = String.fromCharCode(0x202e);
		const el = await draw('value', shownValue(`shop${rlo}.example`));
		const pieces = [...el.querySelectorAll('bdi[data-foreign-value] > span')].map((s) => s.textContent ?? '');
		expect(pieces.some((p) => p.includes(rlo))).toBe(false);
		expect(pieces.filter((p) => p.includes('<U+202E>')).length).toBe(1);
		expect(valueSegments('a<U+202E>b', 'account')).toEqual(['a<U+202E>b']);
	});

	it('reads left to right, so a value led by a right-to-left letter keeps its pieces in order', async () => {
		const aleph = String.fromCharCode(0x05d0);
		const el = await draw('value', shownValue(`${aleph}@com.paypal.attacker.io`));
		const box = el.querySelector<HTMLElement>('bdi[data-foreign-value]')!;
		expect(box.getAttribute('dir')).toBe('ltr');
		expect([...box.querySelectorAll(':scope > span')].map((s) => s.textContent)).toEqual([`${aleph}@`, 'com.', 'paypal.', 'attacker.', 'io']);
	});

	it('anything but exactly one marked value is drawn by MarkedLine as it is', async () => {
		for (const text of ['plain words', `${shownValue('a')} and ${shownValue('b')}`, `Konto: ${shownWhole('x.y')}`]) {
			expect(clean(await draw('value', text)).replace(/^<span class="inline-block max-w-full">|<\/span>$/g, '')).toBe(clean(await draw('line', text)));
		}
	});
});

describe('MarkedLine draws its box as before', () => {
	it('the class of a value set apart is the box, then the code font', async () => {
		const el = await draw('line', `Konto: ${shownValue('acme')}`);
		expect(el.querySelector('bdi[data-foreign-value]')!.getAttribute('class')).toBe(`${BOX} font-mono`);
	});
});
