import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getLocale, setLocale } from '../i18n.svelte.js';

// `svelte` resolves to its server entry under node, where `mount` throws. The component is compiled
// for the client, so it is mounted with the client entry, loaded by path.
const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

// A trigger a helper (a mandate) set up says so under its title, by the helper's name, as an
// approval card does (U-202). The owner's own trigger says nothing of the kind.

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let rows: Record<string, unknown>[] = [];
let viewer: 'owner' | 'mandate' = 'owner';
const locale = getLocale();

beforeEach(() => {
	rows = [];
	viewer = 'owner';
	vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ triggers: rows, viewer }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
	vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	setLocale(locale);
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

async function render(): Promise<void> {
	const { default: TriggersView } = await import('./TriggersView.svelte');
	component = mount(TriggersView, { target });
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

const BASE = { status: 'open', source: 'manual', effect: 'run_agent', confirmed_at: '2026-11-10T00:00:00.000Z' };

/** The setup lines under each card, by the card's title. */
function linesByTitle(): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const title of target.querySelectorAll('[data-trigger-title]')) {
		const card = title.closest('.group');
		out[title.textContent?.trim() ?? ''] = [...(card?.querySelectorAll('[data-trigger-setup]') ?? [])].map((e) => e.textContent?.trim() ?? '');
	}
	return out;
}

describe('the schedules list says which helper set a trigger up', () => {
	const helperRows = (): Record<string, unknown>[] => [
		{ ...BASE, id: 'trg-anna', title: 'Preise beobachten', created_by: 'mandate:anna@example.com', setup: [{ kind: 'set_up_by', name: 'Anna A.', takenOver: false }] },
		{ ...BASE, id: 'trg-own', title: 'Eigener Bericht', created_by: 'owner', setup: [] },
	];

	it('names the helper on its trigger and nothing on the owner\'s own, in German', async () => {
		setLocale('de');
		rows = helperRows();
		await render();
		expect(linesByTitle()).toEqual({ 'Preise beobachten': ['Eingerichtet von Anna A.'], 'Eigener Bericht': [] });
	});

	it('names the helper on its trigger and nothing on the owner\'s own, in English', async () => {
		setLocale('en');
		rows = helperRows();
		await render();
		expect(linesByTitle()).toEqual({ 'Preise beobachten': ['Set up by Anna A.'], 'Eigener Bericht': [] });
	});

	it('says a change, a takeover and another helper as an approval card does, by whose session reads it', async () => {
		setLocale('de');
		rows = [
			{ ...BASE, id: 'trg-both', title: 'Wochenbericht', setup: [{ kind: 'last_changed_by', name: 'bea@example.com', takenOver: false }, { kind: 'set_up_by', name: 'Anna A.', takenOver: true }] },
			{ ...BASE, id: 'trg-unnamed', title: 'Ohne Namen', setup: [{ kind: 'set_up_by', name: 'unnamed mandate', takenOver: false }] },
			// Another helper's mark, as a helper's list carries it: not whose.
			{ ...BASE, id: 'trg-other', title: 'Fremd', setup: [{ kind: 'set_up_by', name: 'other mandate', takenOver: false }] },
			// From before the list carried the lines: no line, and no error.
			{ ...BASE, id: 'trg-old', title: 'Alt' },
		];
		await render();
		expect(linesByTitle()).toEqual({
			Wochenbericht: ['Geändert von bea@example.com', 'Eingerichtet von Anna A., von dir übernommen'],
			'Ohne Namen': ['Eingerichtet von (ohne Namen)'],
			Fremd: ['Eingerichtet von einer anderen Person mit Zugang'],
			Alt: [],
		});
		if (component) unmount(component);
		component = undefined;
		viewer = 'mandate';
		await render();
		expect(linesByTitle()['Wochenbericht']).toEqual(['Geändert von bea@example.com', 'Eingerichtet von Anna A., vom Inhaber übernommen']);
		setLocale('en');
		if (component) unmount(component);
		component = undefined;
		await render();
		expect(linesByTitle()['Fremd']).toEqual(['Set up by another person with delegated access']);
	});
});
