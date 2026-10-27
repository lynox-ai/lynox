import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

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

// The owner's view of the actor trail names what the engine says — an entry's kind, its status,
// its note — and never makes up a number: a plan run counts its write steps, not what they wrote,
// and one without a key shows "–".

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
/** Every URL the view fetched, in order. */
let urls: string[] = [];
/** What the next `GET /access-trail` answers, by its `before` (null: the first page). */
let pages = new Map<string | null, { status: number; body: unknown }>();

const IDA = { email: 'ida@example.invalid', display: 'IDA', mandateId: 'M-1' };
const BEN = { email: 'ben@example.invalid', display: null, mandateId: 'M-2' };
const NOW = new Date().toISOString();

beforeEach(() => {
	urls = [];
	pages = new Map();
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		urls.push(String(url));
		const before = new URL(String(url), 'http://x').searchParams.get('before');
		const page = pages.get(before) ?? { status: 200, body: { entries: [], before: null } };
		return new Response(JSON.stringify(page.body), { status: page.status, headers: { 'Content-Type': 'application/json' } });
	}));
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

/** Gives each fixture entry (and each step under a run) an id, as the engine does, where it has none. */
let nextId = 0;
function withIds(entries: unknown[]): unknown[] {
	return entries.map((e) => {
		const entry = e as Record<string, unknown>;
		const inner = Array.isArray(entry['entries']) ? { entries: withIds(entry['entries'] as unknown[]) } : {};
		return { id: `e${String(nextId++)}`, ...entry, ...inner };
	});
}

async function render(entries: unknown[], before: number | null = null): Promise<void> {
	pages.set(null, { status: 200, body: { entries: withIds(entries), before } });
	const { default: AccessTrailView } = await import('./AccessTrailView.svelte');
	component = mount(AccessTrailView, { target });
	await settle();
}

const items = (): HTMLElement[] => [...target.querySelectorAll<HTMLElement>('li[data-entry-kind]')];
const text = (el: Element | null | undefined): string => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('each kind of entry', () => {
	it('a plan run with a key: its status, its write steps (not what they wrote), its steps under it', async () => {
		await render([{
			kind: 'plan', key: 'k1', trigger: 'tr-1', startedBy: 'hand', at: NOW, person: IDA, status: 'done',
			writeSteps: 3,
			entries: [{ kind: 'step', action: 'mail_send', target: 'to=<address>', at: NOW, person: IDA, status: 'done' }],
		}]);
		const [li] = items();
		expect(li?.dataset['entryKind']).toBe('plan');
		expect(text(li)).toContain('Lauf eines Plans');
		expect(text(li)).toContain('von Hand gestartet');
		expect(text(li?.querySelector('[data-status]'))).toBe('Abgeschlossen');
		expect(text(li?.querySelector('[data-targets]'))).toBe('3 Schreibschritte');
		expect(text(li)).not.toContain('geschrieben');
		const details = li?.querySelector('details');
		expect(details).not.toBeNull();
		expect(text(details?.querySelector('[data-entry-kind="step"]'))).toContain('mail_send');
	});

	it('a plan run without a key: "–" for its targets, no number, nothing to open', async () => {
		await render([{
			kind: 'plan', key: null, trigger: 'tr-1', startedBy: 'schedule', at: NOW, person: IDA, status: 'interrupted',
			writeSteps: null, entries: [],
		}]);
		const [li] = items();
		const targets = text(li?.querySelector('[data-targets]'));
		expect(targets).toBe('–');
		expect(targets).not.toMatch(/\d/);
		expect(li?.querySelector('details')).toBeNull();
		expect(text(li?.querySelector('[data-status]'))).toBe('Unterbrochen');
		expect(text(li)).toContain('nach Zeitplan');
	});

	it('a bulk run: windows, targets as a lower bound, and the planned halt', async () => {
		await render([{
			kind: 'bulk', runId: 'r1', action: 'bulk:apply', host: 'shop.example.invalid', at: NOW, person: IDA, status: 'halted',
			planned: true, windows: 3, targets: { written: 40, failed: 0, atLeast: true },
		}]);
		const [li] = items();
		expect(text(li)).toContain('Sammellauf');
		expect(text(li)).toContain('3 Fenster');
		expect(text(li?.querySelector('[data-targets]'))).toBe('mindestens 40 geschrieben, mindestens 0 fehlgeschlagen');
		expect(text(li?.querySelector('[data-note]'))).toBe('Angehalten wie geplant, wartet auf dich');
	});

	it('a bulk run that did not halt as planned says nothing of a plan', async () => {
		await render([{
			kind: 'bulk', runId: 'r1', action: 'bulk:apply', host: null, at: NOW, person: IDA, status: 'done',
			planned: false, windows: 1, targets: { written: 1, failed: 0, atLeast: false },
		}]);
		expect(items()[0]?.querySelector('[data-note]')).toBeNull();
		expect(text(items()[0]?.querySelector('[data-targets]'))).toBe('1 geschrieben, 0 fehlgeschlagen');
	});

	it('a read is named a read; another event by its own word', async () => {
		await render([
			{ kind: 'event', action: 'GET /api/threads/:id', target: '/api/threads/t-1', phase: 'read', at: NOW, person: IDA },
			{ kind: 'event', action: 'oauth:consent', target: null, phase: 'success', at: NOW, person: IDA },
		]);
		const [read, other] = items();
		expect(text(read)).toContain('Gelesen');
		expect(text(read)).toContain('/api/threads/t-1');
		expect(text(other)).toContain('Ereignis');
		expect(text(other)).not.toContain('Gelesen');
	});
});

describe('statuses and notes come from the engine and are named', () => {
	const WORDS: Record<string, string> = {
		running: 'Läuft', done: 'Abgeschlossen', halted: 'Angehalten', ended: 'Beendet',
		refused: 'Abgelehnt', failed: 'Fehlgeschlagen', interrupted: 'Unterbrochen',
	};
	it('each of the seven statuses has its word, and none is "not recorded"', async () => {
		await render(Object.keys(WORDS).map((status) => ({ kind: 'step', action: `a-${status}`, target: null, at: NOW, person: IDA, status })));
		const got = items().map((li) => text(li.querySelector('[data-status]')));
		expect(got).toEqual(Object.values(WORDS));
	});

	it('a step no source speaks for is "not recorded", not a guess', async () => {
		await render([{ kind: 'step', action: 'x', target: null, at: NOW, person: IDA, status: null, note: 'no-result' }]);
		expect(text(items()[0]?.querySelector('[data-status]'))).toBe('Ohne Angabe');
		expect(text(items()[0]?.querySelector('[data-note]'))).toBe('Ein Ergebnis ist nicht festgehalten.');
	});

	it('a rejected approval says who rejected it: the owner, a helper, or nobody named', async () => {
		const step = { kind: 'step', action: 'mail_send', target: null, at: NOW, person: IDA, status: 'ended', note: 'approval-rejected' };
		await render([
			{ ...step, decidedBy: 'owner' },
			{ ...step, decidedBy: 'mandate:ben@example.invalid' },
			{ ...step, decidedBy: null },
		]);
		const notes = items().map((li) => text(li.querySelector('[data-note]')));
		expect(notes).toEqual([
			'Freigabe abgelehnt, nicht gesendet (von dir)',
			'Freigabe abgelehnt, nicht gesendet (von ben@example.invalid)',
			'Freigabe abgelehnt, nicht gesendet',
		]);
	});

	it('each note has its own words', async () => {
		const notes = ['awaits-answer', 'awaits-approval', 'question-open', 'approval-expired', 'send-unknown'];
		await render(notes.map((note) => ({ kind: 'step', action: note, target: null, at: NOW, person: IDA, status: 'running', note })));
		expect(items().map((li) => text(li.querySelector('[data-note]')))).toEqual([
			'Wartet auf eine Antwort', 'Wartet auf eine Freigabe',
			'In dieser Sitzung ist noch eine Frage offen. Ob sie zu diesem Schritt gehört, ist nicht festgehalten.',
			'Freigabe abgelaufen, nicht gesendet', 'Freigegeben. Ob die Mail gesendet wurde, ist nicht bekannt.',
		]);
	});
});

describe('the states around the list', () => {
	it('a helper\'s session is told the log is the owner\'s', async () => {
		pages.set(null, { status: 403, body: { error: 'Forbidden' } });
		const { default: AccessTrailView } = await import('./AccessTrailView.svelte');
		component = mount(AccessTrailView, { target });
		await settle();
		expect(text(target.querySelector('[data-state="owner-only"]'))).toBe('Das Instanz-Protokoll kann nur der Inhaber dieser Instanz lesen. Wenn du etwas daraus brauchst, wende dich an den Inhaber.');
		expect(target.querySelector('[data-state="error"]')).toBeNull();
	});

	it('a failed load says so and offers to try again', async () => {
		pages.set(null, { status: 500, body: {} });
		const { default: AccessTrailView } = await import('./AccessTrailView.svelte');
		component = mount(AccessTrailView, { target });
		await settle();
		const error = target.querySelector('[data-state="error"]');
		expect(text(error)).toContain('Die Einträge konnten nicht geladen werden.');
		pages.set(null, { status: 200, body: { entries: withIds([{ kind: 'event', action: 'a', target: null, phase: 'read', at: NOW, person: IDA }]), before: null } });
		error?.querySelector('button')?.click();
		await settle();
		expect(items()).toHaveLength(1);
	});

	it('no entries: the empty line', async () => {
		await render([]);
		expect(text(target.querySelector('[data-state="empty"]'))).toBe('Noch keine Einträge.');
	});
});

describe('filters and older pages', () => {
	it('the person filter keeps one person\'s entries', async () => {
		await render([
			{ kind: 'event', action: 'a', target: 'ida-row', phase: 'read', at: NOW, person: IDA },
			{ kind: 'event', action: 'b', target: 'ben-row', phase: 'read', at: NOW, person: BEN },
		]);
		const select = target.querySelector<HTMLSelectElement>('[data-filter="person"]')!;
		expect([...select.options].map((o) => o.textContent)).toEqual(['Alle Personen', 'IDA', 'ben@example.invalid']);
		select.value = 'M-2';
		select.dispatchEvent(new Event('change'));
		await settle();
		expect(items().map((li) => text(li))).toEqual([expect.stringContaining('ben-row')]);
	});

	it('the period filter leaves out what is older', async () => {
		const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
		await render([
			{ kind: 'event', action: 'a', target: 'new-row', phase: 'read', at: NOW, person: IDA },
			{ kind: 'event', action: 'b', target: 'old-row', phase: 'read', at: old, person: IDA },
		]);
		const select = target.querySelector<HTMLSelectElement>('[data-filter="period"]')!;
		select.value = '1d';
		select.dispatchEvent(new Event('change'));
		await settle();
		expect(items().map((li) => text(li))).toEqual([expect.stringContaining('new-row')]);
		select.value = '7d';
		select.dispatchEvent(new Event('change'));
		await settle();
		expect(items()).toHaveLength(2);
	});

	it('"load older" asks below the oldest row and appends; without `before` there is no button', async () => {
		pages.set('41', { status: 200, body: { entries: withIds([{ kind: 'event', action: 'b', target: 'older-row', phase: 'read', at: NOW, person: IDA }]), before: null } });
		await render([{ kind: 'event', action: 'a', target: 'newer-row', phase: 'read', at: NOW, person: IDA }], 41);
		const more = [...target.querySelectorAll('button')].find((b) => text(b) === 'Ältere laden');
		expect(more).toBeDefined();
		more?.click();
		await settle();
		expect(urls.at(-1)).toMatch(/\/access-trail\?before=41$/);
		expect(items().map((li) => text(li))).toEqual([expect.stringContaining('newer-row'), expect.stringContaining('older-row')]);
		expect([...target.querySelectorAll('button')].find((b) => text(b) === 'Ältere laden')).toBeUndefined();
	});

	it('an entry that comes again on the older page, because it crosses the edge, is kept once', async () => {
		const run = { kind: 'plan', id: 'plan:k1', key: 'k1', trigger: 'tr-1', startedBy: 'hand', at: NOW, person: IDA, status: 'done', writeSteps: 0, entries: [] };
		pages.set('41', { status: 200, body: { entries: [run, { kind: 'event', id: 'event:3', action: 'b', target: 'older-row', phase: 'read', at: NOW, person: IDA }], before: null } });
		await render([run], 41);
		[...target.querySelectorAll('button')].find((b) => text(b) === 'Ältere laden')?.click();
		await settle();
		expect(items().map((li) => li.dataset['entryKind'])).toEqual(['plan', 'event']);
	});

	it('after a page that was not complete, the copy that comes again replaces the one held; after a complete one, not', async () => {
		const run = (writeSteps: number | null) => ({ kind: 'plan', id: 'plan:k1', key: 'k1', trigger: 'tr-1', startedBy: 'hand', at: NOW, person: IDA, status: 'done', writeSteps, entries: [] });
		const steps = (): string => text(target.querySelector('li[data-entry-kind="plan"] [data-targets]'));
		pages.set('41', { status: 200, body: { entries: [run(4)], before: null } });
		pages.set(null, { status: 200, body: { entries: [run(null)], before: 41, complete: false } });
		const { default: AccessTrailView } = await import('./AccessTrailView.svelte');
		component = mount(AccessTrailView, { target });
		await settle();
		expect(steps()).toBe('–');
		[...target.querySelectorAll('button')].find((b) => text(b) === 'Ältere laden')?.click();
		await settle();
		expect(items()).toHaveLength(1);
		expect(steps()).toBe('4 Schreibschritte');
		// The control: held from a complete page, the first copy stays.
		unmount(component);
		pages.set(null, { status: 200, body: { entries: [run(2)], before: 41 } });
		component = mount(AccessTrailView, { target });
		await settle();
		[...target.querySelectorAll('button')].find((b) => text(b) === 'Ältere laden')?.click();
		await settle();
		expect(steps()).toBe('2 Schreibschritte');
	});

	it('a failed older page keeps what is on screen and says the older entries are missing', async () => {
		pages.set('41', { status: 500, body: {} });
		await render([{ kind: 'event', action: 'a', target: 'newer-row', phase: 'read', at: NOW, person: IDA }], 41);
		[...target.querySelectorAll('button')].find((b) => text(b) === 'Ältere laden')?.click();
		await settle();
		expect(items().map((li) => text(li))).toEqual([expect.stringContaining('newer-row')]);
		expect(text(target.querySelector('[data-state="older-error"]'))).toBe('Ältere Einträge konnten nicht geladen werden.');
		expect(target.querySelector('[data-state="error"]')).toBeNull();
	});

	it('a page that could not hold every entry whole says so, and a complete one says nothing', async () => {
		pages.set('41', { status: 200, body: { entries: [], before: null, complete: false } });
		await render([{ kind: 'event', action: 'a', target: 'r', phase: 'read', at: NOW, person: IDA }], 41);
		expect(target.querySelector('[data-state="incomplete"]')).toBeNull();
		[...target.querySelectorAll('button')].find((b) => text(b) === 'Ältere laden')?.click();
		await settle();
		expect(text(target.querySelector('[data-state="incomplete"]'))).toBe('Einige Einträge sind hier nicht ganz zu sehen.');
	});
});
