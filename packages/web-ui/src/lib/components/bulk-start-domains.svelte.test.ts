import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readStartDomainLines, START_DOMAINS_MAX } from './bulk-start-domains.js';
import { tf } from '../i18n.svelte.js';

// `svelte` resolves to its server entry under node, where `mount` throws. The component is compiled
// for the client, so it is mounted with the client entry, loaded by path.
const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element; props?: Record<string, unknown> }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
};
const { mount, unmount, flushSync } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;
const { default: BulkStartDomains } = await import('./BulkStartDomains.svelte');

// The link domains a judged list run may add: typed at the start with each wrong line marked before
// the start, shown read-only where the list is fixed, so the owner approves a checksum over a list
// they have seen (PRD shopify-preset §20.2 item 5).

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

/** The editable form; bound props reach the test through their setters, as `bind:` compiles to. */
function editable(): { domains: string[]; valid: boolean } {
	const bound = { domains: [] as string[], valid: true };
	component = mount(BulkStartDomains, {
		target,
		props: {
			storeHost: 'shop.example.com', editable: true,
			get domains(): string[] { return bound.domains; },
			set domains(v: string[]) { bound.domains = v; },
			get valid(): boolean { return bound.valid; },
			set valid(v: boolean) { bound.valid = v; },
		},
	});
	return bound;
}

function type(value: string): void {
	const area = target.querySelector('textarea')!;
	area.value = value;
	area.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

describe('readStartDomainLines', () => {
	it('reads one domain per line or by comma, as the engine names hosts', () => {
		expect(readStartDomainLines('Mein-Shop.CH\n  partner.example, \n\nbücher.ch\nmein-shop.ch')).toEqual({
			domains: ['mein-shop.ch', 'partner.example', 'xn--bcher-kva.ch'], badLines: [], sharedLines: [], tooMany: false,
		});
	});

	it('marks each line that names no host, counting empty lines', () => {
		expect(readStartDomainLines('ok.example\n\n*.shop.ch\nshop.ch/x\nshop.ch:8443\n127.0.0.1\nlocalhost\nok.example, a@b.ch, *.x.ch\na_b.ch\n-a.ch').badLines)
			.toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
	});

	it('marks a shared suffix on its own, and takes a name under one', () => {
		expect(readStartDomainLines('myshopify.com\nco.uk\ngithub.io\nmeinshop.myshopify.com\nexample.co.uk')).toEqual({
			domains: ['meinshop.myshopify.com', 'example.co.uk'], badLines: [0, 1, 2], sharedLines: [0, 1, 2], tooMany: false,
		});
	});

	it('tells a shared suffix apart from a line that is no host at all', () => {
		expect(readStartDomainLines('*.shop.ch\nmyshopify.com\nlocalhost, co.uk').sharedLines).toEqual([1, 2]);
	});

	it('marks a host that grows past 253 characters in Punycode', () => {
		const label = `${'ü'.repeat(3)}${'a'.repeat(40)}`;
		expect(readStartDomainLines(`${Array(5).fill(label).join('.')}.ch`).badLines).toEqual([0]);
	});

	it('counts past the cap, and not at it', () => {
		const lines = (n: number): string => Array.from({ length: n }, (_, i) => `d${String(i)}.example`).join('\n');
		expect(readStartDomainLines(lines(START_DOMAINS_MAX)).tooMany).toBe(false);
		expect(readStartDomainLines(lines(START_DOMAINS_MAX + 1)).tooMany).toBe(true);
	});
});

describe('BulkStartDomains', () => {
	it('binds the domains typed and stays valid', () => {
		const bound = editable();
		type('mein-shop.ch\n  partner.example, \n\nthird.example');
		expect(bound).toEqual({ domains: ['mein-shop.ch', 'partner.example', 'third.example'], valid: true });
		expect(target.querySelector('[role="alert"]')).toBeNull();
		expect(target.querySelector('textarea')!.getAttribute('aria-invalid')).toBe('false');
	});

	it('marks a wrong line by number and text and turns invalid, so the start can be held back', () => {
		const bound = editable();
		type('mein-shop.ch\n*.partner.example');
		expect(bound.valid).toBe(false);
		const alert = target.querySelector('[role="alert"]')!;
		expect(alert.textContent).toContain('2');
		expect(alert.textContent).toContain('*.partner.example');
		expect(alert.textContent).not.toContain('mein-shop.ch');
		expect(target.querySelector('textarea')!.getAttribute('aria-invalid')).toBe('true');
		type('mein-shop.ch');
		expect(bound.valid).toBe(true);
		expect(target.querySelector('[role="alert"]')).toBeNull();
	});

	it('says on a line with a shared suffix why it is wrong, and only there', () => {
		editable();
		type('myshopify.com\n*.partner.example');
		const lines = [...target.querySelectorAll('[role="alert"] p')].map((p) => p.textContent ?? '');
		const shared = tf('bulk.start_domains.shared', {});
		expect(lines[0]).toContain('myshopify.com');
		expect(lines[0]).toContain(shared);
		expect(lines[1]).toContain('*.partner.example');
		expect(lines[1]).not.toContain(shared);
	});

	it('turns invalid past the cap', () => {
		const bound = editable();
		type(Array.from({ length: START_DOMAINS_MAX + 1 }, (_, i) => `d${String(i)}.example`).join('\n'));
		expect(bound.valid).toBe(false);
		expect(target.querySelector('[role="alert"]')).not.toBeNull();
	});

	it('shows a fixed list read-only, in one sentence with the store, and no field to change it', () => {
		component = mount(BulkStartDomains, { target, props: { storeHost: 'shop.example.com', editable: false, domains: ['mein-shop.ch', 'b.example'] } });
		flushSync();
		expect(target.querySelector('textarea')).toBeNull();
		expect(target.textContent!.trim()).toBe(tf('bulk.start_domains.shown', { list: 'mein-shop.ch, b.example', store: 'shop.example.com' }));
	});

	it('says that only the store is allowed where no list was given', () => {
		component = mount(BulkStartDomains, { target, props: { storeHost: 'shop.example.com', editable: false, domains: [] } });
		flushSync();
		expect(target.querySelector('textarea')).toBeNull();
		expect(target.textContent!.trim()).toBe(tf('bulk.start_domains.none', { store: 'shop.example.com' }));
	});
});
