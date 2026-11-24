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

// A watch the instance's network_policy keeps from its page (U-392): the row says so in the UI's
// language, with the way out, and sets the host apart as a value. A watch whose page is read says
// nothing.

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let rows: Record<string, unknown>[] = [];
const before = getLocale();

const WATCH = { id: 'w-1', title: 'Preise', status: 'open', effect: 'run_agent', source: 'watch', watch_config: JSON.stringify({ url: 'https://shop.example/preise', interval_minutes: 60 }), confirmed_at: '2026-01-01T00:00:00.000Z' };

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const u = String(url);
		if (u.endsWith('/triggers')) return json(200, { triggers: rows, viewer: 'owner' });
		if (u.endsWith('/triggers/paused-count')) return json(200, { viewer: 'owner', count: 0 });
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

async function render(locale: 'de' | 'en', refused: Record<string, unknown> | undefined): Promise<HTMLElement | null> {
	setLocale(locale);
	rows = [refused === undefined ? WATCH : { ...WATCH, blocked_reason: refused }];
	const { default: TriggersView } = await import('./TriggersView.svelte');
	component = mount(TriggersView, { target });
	await settle();
	return target.querySelector<HTMLElement>('[data-blocked-reason]');
}

const CASES: Array<{ refused: Record<string, unknown>; de: string; en: string }> = [
	{
		refused: { kind: 'watch_allow_list', host: 'shop.example' },
		de: 'Liest die Seite nicht: Der Host shop.example steht nicht in der Netzwerk-Liste dieser Instanz. Aufnehmen kann ihn der Betreiber der Instanz.',
		en: "Not reading the page: the host shop.example is not in this instance's network allow-list. The instance operator can add it.",
	},
	{
		refused: { kind: 'watch_deny_all' },
		de: 'Liest die Seite nicht: Diese Instanz liest keine Webseiten. Ändern kann das der Betreiber der Instanz.',
		en: 'Not reading the page: this instance reads no web pages. The instance operator can change that.',
	},
	{
		refused: { kind: 'watch_https' },
		de: 'Liest die Seite nicht: Diese Instanz liest nur https-Seiten. Bitte lynox im Chat, die Beobachtung auf die https-Adresse umzustellen.',
		en: 'Not reading the page: this instance only reads https pages. Ask lynox in the chat to switch the watch to the https address.',
	},
];

describe('a watch the network policy keeps from its page', () => {
	for (const c of CASES) {
		for (const locale of ['de', 'en'] as const) {
			it(`says why and what to do, ${String(c.refused['kind'])}, ${locale}`, async () => {
				const line = await render(locale, c.refused);
				expect(line!.textContent).toBe(locale === 'de' ? c.de : c.en);
				expect(line!.dataset['blockedReason']).toBe(c.refused['kind']);
			});
		}
	}

	it('sets the host apart as a value, and only the host', async () => {
		const line = await render('de', { kind: 'watch_allow_list', host: 'shop.example' });
		const boxes = line!.querySelectorAll('bdi[data-foreign-value]');
		expect(boxes).toHaveLength(1);
		expect(boxes[0]!.textContent).toBe('shop.example');
	});

	it('gives the host box and each label after its dot the block classes', async () => {
		const line = await render('de', { kind: 'watch_allow_list', host: 'preise.lieferant-beispiel.ch' });
		const box = line!.querySelector<HTMLElement>('bdi[data-foreign-value]')!;
		expect(box.textContent).toBe('preise.lieferant-beispiel.ch');
		expect(box.classList.contains('inline-block')).toBe(true);
		expect(box.classList.contains('max-w-full')).toBe(true);
		const block = (s: Element): boolean => s.classList.contains('inline-block') && s.classList.contains('max-w-full') && s.classList.contains('[overflow-wrap:anywhere]');
		expect([...box.querySelectorAll('span')].map((s) => [s.textContent, block(s)]))
			.toEqual([['preise.', true], ['lieferant-beispiel.', true], ['ch', true]]);
		expect(box.querySelectorAll('wbr')).toHaveLength(3);
	});

	for (const [host, pieces] of [['shop.example.', ['shop.', 'example.']], ['a..b', ['a..', 'b']], ['.x', ['.', 'x']]] as const) {
		it(`shows the host exactly as the policy compares it, every dot kept: ${host}`, async () => {
			const line = await render('de', { kind: 'watch_allow_list', host });
			const box = line!.querySelector<HTMLElement>('bdi[data-foreign-value]')!;
			expect(box.textContent).toBe(host);
			expect([...box.querySelectorAll('span')].map((s) => s.textContent)).toEqual(pieces);
		});
	}

	it('offers no run now on a watch the policy keeps from its page, and keeps the row\'s other buttons', async () => {
		setLocale('de');
		rows = [{ ...WATCH, id: 'w-blocked', title: 'Gesperrt', blocked_reason: { kind: 'watch_deny_all' } }, { ...WATCH, id: 'w-read', title: 'Gelesen' }];
		const { default: TriggersView } = await import('./TriggersView.svelte');
		component = mount(TriggersView, { target });
		await settle();
		const card = (title: string): HTMLElement => [...target.querySelectorAll<HTMLElement>('[data-trigger-title]')].find((e) => e.textContent === title)!.closest<HTMLElement>('.group')!;
		const labels = (el: HTMLElement): string[] => [...el.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent!.trim());
		const blocked = card('Gesperrt');
		const read = card('Gelesen');
		expect(blocked.querySelector('[data-blocked-reason]')).not.toBeNull();
		expect(blocked.querySelector('[data-trigger-run-now]')).toBeNull();
		expect(read.querySelector('[data-trigger-run-now]')).not.toBeNull();
		expect(labels(blocked)).toContain('Pausieren');
		expect(labels(blocked)).toContain('Löschen');
		expect(labels(blocked)).toEqual(labels(read).filter((l) => l !== read.querySelector('[data-trigger-run-now]')!.getAttribute('aria-label')));
	});

	it('a watch that waits for its takeover and that the policy keeps from its page says both, and offers only the takeover, chat and delete', async () => {
		setLocale('de');
		rows = [{ ...WATCH, id: 'w-both', title: 'Beides', paused: true, blocked_reason: { kind: 'watch_deny_all' } }];
		const { default: TriggersView } = await import('./TriggersView.svelte');
		component = mount(TriggersView, { target });
		await settle();
		const card = [...target.querySelectorAll<HTMLElement>('[data-trigger-title]')].find((e) => e.textContent === 'Beides')!.closest<HTMLElement>('.group')!;
		expect(card.querySelector('[data-trigger-paused]')!.textContent).toBe('Pausiert · Übernahme nötig');
		expect(card.querySelector('[data-blocked-reason]')!.textContent).toBe('Liest die Seite nicht: Diese Instanz liest keine Webseiten. Ändern kann das der Betreiber der Instanz.');
		expect(card.querySelector('[data-trigger-run-now]')).toBeNull();
		expect(card.querySelector('[data-trigger-toggle]')).toBeNull();
		expect(card.querySelector('[data-trigger-takeover]')).not.toBeNull();
		expect([...card.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent!.trim()))
			.toEqual(['Im Chat verwalten', 'Löschen', card.querySelector('[data-trigger-takeover]')!.textContent!.trim()]);
	});

	it('CONTROL: a watch whose page is read offers run now', async () => {
		await render('de', undefined);
		expect(target.querySelector('[data-trigger-run-now]')).not.toBeNull();
	});

	it('CONTROL: a watch whose page is read says nothing', async () => {
		expect(await render('de', undefined)).toBeNull();
	});
});
