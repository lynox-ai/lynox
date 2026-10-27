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
};
const { mount, unmount, flushSync } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;
const { default: BulkStartDomains } = await import('./BulkStartDomains.svelte');

// The link domains a judged list run may add: typed at the start, shown in the approval view, so
// the owner approves a checksum over a list they have seen (PRD shopify-preset §20.2 item 5).

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

describe('BulkStartDomains', () => {
	it('splits what the owner types into host names, one per line or by comma', () => {
		// A bound prop reaches the parent through its setter, as `bind:domains` compiles to.
		const bound = { domains: [] as string[] };
		const props = {
			storeHost: 'shop.example.com', editable: true,
			get domains(): string[] { return bound.domains; },
			set domains(v: string[]) { bound.domains = v; },
		};
		component = mount(BulkStartDomains, { target, props });
		const area = target.querySelector('textarea')!;
		area.value = 'mein-shop.ch\n  partner.example, \n\nthird.example';
		area.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		expect(bound.domains).toEqual(['mein-shop.ch', 'partner.example', 'third.example']);
	});

	it('shows the stored list in the approval view, with the store, and no field to change it', () => {
		component = mount(BulkStartDomains, { target, props: { storeHost: 'shop.example.com', editable: false, domains: ['mein-shop.ch'] } });
		flushSync();
		expect(target.querySelector('textarea')).toBeNull();
		expect([...target.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['mein-shop.ch']);
		expect(target.textContent).toContain('shop.example.com');
	});

	it('says that only the store is allowed where no list was given', () => {
		component = mount(BulkStartDomains, { target, props: { storeHost: 'shop.example.com', editable: false, domains: [] } });
		flushSync();
		expect(target.querySelector('li')).toBeNull();
		expect(target.textContent).toContain('shop.example.com');
	});
});
