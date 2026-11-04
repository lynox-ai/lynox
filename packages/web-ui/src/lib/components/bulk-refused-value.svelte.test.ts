import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setLocale, getLocale } from '../i18n.svelte.js';
import { BULK_VALUE_SHOWN_CHARS, BULK_VALUE_SHOWN_LINES, bulkFoldedValue } from './bulk-runs.js';

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

// 1130, ux U-103: a description lynox does not write (`shortcode_changed`) is shown to the owner
// whole, to copy into the shop. The screen folds a long one; the copy never does.

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let writeText: ReturnType<typeof vi.fn>;
let locale: ReturnType<typeof getLocale>;

beforeEach(() => {
	locale = getLocale();
	setLocale('de');
	writeText = vi.fn(async () => undefined);
	vi.stubGlobal('navigator', { ...globalThis.navigator, clipboard: { writeText } });
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
	setLocale(locale);
});

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

async function render(value: string): Promise<void> {
	const { default: BulkRefusedValue } = await import('./BulkRefusedValue.svelte');
	component = mount(BulkRefusedValue, { target, props: { value } });
	await settle();
}

const q = (id: string): HTMLElement | null => target.querySelector(`[data-testid="${id}"]`);
const LONG = `<p>${'Bio-Baumwolle, fair produziert. '.repeat(60)}</p>\n[button url="https://shop.example.com/sale?cat=tee&size=m"]Zum Angebot[/button]`;

describe('the value lynox does not write, for the owner to copy (1130)', () => {
	it('folds a long value on screen, and copies it whole', async () => {
		expect(LONG.length).toBeGreaterThan(BULK_VALUE_SHOWN_CHARS);
		await render(LONG);
		const shown = q('bulk-refused-value-text')!.textContent!;
		expect(shown, 'folded on screen').not.toContain('[button');
		expect(shown.length).toBeLessThanOrEqual(BULK_VALUE_SHOWN_CHARS + 1);
		expect(q('bulk-refused-value-copied')!.textContent).toBe('');
		q('bulk-refused-value-copy')!.click();
		await settle();
		expect(writeText).toHaveBeenCalledTimes(1);
		expect(writeText.mock.calls[0]![0], 'the whole planned value, not the folded text').toBe(LONG);
		expect(q('bulk-refused-value-copied')!.textContent).toBe('Kopiert');
		expect(q('bulk-refused-value-copied')!.getAttribute('aria-live')).toBe('polite');
	});

	it('shows the whole value on request, the shortcode byte for byte', async () => {
		await render(LONG);
		expect(q('bulk-refused-value-toggle')!.textContent).toBe('Ganzen Text zeigen');
		q('bulk-refused-value-toggle')!.click();
		await settle();
		expect(q('bulk-refused-value-text')!.textContent).toBe(LONG);
		expect(q('bulk-refused-value-toggle')).toBeNull();
	});

	it('shows a short value whole, without the fold', async () => {
		const short = '[button url="/a?x=1&y=2"]Neu[/button]';
		await render(short);
		expect(q('bulk-refused-value-text')!.textContent).toBe(short);
		expect(q('bulk-refused-value-toggle')).toBeNull();
		expect(q('bulk-refused-value-copy')!.textContent).toBe('Text kopieren');
	});

	it('folds at twelve lines as well as at the character limit', () => {
		const lines = Array.from({ length: 20 }, (_, i) => `Zeile ${String(i)}`).join('\n');
		const { shown, cut } = bulkFoldedValue(lines);
		expect(cut).toBe(true);
		expect(shown.split('\n')).toHaveLength(BULK_VALUE_SHOWN_LINES);
		expect(bulkFoldedValue('kurz')).toEqual({ shown: 'kurz', cut: false });
	});
});
