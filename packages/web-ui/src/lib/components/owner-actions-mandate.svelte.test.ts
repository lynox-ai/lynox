import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setLocale, getLocale } from '../i18n.svelte.js';
import { resetSettingsViewer } from '../stores/settings-viewer.svelte.js';

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

// The owner's actions on the workflow library and the schedules page, in a mandate's session (ux
// U-104, register 1148): running, renaming and deleting a workflow, and confirming a plan, are the
// owner's (`ownerOnly` in http-api.ts). A mandate gets no button whose answer is always 403, and is
// told who does it, and nobody sees those buttons before it is known that the owner reads. Each
// page loads the shared store itself (`GET /api/config` says `viewer`); the
// schedules page also reads the `viewer` its own list sends. The library's list sends none today,
// so the mocks here send none for it either.

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
const before = getLocale();

/** What the list says about whose session reads it, and what `GET /api/config` says. */
let listViewer: string | undefined;
let configViewer: string | undefined;

const WF = {
	id: 'wf-1', name: 'Monthly report', description: '', step_count: 1, steps: [{ id: 'fetch', task: 'Fetch the data' }],
	parameters: [], created_at: '2026-10-29', mode: 'autonomous', schedulable: true,
};
const AWAITING = { id: 't1', title: 'Wochenreport', status: 'open', effect: 'run_agent', source: 'cron', confirmed_at: null, enabled: 1, instruction: 'Write the report' };

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
	setLocale('de');
	resetSettingsViewer();
	listViewer = undefined;
	configViewer = undefined;
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const u = String(url);
		const viewer = listViewer ? { viewer: listViewer } : {};
		// As the engine answers today: no `viewer` in the library's list.
		if (u.endsWith('/workflows/library?limit=100')) return json(200, { workflows: [WF], grantEnabled: false });
		if (u.endsWith('/triggers')) return json(200, { triggers: [AWAITING], ...viewer });
		if (u.endsWith('/config')) return json(200, configViewer ? { viewer: configViewer } : {});
		if (u.endsWith('/secrets/status')) return json(200, {});
		return json(200, {});
	}));
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
	resetSettingsViewer();
	setLocale(before);
});

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

async function open(view: 'library' | 'triggers'): Promise<void> {
	const { default: View } = view === 'library' ? await import('./WorkflowLibraryView.svelte') : await import('./TriggersView.svelte');
	component = mount(View, { target });
	await settle();
}

const buttons = (): string[] => [...target.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');
const notice = (): string | undefined => target.querySelector('[data-testid="owner-only-notice"]')?.textContent?.trim();

describe('the workflow library in a mandate\'s session', () => {
	it('shows the owner Run, Rename and Delete, and no notice', async () => {
		configViewer = 'owner';
		await open('library');
		expect(buttons()).toEqual(expect.arrayContaining(['Ausführen', 'Umbenennen', 'Löschen', 'Planen', 'Bearbeiten']));
		expect(notice()).toBeUndefined();
	});

	it('shows a mandate, as the store it loads itself says, neither Run nor Rename nor Delete, keeps scheduling and the chat, and says who runs it and where it can', async () => {
		configViewer = 'mandate';
		await open('library');
		expect(buttons().filter((b) => ['Ausführen', 'Umbenennen', 'Löschen'].includes(b))).toEqual([]);
		expect(buttons()).toEqual(expect.arrayContaining(['Planen', 'Bearbeiten']));
		expect(notice()).toBe('Workflows hier ausführen, umbenennen oder löschen kann nur der Inhaber dieser Instanz. Brauchst du das, wende dich an den Inhaber. Ausführen kannst du einen Workflow auch im Chat: bitte lynox darum.');
	});

	it('shows neither Run nor Rename nor Delete, nor the sentence, while nobody has said whose session it is', async () => {
		await open('library');
		expect(buttons()).toEqual(expect.arrayContaining(['Planen', 'Bearbeiten']));   // the list is shown
		expect(buttons().filter((b) => ['Ausführen', 'Umbenennen', 'Löschen'].includes(b))).toEqual([]);
		expect(notice()).toBeUndefined();
	});
});

describe('the schedules page in a mandate\'s session', () => {
	it('offers the owner the confirmation of a plan that waits for it, as the list says', async () => {
		listViewer = 'owner';
		await open('triggers');
		expect(buttons()).toContain('Bestätigen');
		expect(target.querySelector('[data-trigger-awaits]')?.textContent?.trim()).toBe('Läuft erst, wenn du ihn bestätigst.');
	});

	it('shows a mandate no confirmation, and says the owner confirms it', async () => {
		listViewer = 'mandate';
		await open('triggers');
		expect(buttons()).not.toContain('Bestätigen');
		expect(target.querySelector('[data-trigger-awaits]')?.textContent?.trim()).toBe('Läuft erst, wenn der Inhaber diesen Plan bestätigt.');
	});

	it('takes a mandate from the store the page loads itself when the list does not say', async () => {
		configViewer = 'mandate';
		await open('triggers');
		expect(buttons()).not.toContain('Bestätigen');
		expect(target.querySelector('[data-trigger-awaits]')?.textContent?.trim()).toBe('Läuft erst, wenn der Inhaber diesen Plan bestätigt.');
	});

	it('offers no confirmation while nobody has said whose session it is, and says the owner confirms', async () => {
		await open('triggers');
		expect(target.querySelector('[data-trigger-awaits]')?.textContent?.trim()).toBe('Läuft erst, wenn der Inhaber diesen Plan bestätigt.');
		expect(buttons()).not.toContain('Bestätigen');
	});

	it('offers the owner the confirmation when only the store says it is the owner', async () => {
		configViewer = 'owner';
		await open('triggers');
		expect(buttons()).toContain('Bestätigen');
		expect(target.querySelector('[data-trigger-awaits]')?.textContent?.trim()).toBe('Läuft erst, wenn du ihn bestätigst.');
	});
});
