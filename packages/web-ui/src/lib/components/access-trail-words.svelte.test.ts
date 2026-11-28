import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { setLocale, getLocale } from '../i18n.svelte.js';

// The owner's view says what a person with delegated access read in words, with the route once
// and muted next to it as the proof (U-306 B1); the same read made again is one line with a
// count (C); a memory entry waiting for review is said as such (B4); and the page a helper may not
// read says nothing about whose entries it holds (B5).

const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let answer: { status: number; body: unknown } = { status: 200, body: { entries: [], before: null } };
let locale: string;

const IDA = { email: 'ida@example.invalid', display: 'IDA', mandateId: 'M-1' };
const NOW = Date.now();
const at = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString();

beforeEach(() => {
	locale = getLocale();
	setLocale('de');
	vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } })));
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
	setLocale(locale as 'de' | 'en');
});

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

let nextId = 0;
const read = (action: string, target: string | null, minutesAgo = 1, phase = 'read'): Record<string, unknown> =>
	({ kind: 'event', id: `ev${String(nextId++)}`, action, target, phase, at: at(minutesAgo), person: IDA });

async function render(entries: unknown[]): Promise<void> {
	answer = { status: 200, body: { entries, before: null, complete: true } };
	const { default: AccessTrailView } = await import('./AccessTrailView.svelte');
	component = mount(AccessTrailView, { target });
	await settle();
}

const items = (): HTMLElement[] => [...target.querySelectorAll<HTMLElement>('ul > li[data-entry-kind]')];
const text = (el: Element | null | undefined): string => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('a read in words, the route once (U-306 B1)', () => {
	it('says what was read, then the route once, muted, without a second copy of the path', async () => {
		await render([read('GET /api/threads/:id/messages', '/api/threads/t-1/messages')]);
		const [li] = items();
		expect(text(li?.querySelector('[data-word]'))).toBe('Nachrichten eines Chats');
		expect(text(li?.querySelector('[data-route]'))).toBe('GET /api/threads/t-1/messages');
		expect(text(li)).not.toContain('·');
		expect(text(li).match(/\/api\/threads/g)).toHaveLength(1);
		expect(text(li)).toContain('Lesezugriff');
	});

	it('breaks the route only after a slash or a query sign, never inside a name', async () => {
		await render([read('GET /api/files/read', '/api/files/read?path=notes.md')]);
		const route = items()[0]?.querySelector('[data-route]');
		expect(route?.querySelectorAll('wbr').length).toBe(6);
		const pieces = [...(route?.childNodes ?? [])].filter((n) => n.nodeType === 3 && n.textContent !== '').map((n) => n.textContent);
		expect(pieces).toEqual(['GET /', 'api/', 'files/', 'read?', 'path=', 'notes.md']);
	});

	it('shows only the route for a route without a word', async () => {
		await render([read('GET /api/not-worded', '/api/not-worded')]);
		const [li] = items();
		expect(li?.querySelector('[data-word]')).toBeNull();
		expect(text(li?.querySelector('[data-route]'))).toBe('GET /api/not-worded');
	});

	it('keeps an action that is not a route with its target after it', async () => {
		await render([read('http_request:read', 'GET example.invalid/')]);
		expect(text(items()[0]?.querySelector('[data-route]'))).toBe('http_request:read · GET example.invalid/');
	});

	it('names a settings page by the name the settings index shows it under', async () => {
		await render([read('GET /api/backups', '/api/backups')]);
		expect(text(items()[0]?.querySelector('[data-word]'))).toBe('Einstellungen: Backups');
	});

	it('says a refused read with its word, and keeps the two reveal forms', async () => {
		await render([
			read('GET /api/threads/:id/messages', '/api/threads/t-1/messages', 1, 'refused'),
			read('GET /api/not-worded', '/api/not-worded', 2, 'refused'),
			read('GET /api/vault/key', '/api/vault/key?reveal=true', 3, 'refused'),
		]);
		const [a, b, c] = items();
		expect(text(a)).toContain('Versuch: Nachrichten eines Chats (verweigert)');
		// The word stands in the refusal, not again after it.
		expect(a?.querySelector('[data-word]')).toBeNull();
		expect(text(b)).toContain('Versuch (verweigert)');
		expect(text(c)).toContain('Versuch, den Tresorschlüssel anzuzeigen (verweigert)');
	});

	it('in English too', async () => {
		setLocale('en');
		await render([read('GET /api/inbox/items/:id/full', '/api/inbox/items/i-1/full'), read('GET /api/backups', '/api/backups', 2)]);
		const [a, b] = items();
		expect(text(a?.querySelector('[data-word]'))).toBe('An email, in full');
		expect(text(b?.querySelector('[data-word]'))).toBe('Settings: Backups');
	});
});

describe('the words added at the design gate (U-306 N1)', () => {
	it('says the instance settings, and a refused read of the log as an attempt on the log', async () => {
		await render([read('GET /api/config', '/api/config'), read('GET /api/access-trail', '/api/access-trail', 2, 'refused')]);
		const [config, refused] = items();
		expect(text(config?.querySelector('[data-word]'))).toBe('Einstellungen der Instanz');
		expect(text(refused)).toContain('Versuch: Instanz-Protokoll (verweigert)');
		setLocale('en');
		flushSync();
		expect(text(items()[0]?.querySelector('[data-word]'))).toBe('Instance settings');
		expect(text(items()[1])).toContain('Attempt: Instance log (refused)');
	});

	it('names what the route returns, not less: a contact with its last interaction, a run with task and answer, a plan', async () => {
		await render([
			read('GET /api/inbox/contacts/:email', '/api/inbox/contacts/a%40example.invalid'),
			read('GET /api/history/runs/:id', '/api/history/runs/r-1', 2),
			read('GET /api/tasks/:id/stamp-preview', '/api/tasks/t-1/stamp-preview', 3, 'refused'),
		]);
		const [contact, run, plan] = items();
		expect(text(contact?.querySelector('[data-word]'))).toBe('Kontakt zu einer Adresse, mit letzter Interaktion');
		expect(text(run?.querySelector('[data-word]'))).toBe('Ein Lauf mit Auftrag und Antwort');
		expect(text(plan)).toContain('Versuch: Vorschau der Freigabe eines Plans (verweigert)');
	});

	it('says the inbox as the app does', async () => {
		await render([read('GET /api/inbox/cold-start', '/api/inbox/cold-start'), read('GET /api/inbox/rules', '/api/inbox/rules', 2)]);
		expect(items().map((li) => text(li.querySelector('[data-word]')))).toEqual(['Stand des Nachladens des Posteingangs', 'Regeln des Posteingangs']);
	});
});

describe('a span within one second is one time (U-306 N1)', () => {
	const same = (ms: number): string => new Date(Math.floor(NOW / 1000) * 1000 - 120_000 + ms).toISOString();
	const fixed = (action: string, target: string, ms: number, auto = false): Record<string, unknown> =>
		({ kind: 'event', id: `ev${String(nextId++)}`, action, target, phase: 'read', at: same(ms), person: IDA, ...(auto ? { auto: true } : {}) });

	it('in a repeat line and in a group, and keeps a span across seconds', async () => {
		await render([
			fixed('GET /api/bulk/runs/:id', '/api/bulk/runs/b-1', 900),
			fixed('GET /api/bulk/runs/:id', '/api/bulk/runs/b-1', 100),
			fixed('GET /api/runs/active', '/api/runs/active', 50, true),
			fixed('GET /api/tasks', '/api/tasks', 10, true),
			fixed('GET /api/workflows/:id', '/api/workflows/w-1', -1500),
			fixed('GET /api/workflows/:id', '/api/workflows/w-1', -3000),
		]);
		const [repeat, group, across] = items();
		const one = new Date(same(100)).toLocaleString('de-CH');
		expect(text(repeat?.querySelector('[data-repeat-summary]'))).toContain(`(2×, ${one})`);
		expect(text(repeat)).not.toContain('–');
		expect(text(group?.querySelector('[data-polls-summary]'))).toBe(`2 Statusabfragen (${one})`);
		expect(text(across?.querySelector('[data-repeat-summary]'))).toMatch(/\(2×, .+–.+\)/);
	});
});

describe('the name of what was read', () => {
	it('stands muted after the word, the route with its id after it', async () => {
		await render([{ ...read('GET /api/threads/:id/messages', '/api/threads/t-1/messages'), name: 'Angebot Testfirma' }]);
		const [li] = items();
		expect(text(li?.querySelector('[data-word]'))).toBe('Nachrichten eines Chats');
		expect(text(li?.querySelector('[data-name]'))).toBe('Angebot Testfirma');
		expect(li?.querySelector('[data-name]')?.className).toContain('text-text-muted');
		expect(text(li)).toMatch(/Nachrichten eines Chats Angebot Testfirma GET \/api\/threads\/t-1\/messages$/);
	});

	it('is absent for an object that is gone: the route with its id is all', async () => {
		await render([read('GET /api/threads/:id/messages', '/api/threads/t-gone/messages')]);
		const [li] = items();
		expect(li?.querySelector('[data-name]')).toBeNull();
		expect(text(li?.querySelector('[data-route]'))).toBe('GET /api/threads/t-gone/messages');
	});

	it('stands on a refused read and on a repeat line too, as text, never as markup', async () => {
		await render([
			{ ...read('GET /api/inbox/items/:id/full', '/api/inbox/items/i-1/full', 1, 'refused'), name: '<b>Rechnung</b>' },
			{ ...read('GET /api/workflows/:id', '/api/workflows/w-1', 2), name: 'Wochenbericht' },
			{ ...read('GET /api/workflows/:id', '/api/workflows/w-1', 3), name: 'Wochenbericht' },
		]);
		const [refused, repeat] = items();
		expect(text(refused?.querySelector('[data-name]'))).toBe('<b>Rechnung</b>');
		expect(refused?.querySelector('b')).toBeNull();
		expect(repeat?.dataset['entryKind']).toBe('repeat');
		expect(text(repeat?.querySelector('[data-repeat-summary] [data-name]'))).toBe('Wochenbericht');
	});
});

describe('the same read again, one line (U-306 C)', () => {
	it('folds three reads of the same run into one line with the count, the span and the route', async () => {
		await render([
			read('GET /api/bulk/runs/:id', '/api/bulk/runs/b-1', 1),
			read('GET /api/bulk/runs/:id', '/api/bulk/runs/b-1', 2),
			read('GET /api/bulk/runs/:id', '/api/bulk/runs/b-1', 3),
			read('GET /api/bulk/runs/:id', '/api/bulk/runs/b-2', 4),
		]);
		const list = items();
		expect(list.map((li) => li.dataset['entryKind'])).toEqual(['repeat', 'event']);
		const summary = text(list[0]?.querySelector('[data-repeat-summary]'));
		expect(summary).toMatch(/^Lesezugriff Stand eines Massenlaufs \(3×, .+–.+\) GET \/api\/bulk\/runs\/b-1$/);
		// Opening it shows each read.
		expect(list[0]?.querySelectorAll('details [data-entry-kind="event"]')).toHaveLength(3);
	});
});

describe('a memory entry saved for review (U-306 B4)', () => {
	it('says "Zur Prüfung gespeichert", not "Beendet"', async () => {
		await render([{ kind: 'step', id: 's-1', action: 'instance:remember#create:create', target: 'knowledge', at: at(1), person: IDA, status: 'review' }]);
		expect(text(items()[0]?.querySelector('[data-status]'))).toBe('Zur Prüfung gespeichert');
		setLocale('en');
		flushSync();
		expect(text(items()[0]?.querySelector('[data-status]'))).toBe('Saved for review');
	});
});

describe('the page a helper may not read (U-306 B5)', () => {
	it('drops the line about whose entries it holds', async () => {
		answer = { status: 403, body: { error: 'owner only' } };
		const { default: AccessTrailView } = await import('./AccessTrailView.svelte');
		component = mount(AccessTrailView, { target });
		await settle();
		expect(target.querySelector('[data-state="owner-only"]')).not.toBeNull();
		expect(text(target)).not.toContain('Einträge von Personen, denen du Zugang gegeben hast.');
	});

	it('keeps it for the owner', async () => {
		await render([read('GET /api/backups', '/api/backups')]);
		expect(text(target)).toContain('Einträge von Personen, denen du Zugang gegeben hast.');
	});
});

describe('the screen of an ended access (U-306 B2)', () => {
	it('says the access has ended and whom to ask, with no button and no link, in both languages', async () => {
		const { default: AccessEndedNotice } = await import('./AccessEndedNotice.svelte');
		component = mount(AccessEndedNotice, { target });
		flushSync();
		expect(text(target)).toBe('Zugang beendet Dein Zugang zu dieser Instanz ist beendet. Brauchst du ihn wieder, wende dich an den Inhaber.');
		expect(target.querySelectorAll('button, a')).toHaveLength(0);
		setLocale('en');
		flushSync();
		expect(text(target)).toBe('Access ended Your access to this instance has ended. If you need it again, contact the owner.');
	});
});

describe('the shell shows the ended access in its session banner (U-306 B2)', () => {
	// The shell is too large to mount here; its banner is read from the source: the ended access
	// comes first, as an alert, and its branch holds neither the dismiss nor the sign-in control.
	const SHELL = readFileSync(join(__dirname, 'AppShell.svelte'), 'utf8');
	it('takes the ended access before the memory lock and the expired session, with no control in its branch', () => {
		const open = SHELL.indexOf('{#if isAccessEnded() || mandateMemoryBlocked() !== null || isSessionExpired()}');
		expect(open).toBeGreaterThan(0);
		const branch = SHELL.slice(SHELL.indexOf('{#if isAccessEnded()}', open), SHELL.indexOf('{:else if mandateMemoryBlocked() !== null}', open));
		expect(branch).toContain('<AccessEndedNotice />');
		expect(branch).not.toMatch(/<button|<a /);
		expect(SHELL.slice(open, open + 400)).toContain("role={isAccessEnded() || mandateMemoryBlocked() !== null ? 'alert' : undefined}");
	});
});

