import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setLocale, getLocale } from '../i18n.svelte.js';

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

// The owner's takeover of a paused plan in the schedules view (641c-2): the button at the paused
// plan, for the owner only and never at a bulk run; the confirmation built from the preview; the
// POST held to the preview's digest; and the notice of each ended access, in full. This is the
// rendered half of Sperrtest 1 (`src/server/plan-pause-http.test.ts`): with the switch on, a
// paused plan carries the button.

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let viewer = 'owner';
let rows: Record<string, unknown>[] = [];
let preview: Record<string, unknown> = {};
/** What the next POST …/takeover answers, in order. */
let takeoverAnswers: Array<{ status: number; body: Record<string, unknown> }> = [];
let previews = 0;
const posts: unknown[] = [];
const before = getLocale();

const PAUSED = {
	id: 'p1', title: 'Wochenreport', status: 'open', effect: 'run_agent', source: 'cron', confirmed_at: '2026-10-01T00:00:00.000Z',
	paused: true, paused_who: ['ida@treuhand-mueller-partner.ch'],
	paused_ended: [{ email: 'ida@treuhand-mueller-partner.ch', reason: 'expired', ends_at: '2026-10-31T00:00:00.000Z', warned: false }],
};
const PREVIEW = {
	expect: 'digest-1', refusal: null,
	members: [{ name: 'ida@treuhand-mueller-partner.ch', roles: ['created'], ended: true, reason: 'expired' }],
	runsAs: 'owner', workflow: null, memberChanges: [], alsoReleased: [], connections: [], schedule: 'kept', dueAt: null,
};

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
	setLocale('de');
	viewer = 'owner';
	rows = [PAUSED];
	preview = PREVIEW;
	takeoverAnswers = [];
	previews = 0;
	posts.length = 0;
	vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
		const u = String(url);
		if (u.endsWith('/triggers')) return json(200, { triggers: rows, viewer });
		if (u.endsWith('/takeover-preview')) { previews++; return json(200, preview); }
		if (u.endsWith('/takeover')) {
			posts.push(JSON.parse(String(init?.body)));
			const a = takeoverAnswers.shift() ?? { status: 200, body: { ...PAUSED, paused: false } };
			return json(a.status, a.body);
		}
		if (u.endsWith('/secrets/status')) return json(200, { managed: 'managed' });
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
	setLocale(before);
});

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

async function render(): Promise<void> {
	const { default: TriggersView } = await import('./TriggersView.svelte');
	component = mount(TriggersView, { target });
	await settle();
}

const button = (): HTMLButtonElement | null => target.querySelector<HTMLButtonElement>('[data-trigger-takeover]');
const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-takeover-dialog]');

async function open(): Promise<void> {
	button()!.click();
	await settle();
}

describe('the button at a paused plan', () => {
	it('shows for the owner at a paused plan', async () => {
		await render();
		expect(button()?.textContent?.trim()).toBe('Übernehmen');
	});
	it('not for a helper, not at a bulk run, not at a plan that is not paused', async () => {
		viewer = 'mandate';
		await render();
		expect(button()).toBeNull();
		unmount(component!);
		viewer = 'owner';
		rows = [{ ...PAUSED, effect: 'bulk_write' }, { ...PAUSED, id: 'p2', paused: false }];
		component = undefined;
		await render();
		expect(button()).toBeNull();
	});
});

describe('a completed plan that keeps its pause', () => {
	it('shows no label, no button and no notice; an open one does', async () => {
		rows = [{ ...PAUSED, status: 'completed' }];
		await render();
		expect([button(), target.querySelector('[data-trigger-paused]'), target.querySelector('[data-paused-notice]')]).toEqual([null, null, null]);
		unmount(component!);
		component = undefined;
		rows = [PAUSED];
		await render();
		expect([button() !== null, target.querySelector('[data-trigger-paused]') !== null, target.querySelector('[data-paused-notice]') !== null]).toEqual([true, true, true]);
	});
});

describe('the notice of an ended access', () => {
	it('says the full address, which the push shortens, and that there was no advance notice', async () => {
		await render();
		const notice = target.querySelector('[data-paused-notice]')?.textContent ?? '';
		expect(notice).toContain('Für ida@treuhand-mueller-partner.ch war ein Zugang bis zum 31.10.2026 eingetragen.');
		expect(notice.endsWith('Eine Vorwarnung gab es nicht.')).toBe(true);
	});
	it('is not shown to a helper', async () => {
		viewer = 'mandate';
		rows = [{ ...PAUSED, paused_who: undefined, paused_ended: undefined }];
		await render();
		expect(target.querySelector('[data-paused-notice]')).toBeNull();
	});
});

describe('the confirmation', () => {
	it('shows the preview\'s lines, with focus on Cancel, and Escape closes it', async () => {
		await render();
		await open();
		expect(dialog()?.getAttribute('role')).toBe('dialog');
		expect([...document.querySelectorAll('[data-takeover-line]')].map((l) => l.getAttribute('data-takeover-line'))).toEqual(['role', 'runs_as_owner']);
		expect(document.activeElement?.textContent?.trim()).toBe('Abbrechen');
		dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await settle();
		expect(dialog()).toBeNull();
		expect(posts).toEqual([]);
	});
	it('takes over with the preview\'s digest', async () => {
		await render();
		await open();
		document.querySelector<HTMLButtonElement>('[data-takeover-confirm]')!.click();
		await settle();
		expect(posts).toEqual([{ expect: 'digest-1' }]);
		expect(dialog()).toBeNull();
	});
	it('Escape closes from the window too, and focus goes back to the button that opened it', async () => {
		await render();
		button()!.focus();
		await open();
		document.body.focus();
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		await settle();
		expect(dialog()).toBeNull();
		expect(document.activeElement).toBe(button());
	});
	it('a preview that answers after its dialog was closed and another opened is dropped', async () => {
		rows = [PAUSED, { ...PAUSED, id: 'p2', title: 'Monatsabschluss' }];
		let releaseFirst: (() => void) | null = null;
		const inner = globalThis.fetch;
		let first = true;
		vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
			if (String(url).endsWith('/p1/takeover-preview') && first) {
				first = false;
				await new Promise<void>((r) => { releaseFirst = r; });
				return json(200, { ...PREVIEW, expect: 'digest-of-p1' });
			}
			if (String(url).endsWith('/p2/takeover-preview')) return json(200, { ...PREVIEW, expect: 'digest-of-p2', runsAs: 'mandate:bo@x.ch', members: [{ name: 'bo@x.ch', roles: ['workflow-created'], ended: false, reason: null }] });
			return inner(url, init);
		}));
		await render();
		const buttons = target.querySelectorAll<HTMLButtonElement>('[data-trigger-takeover]');
		buttons[0]!.click();
		await settle();
		dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await settle();
		buttons[1]!.click();
		await settle();
		releaseFirst!();
		await settle();
		document.querySelector<HTMLButtonElement>('[data-takeover-confirm]')!.click();
		await settle();
		expect(posts).toEqual([{ expect: 'digest-of-p2' }]);
	});
	it('Escape in an overlay above the dialog is not the dialog\'s', async () => {
		await render();
		await open();
		const overlay = document.createElement('input');
		document.body.appendChild(overlay);
		overlay.focus();
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		await settle();
		expect(dialog()).not.toBeNull();
		overlay.remove();
	});
	it('a takeover that answers after its dialog was closed says nothing in the next one', async () => {
		rows = [PAUSED, { ...PAUSED, id: 'p2', title: 'Monatsabschluss' }];
		let release: (() => void) | null = null;
		const inner = globalThis.fetch;
		vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
			if (String(url).endsWith('/p1/takeover')) {
				posts.push(JSON.parse(String(init?.body)));
				await new Promise<void>((r) => { release = r; });
				return json(409, { error: 'changed', code: 'changed' });
			}
			return inner(url, init);
		}));
		await render();
		const buttons = target.querySelectorAll<HTMLButtonElement>('[data-trigger-takeover]');
		buttons[0]!.click();
		await settle();
		document.querySelector<HTMLButtonElement>('[data-takeover-confirm]')!.click();
		await settle();
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		await settle();
		buttons[1]!.click();
		await settle();
		const before = previews;
		release!();
		await settle();
		expect(document.querySelector('[data-takeover-note]')).toBeNull();
		expect(document.querySelector('[data-takeover-confirm]')).not.toBeNull();
		expect(previews).toBe(before);
		expect((document.querySelector<HTMLButtonElement>('[data-takeover-confirm]')!).disabled).toBe(false);
	});
	it('a plan that changed is shown again, with the line above it, and not taken over unseen', async () => {
		takeoverAnswers = [{ status: 409, body: { error: 'changed', code: 'changed' } }];
		await render();
		await open();
		preview = { ...PREVIEW, expect: 'digest-2' };
		document.querySelector<HTMLButtonElement>('[data-takeover-confirm]')!.click();
		await settle();
		expect(previews).toBe(2);
		expect(document.querySelector('[data-takeover-note]')?.textContent).toBe('Der Plan hat sich geändert, während du ihn angesehen hast. Unten steht der neue Stand. Prüf ihn und übernimm ihn dann.');
		// The focused button left with the old preview; focus is on Cancel again.
		expect(document.activeElement?.textContent?.trim()).toBe('Abbrechen');
		expect(dialog()).not.toBeNull();
		document.querySelector<HTMLButtonElement>('[data-takeover-confirm]')!.click();
		await settle();
		expect(posts).toEqual([{ expect: 'digest-1' }, { expect: 'digest-2' }]);
	});
	it('a refusal that lasts says so in the dialog, with support on a hosted instance', async () => {
		takeoverAnswers = [{ status: 503, body: { error: 'x', code: 'unrecorded' } }];
		await render();
		await open();
		document.querySelector<HTMLButtonElement>('[data-takeover-confirm]')!.click();
		await settle();
		expect(document.querySelector('[data-takeover-note]')?.textContent?.endsWith('Bleibt es so, schreib an support@lynox.ai.')).toBe(true);
		expect(dialog()).not.toBeNull();
	});
	it('a preview that cannot be loaded offers to load it again, and then the takeover', async () => {
		let fail = true;
		const inner = globalThis.fetch;
		vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
			if (String(url).endsWith('/takeover-preview') && fail) { previews++; return json(500, {}); }
			return inner(url, init);
		}));
		await render();
		await open();
		expect(document.querySelector('[data-takeover-note]')?.textContent).toBe('Die Übersicht lässt sich gerade nicht laden. Der Plan bleibt pausiert.');
		expect(document.querySelector('[data-takeover-confirm]')).toBeNull();
		fail = false;
		document.querySelector<HTMLButtonElement>('[data-takeover-reload]')!.click();
		await settle();
		expect(document.querySelector('[data-takeover-reload]')).toBeNull();
		expect(document.querySelector('[data-takeover-note]')).toBeNull();
		expect(document.querySelector('[data-takeover-confirm]')).not.toBeNull();
	});

	it('a preview that refuses offers no takeover', async () => {
		preview = { refusal: 'nothing_to_take_over', message: 'x' };
		await render();
		await open();
		expect(document.querySelector('[data-takeover-confirm]')).toBeNull();
		expect(document.querySelector('[data-takeover-note]')?.textContent).toBe('Dieser Plan muss nicht mehr übernommen werden. Die Liste ist aktualisiert.');
	});
});
