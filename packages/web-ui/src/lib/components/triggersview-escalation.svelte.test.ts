import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t, setLocale } from '../i18n.svelte.js';

// A trigger's last escalation: the notice says why a wakeup reached nobody, and a line below it
// opens the chat where the question or alert stands, whatever the notice says.

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

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let rows: Record<string, unknown>[] = [];

beforeEach(() => {
	rows = [];
	vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ triggers: rows }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
	vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

async function render(locale: 'de' | 'en' = 'en'): Promise<void> {
	setLocale(locale);
	const { default: TriggersView } = await import('./TriggersView.svelte');
	component = mount(TriggersView, { target });
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

const BASE = { status: 'open', source: 'cron', effect: 'run_agent', confirmed_at: '2026-10-01T00:00:00.000Z', enabled: 1, last_escalation_at: '2026-11-23T08:00:00.000Z' };

const notices = (): string[] => [...target.querySelectorAll<HTMLElement>('[data-escalation-notice]')].map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim());
const links = (): Array<{ kind: string | undefined; href: string | null; text: string }> => [...target.querySelectorAll<HTMLElement>('[data-escalation-chat]')]
	.map((p) => ({ kind: p.dataset['escalationChat'], href: p.querySelector('a')?.getAttribute('href') ?? null, text: (p.textContent ?? '').trim() }));

describe('the trigger view on a wakeup that reached nobody', () => {
	it.each(['en', 'de'] as const)('%s: names a missing setup and a failed push service apart', async (locale) => {
		rows = [
			{ ...BASE, id: 't-a', title: 'A', last_escalation_outcome: 'not_delivered', last_escalation_case: 'no_subscription' },
			{ ...BASE, id: 't-b', title: 'B', last_escalation_outcome: 'not_delivered', last_escalation_case: 'send_failed' },
		];
		await render(locale);
		const said = notices();
		expect(said).toHaveLength(2);
		expect(said[0]).toContain(t('triggers.escalation_not_delivered_no_subscription'));
		expect(said[1]).toContain(t('triggers.escalation_not_delivered_send_failed'));
	});
});

describe('the link from a trigger to its escalation\'s chat', () => {
	it.each(['en', 'de'] as const)('%s: a line below the notice opens the question\'s or the alert\'s chat, under a delivered notice too', async (locale) => {
		rows = [
			{ ...BASE, id: 't-q', title: 'Q', last_escalation_outcome: 'delivered', last_escalation_chat: { threadId: 'session 1', kind: 'question' } },
			{ ...BASE, id: 't-w', title: 'W', last_escalation_outcome: 'not_delivered', last_escalation_case: 'send_failed', last_escalation_chat: { threadId: 'escalation-t-w', kind: 'alert' } },
		];
		await render(locale);
		expect(links()).toEqual([
			{ kind: 'question', href: '/app?thread=session%201', text: t('triggers.escalation_chat_question') },
			{ kind: 'alert', href: '/app?thread=escalation-t-w', text: t('triggers.escalation_chat_alert') },
		]);
		// Its own line, after the row that carries the notice: not inside it.
		for (const p of target.querySelectorAll<HTMLElement>('[data-escalation-chat]')) {
			expect(p.tagName).toBe('P');
			expect(p.querySelector('[data-escalation-notice]')).toBeNull();
			expect(p.previousElementSibling?.querySelector('[data-escalation-notice]')).not.toBeNull();
		}
	});

	// A deleted chat leaves the answer at the route (plan-pause-http.test.ts); here, an answer without one.
	it('shows no link for a trigger whose answer names no chat', async () => {
		rows = [{ ...BASE, id: 't-n', title: 'N', last_escalation_outcome: 'not_delivered', last_escalation_case: 'no_subscription' }];
		await render();
		expect(notices()).toHaveLength(1);
		expect(links()).toEqual([]);
	});
});

describe('the notice line of a trigger\'s escalation', () => {
	it.each(['en', 'de'] as const)('%s: the time comes first, then what happened, by kind', async (locale) => {
		rows = [
			{ ...BASE, id: 't-q', title: 'Q', last_escalation_outcome: 'delivered', last_escalation_kind: 'question' },
			{ ...BASE, id: 't-w', title: 'W', last_escalation_outcome: 'not_delivered', last_escalation_case: 'send_failed' },
		];
		await render(locale);
		const said = notices();
		expect(said).toHaveLength(2);
		expect(said[0]).toMatch(new RegExp(`^\\S.* · ${t('triggers.escalation_delivered_question')}$`));
		expect(said[1]!.endsWith(` · ${t('triggers.escalation_not_delivered_send_failed')}`)).toBe(true);
	});

	it('the chat link is underlined', async () => {
		rows = [{ ...BASE, id: 't-q', title: 'Q', last_escalation_outcome: 'delivered', last_escalation_chat: { threadId: 's', kind: 'question' } }];
		await render();
		const a = target.querySelector<HTMLAnchorElement>('[data-escalation-chat] a');
		expect(a?.classList.contains('underline')).toBe(true);
	});
});
