import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { t, setLocale, getLocale } from '../i18n.svelte.js';

// The reading pane's note on a rule that named the mail but was not applied: which rule and why,
// with the rule's name or without one, linked to the rule while it exists, and, where the reason
// allows it, the way to a fixed rule from the sender or the subject.

const CLIENT_ENTRY = vi.hoisted(() => {
	const { createRequire: req } = require('node:module') as typeof import('node:module');
	const { dirname: dir, join: jn } = require('node:path') as typeof import('node:path');
	return jn(dir(req(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
});
vi.mock('svelte', async () => import(/* @vite-ignore */ CLIENT_ENTRY));
vi.mock('./MarkdownRenderer.svelte', () => ({ default: () => {} }));
type SvelteClient = {
	mount: (c: unknown, o: { target: Element; props?: Record<string, unknown> }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
const localeBefore = getLocale();

beforeEach(() => {
	setLocale('de');
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(async () => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	(await import('../stores/inbox.svelte.js')).closeItem();
	vi.unstubAllGlobals();
	setLocale(localeBefore);
});

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

type Reason = 'rule_withheld_classifier' | 'rule_withheld_unchecked' | 'rule_withheld_sensitive' | 'forwarded_by_person';

function item(ruleWithheld: unknown, over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'inb_1', tenantId: 'default', accountId: 'info', channel: 'email', threadKey: 't1', bucket: 'requires_user',
		confidence: 1, reasonDe: 'x', classifiedAt: '2026-11-05T08:00:00Z', classifierVersion: 'rule:rul_1', unsnoozeOnReply: true,
		fromAddress: 'mahnung@inkasso.example', subject: 'Zahlungserinnerung 42', ruleWithheld, ...over,
	};
}

async function render(payload: Record<string, unknown>): Promise<void> {
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const path = String(url).split('?')[0]!;
		if (path.endsWith('/full')) return Response.json({ item: payload, body: { md: 'Hallo', source: 'cache' } });
		if (path.endsWith('/thread')) return Response.json({ messages: [], partial: false });
		return Response.json({ error: 'not found' }, { status: 404 });
	}));
	const store = await import('../stores/inbox.svelte.js');
	const { default: Pane } = await import('./InboxReadingPane.svelte');
	component = mount(Pane, { target });
	await store.openItem('inb_1');
	await settle();
}

function byTestId(id: string): HTMLElement | null {
	return target.querySelector(`[data-testid="${id}"]`);
}

const SENTENCES: Record<Reason, { named: string; unnamed: string; key: string }> = {
	rule_withheld_classifier: {
		key: 'inbox.rule_withheld_classifier',
		named: 'Regel „Mahnungen“ zurückgehalten: Der Klassifikator ordnete diese Mail anders ein, darum zeigt lynox sie dir. Soll die Regel hier immer greifen, mach daraus eine feste Regel.',
		unnamed: 'Regel zurückgehalten: Der Klassifikator ordnete diese Mail anders ein, darum zeigt lynox sie dir. Soll die Regel hier immer greifen, mach daraus eine feste Regel.',
	},
	rule_withheld_unchecked: {
		key: 'inbox.rule_withheld_unchecked',
		named: 'Regel „Mahnungen“ zurückgehalten: Die Prüfung konnte nicht laufen, etwa wegen fehlendem KI-Budget oder Guthaben, darum zeigt lynox dir die Mail. Soll die Regel ohne Prüfung greifen, mach daraus eine feste Regel.',
		unnamed: 'Regel zurückgehalten: Die Prüfung konnte nicht laufen, etwa wegen fehlendem KI-Budget oder Guthaben, darum zeigt lynox dir die Mail. Soll die Regel ohne Prüfung greifen, mach daraus eine feste Regel.',
	},
	rule_withheld_sensitive: {
		key: 'inbox.rule_withheld_sensitive',
		named: 'Regel „Mahnungen“ zurückgehalten: Diese Mail wirkt sensibel. Eine Regel legt solche Mails nie als erledigt ab, darum zeigt lynox sie dir.',
		unnamed: 'Regel zurückgehalten: Diese Mail wirkt sensibel. Eine Regel legt solche Mails nie als erledigt ab, darum zeigt lynox sie dir.',
	},
	forwarded_by_person: {
		key: 'inbox.rule_withheld_forwarded',
		named: 'Regel „Mahnungen“ zurückgehalten: Diese Mail hat eine Person weitergeleitet. Solche Mails legt eine Beschreibungsregel nicht als erledigt ab, darum zeigt lynox sie dir. Soll die Regel auch hier greifen, mach daraus eine feste Regel.',
		unnamed: 'Regel zurückgehalten: Diese Mail hat eine Person weitergeleitet. Solche Mails legt eine Beschreibungsregel nicht als erledigt ab, darum zeigt lynox sie dir. Soll die Regel auch hier greifen, mach daraus eine feste Regel.',
	},
};
const REASONS = Object.keys(SENTENCES) as Reason[];
const OFFERS_FIXED: Record<Reason, boolean> = {
	rule_withheld_classifier: true,
	rule_withheld_unchecked: true,
	rule_withheld_sensitive: false,
	forwarded_by_person: true,
};

describe('InboxReadingPane — a rule held back', () => {
	it.each(REASONS)('%s: says it with the rule name, linked to the rule', async (reason) => {
		await render(item({ id: 'rul_1', name: 'Mahnungen', reason }));
		expect(byTestId('inbox-rule-withheld-text')?.textContent).toBe(SENTENCES[reason].named);
		const link = byTestId('inbox-rule-withheld-link') as HTMLAnchorElement | null;
		expect(link?.textContent).toBe('Mahnungen');
		const href = new URL(link!.getAttribute('href')!, 'http://localhost');
		expect(href.pathname).toBe('/app/inbox/rules');
		expect(href.searchParams.get('accountId')).toBe('info');
		expect(href.hash).toBe('#rule-rul_1');
	});

	it.each(REASONS)('%s: says it without a name when the rule had none, and links nothing', async (reason) => {
		await render(item({ id: 'rul_1', name: null, reason }));
		expect(byTestId('inbox-rule-withheld-text')?.textContent).toBe(SENTENCES[reason].unnamed);
		expect(byTestId('inbox-rule-withheld-link')).toBeNull();
	});

	it.each(REASONS)('%s: keeps the name of a deleted rule and drops only the link', async (reason) => {
		await render(item({ id: null, name: 'Mahnungen', reason }));
		expect(byTestId('inbox-rule-withheld-text')?.textContent).toBe(SENTENCES[reason].named);
		expect(byTestId('inbox-rule-withheld-link')).toBeNull();
	});

	it.each(REASONS)('%s: offers the fixed rule from sender and subject only where the reason allows', async (reason) => {
		await render(item({ id: 'rul_1', name: 'Mahnungen', reason }));
		const sender = byTestId('inbox-rule-withheld-from-sender') as HTMLAnchorElement | null;
		const subject = byTestId('inbox-rule-withheld-from-subject') as HTMLAnchorElement | null;
		if (!OFFERS_FIXED[reason]) {
			expect(sender).toBeNull();
			expect(subject).toBeNull();
			return;
		}
		expect(sender?.textContent?.trim()).toBe(t('inbox.rule_withheld_from_sender'));
		expect(subject?.textContent?.trim()).toBe(t('inbox.rule_withheld_from_subject'));
		const s = new URL(sender!.getAttribute('href')!, 'http://localhost');
		expect(s.pathname).toBe('/app/inbox/rules');
		expect(Object.fromEntries(s.searchParams)).toEqual({ accountId: 'info', kind: 'from', value: 'mahnung@inkasso.example' });
		const j = new URL(subject!.getAttribute('href')!, 'http://localhost');
		expect(Object.fromEntries(j.searchParams)).toEqual({ accountId: 'info', kind: 'subject_contains', value: 'Zahlungserinnerung 42' });
	});

	it('offers no subject rule for a mail without subject, and no sender rule without sender', async () => {
		await render(item({ id: 'rul_1', name: 'Mahnungen', reason: 'rule_withheld_classifier' }, { subject: '  ' }));
		expect(byTestId('inbox-rule-withheld-from-subject')).toBeNull();
		expect(byTestId('inbox-rule-withheld-from-sender')).not.toBeNull();
		if (component) unmount(component);
		component = undefined;
		await render(item({ id: 'rul_1', name: 'Mahnungen', reason: 'rule_withheld_classifier' }, { fromAddress: '' }));
		expect(byTestId('inbox-rule-withheld-from-sender')).toBeNull();
		expect(byTestId('inbox-rule-withheld-from-subject')).not.toBeNull();
	});

	it('shows no note when no rule was held back', async () => {
		await render(item(null));
		expect(byTestId('inbox-rule-withheld')).toBeNull();
		if (component) unmount(component);
		component = undefined;
		await render(item(undefined));
		expect(byTestId('inbox-rule-withheld')).toBeNull();
	});

	it('says it in English too', async () => {
		setLocale('en');
		await render(item({ id: 'rul_1', name: 'Dunning', reason: 'rule_withheld_classifier' }));
		expect(byTestId('inbox-rule-withheld-text')?.textContent).toBe('Rule “Dunning” held back: the classifier sorted this mail differently, so lynox shows it to you. If the rule should always apply here, turn it into a fixed rule.');
		if (component) unmount(component);
		component = undefined;
		await render(item({ id: 'rul_1', name: null, reason: 'forwarded_by_person' }));
		expect(byTestId('inbox-rule-withheld-text')?.textContent).toBe('Rule held back: a person forwarded this mail. A description rule does not file such mail as handled, so lynox shows it to you. If the rule should apply here too, turn it into a fixed rule.');
	});

	it('uses each reason\'s own text', () => {
		for (const r of REASONS) {
			expect(t(SENTENCES[r].key)).toBe(SENTENCES[r].named.replace('„Mahnungen“', '„{name}“'));
			expect(t(`${SENTENCES[r].key}_unnamed`)).toBe(SENTENCES[r].unnamed);
		}
	});
});
