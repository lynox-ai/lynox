import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { planList, shownValue, shownWhole } from '../utils/plan-takeover.js';
import { tf } from '../i18n.svelte.js';
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

// A list of plans past five keeps its rest folded behind a button in the sentence (U-037); pressing
// it puts the remaining titles in its place, in the same sentence, and moves focus to the first.
describe('a folded list of plans in a sentence', () => {
	const titles = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'];
	it('shows five titles and a button that says how many more, not expanded', async () => {
		const el = await draw('line', `Plans: ${planList(titles)}.`);
		expect([...el.querySelectorAll('bdi[data-foreign-value]')].map((b) => b.textContent)).toEqual(['P1', 'P2', 'P3', 'P4', 'P5']);
		const button = el.querySelector('button[data-testid="plans-more"]')!;
		expect(button.textContent).toBe(tf('takeover.plans_more', { n: '2' }));
		expect(button.getAttribute('aria-expanded')).toBe('false');
		expect(button.getAttribute('aria-label')).toBe(tf('takeover.plans_more_show', { n: '2' }));
		expect(el.textContent).toBe(`Plans: P1, P2, P3, P4, P5 ${tf('takeover.plans_more', { n: '2' })}.`);
	});
	it('pressing it puts the remaining titles into the same sentence, each in its box, and focuses the first', async () => {
		const el = await draw('line', `Plans: ${planList(titles)}.`);
		(el.querySelector('button[data-testid="plans-more"]') as HTMLButtonElement).click();
		flushSync();
		expect(el.querySelector('button')).toBeNull();
		const boxes = [...el.querySelectorAll('bdi[data-foreign-value]')];
		expect(boxes.map((b) => b.textContent)).toEqual(titles);
		expect(el.textContent).toBe('Plans: P1, P2, P3, P4, P5, P6, P7.');
		expect(document.activeElement).toBe(boxes[5]);
		expect(boxes[5]!.getAttribute('tabindex')).toBe('-1');
		expect(boxes[5]!.getAttribute('class')).toContain('focus-visible:ring-2');
	});
	it('the button shows its focus', async () => {
		const el = await draw('line', planList(titles));
		expect(el.querySelector('button[data-testid="plans-more"]')!.getAttribute('class')).toContain('focus-visible:ring-2');
	});
	it('CONTROL: five titles draw no button', async () => {
		const el = await draw('line', planList(titles.slice(0, 5)));
		expect(el.querySelector('button')).toBeNull();
		expect(el.querySelectorAll('bdi[data-foreign-value]').length).toBe(5);
	});
});
