import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readable } from 'svelte/store';

// A message the instance's own spending cap blocked: the note says why, when the cap opens again,
// and who can change it — the limits page on an instance whose owner sets the cap, support on a
// managed plan, the owner in someone else's workspace. The engine's English reason stays a debug
// line. Live (from `done`) and after a reload (from the note) the words are the same.

const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
};
let svelte: SvelteClient;

vi.mock('$app/stores', () => ({ page: readable({ url: new URL('http://localhost/app') }) }));
vi.mock('$app/navigation', () => ({
	goto: vi.fn(), afterNavigate: vi.fn(), beforeNavigate: vi.fn(), onNavigate: vi.fn(), invalidate: vi.fn(), invalidateAll: vi.fn(),
}));
vi.mock('./MarkdownRenderer.svelte', () => ({
	default: (anchor: Comment, props: { content: string }) => {
		const el = document.createElement('div');
		el.textContent = props.content;
		anchor.before(el);
	},
}));

function sseStream(): { body: ReadableStream<Uint8Array>; send: (type: string, data: unknown) => void; close: () => void } {
	const enc = new TextEncoder();
	let ctrl!: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
	return {
		body,
		send: (type, data) => ctrl.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)),
		close: () => { try { ctrl.close(); } catch { /* closed already */ } },
	};
}

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const settle = async (): Promise<void> => { for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0)); };

const DAILY = 'Daily spending cap ($5) reached. Today: $5.12.';
const MONTHLY = 'Monthly spending cap ($150) reached. This month: $150.40.';
const UNKNOWN = 'Spending cap (daily $5) cannot be checked: the history database did not open when lynox started.';
const DAILY_REF = { cap: 'daily', limitUSD: 5, spentUSD: 5.12 };
const MONTHLY_REF = { cap: 'monthly', limitUSD: 150, spentUSD: 150.4 };

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let store: typeof import('../stores/chat.svelte.js');
let i18n: typeof import('../i18n.svelte.js');
let notes: typeof import('../utils/budget-note.js');
let run: ReturnType<typeof sseStream> | undefined;

beforeEach(async () => {
	vi.stubGlobal('navigator', { onLine: true });
	vi.resetModules();
	svelte = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;
	store = await import('../stores/chat.svelte.js');
	i18n = await import('../i18n.svelte.js');
	notes = await import('../utils/budget-note.js');
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	run?.close();
	run = undefined;
	if (component) svelte.unmount(component);
	component = undefined;
	target.remove();
	store.newChat();
	localStorage.removeItem('lynox-chat');
	vi.unstubAllGlobals();
});

/** The instance as the page asks it: its billing tier ('' = self-host) and whose session it is. */
interface Instance { tier: string; viewer: 'owner' | 'mandate' }

function stubFetch(inst: Instance, extra?: (url: string) => Response | undefined): void {
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
		const url = String(input);
		const own = extra?.(url);
		if (own) return own;
		if (url.endsWith('/secrets/status')) return json({ managed: inst.tier === '' ? null : inst.tier });
		if (url.endsWith('/config')) return json({ viewer: inst.viewer, locks: {} });
		if (url.endsWith('/onboarding/status')) return json({ knowledgeDone: true, skipped: true, durableMemory: false, firstSessionAt: 'x' });
		if (url.endsWith('/sessions')) return json({ sessionId: 't1' });
		if (url.endsWith('/threads/t1')) return json({ thread: null });
		if (url.endsWith('/runs/active')) return json({ runs: [] });
		if (url.endsWith('/threads/t1/messages')) return json({ messages: [] });
		if (url.endsWith('/artifacts')) return json({ artifacts: [] });
		return json({});
	}));
}

/** Live: sends a message, renders the chat, ends the run with `done` = `data`. */
async function live(locale: 'de' | 'en', inst: Instance, data: Record<string, unknown>): Promise<void> {
	i18n.setLocale(locale);
	const stream = sseStream();
	run = stream;
	stubFetch(inst, (url) => url.endsWith('/sessions/t1/run')
		? new Response(stream.body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
		: undefined);
	void store.sendMessage('summarise the quarter');
	await settle();
	const { default: ChatView } = await import('./ChatView.svelte');
	component = svelte.mount(ChatView, { target });
	svelte.flushSync();
	await settle();
	stream.send('done', data);
	await settle();
	svelte.flushSync();
}

/** After a reload: the thread returns the blocked message and its note. */
async function reloaded(locale: 'de' | 'en', inst: Instance, note: Record<string, unknown>): Promise<void> {
	i18n.setLocale(locale);
	stubFetch(inst, (url) => url.includes('/threads/blocked/messages')
		? json({ messages: [{ role: 'user', content: 'summarise the quarter' }, { role: 'assistant', content: '', note }], activeRun: null })
		: undefined);
	await store.resumeThread('blocked');
	await settle();
	const { default: ChatView } = await import('./ChatView.svelte');
	component = svelte.mount(ChatView, { target });
	svelte.flushSync();
	await settle();
	svelte.flushSync();
}

const noteEl = (): Element | null => target.querySelector('[role="status"]');
const text = (el: Element | null | undefined): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const reason = (): string => text(target.querySelector('[data-budget-reason]'));
const next = (): Element | null => target.querySelector('[data-budget-next]');
const when = (cap: 'daily' | 'monthly', locale: 'de' | 'en'): string => {
	const now = new Date();
	return notes.formatResetWhen(notes.budgetResetAt(cap, now), now, locale);
};

const SELF: Instance = { tier: '', viewer: 'owner' };
const HOSTED: Instance = { tier: 'hosted', viewer: 'owner' };
const MANAGED: Instance = { tier: 'managed_pro', viewer: 'owner' };
const MANDATE: Instance = { tier: 'hosted', viewer: 'mandate' };

describe('a message the spending cap blocked says why, until when, and what to do', () => {
	it('de, daily cap, self-hosted owner: the reason with amounts and reset, then the limits page', async () => {
		await live('de', SELF, { result: DAILY, notice: 'run_blocked', budget: DAILY_REF });
		expect(reason()).toBe(`Das Tageslimit von $5 ist erreicht (heute $5.12). Es gilt wieder ab ${when('daily', 'de')}.`);
		expect(text(next())).toBe('Du kannst das Limit unter Einstellungen → Limits ändern.');
		expect(next()?.querySelector('a')?.getAttribute('href')).toBe('/app/settings/workspace/limits');
		// The engine's sentence stays, as a debug line in English under it.
		expect(noteEl()?.querySelector('[lang="en"]')?.textContent).toBe(DAILY);
		expect(target.querySelector('.ai-badge')).toBeNull();
	});

	it('en, daily cap, hosted with its own key: the owner sets the cap too', async () => {
		await live('en', HOSTED, { result: DAILY, notice: 'run_blocked', budget: DAILY_REF });
		expect(reason()).toBe(`The daily limit of $5 is reached (today $5.12). It resets ${when('daily', 'en')}.`);
		expect(text(next())).toBe('You can change the limit under Settings → Limits.');
		expect(next()?.querySelector('a')?.getAttribute('href')).toBe('/app/settings/workspace/limits');
	});

	for (const locale of ['de', 'en'] as const) {
		it(`${locale}, monthly cap on a managed plan: support changes it, by mail`, async () => {
			await live(locale, MANAGED, { result: MONTHLY, notice: 'run_blocked', budget: MONTHLY_REF });
			expect(reason()).toBe(i18n.tf('chat.note.budget.monthly', { limit: '$150', spent: '$150.40', when: when('monthly', locale) }));
			expect(text(next())).toBe(i18n.t('chat.note.budget.next_plan'));
			expect(next()?.querySelector('a')?.getAttribute('href')).toBe('mailto:support@lynox.ai');
		});

		it(`${locale}, someone else's workspace: only the owner can change it, and no link`, async () => {
			await live(locale, MANDATE, { result: DAILY, notice: 'run_blocked', budget: DAILY_REF });
			expect(text(next())).toBe(i18n.t('chat.note.budget.next_owner'));
			expect(next()?.querySelector('a')).toBeNull();
		});
	}

	it('de: the monthly reset reads "ab dem 1. …", never "ab am"', async () => {
		await live('de', MANAGED, { result: MONTHLY, notice: 'run_blocked', budget: MONTHLY_REF });
		expect(reason()).toMatch(/Es gilt wieder ab dem \d{1,2}\. \S+ um \d{2}:\d{2}\.$/);
		expect(reason()).not.toContain('ab am');
	});

	it('de, spend cannot be checked, self-hosted: no amounts, restart', async () => {
		await live('de', SELF, { result: UNKNOWN, notice: 'run_blocked', budget: { cap: 'unknown' } });
		expect(reason()).toBe('lynox kann die Ausgaben gerade nicht prüfen und sendet deshalb nichts.');
		expect(text(next())).toBe('Starte lynox neu.');
		expect(next()?.querySelector('a')).toBeNull();
	});

	it('en, spend cannot be checked, managed: write to support if it stays', async () => {
		await live('en', MANAGED, { result: UNKNOWN, notice: 'run_blocked', budget: { cap: 'unknown' } });
		expect(reason()).toBe("lynox can't check spending right now, so it sends nothing.");
		expect(text(next())).toBe('If it stays, write to support@lynox.ai.');
		expect(next()?.querySelector('a')?.getAttribute('href')).toBe('mailto:support@lynox.ai');
	});

	it('a budget the engine sends in an unknown shape names no reason: the note stays as before', async () => {
		await live('de', SELF, { result: DAILY, notice: 'run_blocked', budget: { cap: 'weekly', limitUSD: 5 } });
		expect(target.querySelector('[data-budget-reason]')).toBeNull();
		expect(text(noteEl())).toBe(`Vor dem Senden geprüft Diese Nachricht ging nicht an das KI-Modell. ${DAILY}`);
	});

	it('while the page does not know whose session it is, no step: a mandate is not sent to the limits page', async () => {
		const stream = sseStream();
		run = stream;
		i18n.setLocale('de');
		stubFetch(MANDATE, (url) => {
			if (url.endsWith('/config')) return json({}, 503);
			return url.endsWith('/sessions/t1/run') ? new Response(stream.body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }) : undefined;
		});
		void store.sendMessage('summarise the quarter');
		await settle();
		const { default: ChatView } = await import('./ChatView.svelte');
		component = svelte.mount(ChatView, { target });
		svelte.flushSync();
		stream.send('done', { result: DAILY, notice: 'run_blocked', budget: DAILY_REF });
		await settle();
		svelte.flushSync();
		expect(reason()).toContain('$5.12');
		expect(next()).toBeNull();
	});

	it('a tier probe that failed is no proof of self-host: no restart, no limits page', async () => {
		i18n.setLocale('de');
		const stream = sseStream();
		run = stream;
		stubFetch(MANAGED, (url) => {
			if (url.endsWith('/secrets/status')) return json({}, 500);
			return url.endsWith('/sessions/t1/run') ? new Response(stream.body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }) : undefined;
		});
		void store.sendMessage('summarise the quarter');
		await settle();
		const { default: ChatView } = await import('./ChatView.svelte');
		component = svelte.mount(ChatView, { target });
		svelte.flushSync();
		stream.send('done', { result: UNKNOWN, notice: 'run_blocked', budget: { cap: 'unknown' } });
		await settle();
		svelte.flushSync();
		expect(reason()).toBe('lynox kann die Ausgaben gerade nicht prüfen und sendet deshalb nichts.');
		expect(next()).toBeNull();
	});

	it('a tier probe that failed sends no one to the limits page for a reached cap either', async () => {
		i18n.setLocale('de');
		const stream = sseStream();
		run = stream;
		stubFetch(MANAGED, (url) => {
			if (url.endsWith('/secrets/status')) return json({}, 500);
			return url.endsWith('/sessions/t1/run') ? new Response(stream.body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }) : undefined;
		});
		void store.sendMessage('summarise the quarter');
		await settle();
		const { default: ChatView } = await import('./ChatView.svelte');
		component = svelte.mount(ChatView, { target });
		svelte.flushSync();
		stream.send('done', { result: DAILY, notice: 'run_blocked', budget: DAILY_REF });
		await settle();
		svelte.flushSync();
		expect(reason()).toContain('$5.12');
		expect(next()).toBeNull();
	});

	it('a note from this browser\'s copy of the chat (the server has no thread) still names the step', async () => {
		localStorage.setItem('lynox-chat', JSON.stringify({
			sessionId: 't1',
			threads: { t1: [
				{ role: 'user', content: 'summarise the quarter' },
				{ role: 'assistant', content: UNKNOWN, blocks: [{ type: 'notice', code: 'run_blocked', text: UNKNOWN, budget: { cap: 'unknown' } }] },
			] },
		}));
		vi.resetModules();
		svelte = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;
		store = await import('../stores/chat.svelte.js');
		i18n = await import('../i18n.svelte.js');
		i18n.setLocale('de');
		stubFetch(SELF, (url) => url.endsWith('/threads/t1/messages') ? json({ messages: [], threadMissing: true }) : undefined);
		const { default: ChatView } = await import('./ChatView.svelte');
		component = svelte.mount(ChatView, { target });
		svelte.flushSync();
		await settle();
		svelte.flushSync();
		expect(reason()).toBe('lynox kann die Ausgaben gerade nicht prüfen und sendet deshalb nichts.');
		expect(text(next())).toBe('Starte lynox neu.');
		localStorage.removeItem('lynox-chat');
	});

	it('control: a hook\'s block carries no budget and shows no reason or step', async () => {
		await live('de', SELF, { result: 'Run blocked: AI budget for this period reached.', notice: 'run_blocked' });
		expect(target.querySelector('[data-budget-reason]')).toBeNull();
		expect(next()).toBeNull();
	});

	for (const locale of ['de', 'en'] as const) {
		it(`${locale}: after a reload the note says the same as live`, async () => {
			await live(locale, MANAGED, { result: DAILY, notice: 'run_blocked', budget: DAILY_REF });
			const liveWords = text(noteEl());
			svelte.unmount(component!);
			component = undefined;
			store.newChat();
			await reloaded(locale, MANAGED, { code: 'run_blocked', detail: DAILY, budget: DAILY_REF });
			expect(text(noteEl())).toBe(liveWords);
			expect(reason()).toContain('$5.12');
		});
	}
});
