import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { t, setLocale, getLocale } from '../i18n.svelte.js';
import { resetSettingsViewer } from '../stores/settings-viewer.svelte.js';

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
	resetSettingsViewer();
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(async () => {
	resetSettingsViewer();
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

async function render(payload: Record<string, unknown>, viewer: 'owner' | 'mandate' = 'owner'): Promise<void> {
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const path = String(url).split('?')[0]!;
		if (path.endsWith('/config')) return Response.json({ viewer });
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
/** A mandate cannot create a rule: where the sentence offers a fixed rule, its last sentence says
 *  the owner can. The sensitive sentence offers none and reads as for the owner. */
const OWNER_LAST: Record<Reason, string> = {
	rule_withheld_classifier: 'Soll die Regel hier immer greifen, mach daraus eine feste Regel.',
	rule_withheld_unchecked: 'Soll die Regel ohne Prüfung greifen, mach daraus eine feste Regel.',
	rule_withheld_sensitive: '',
	forwarded_by_person: 'Soll die Regel auch hier greifen, mach daraus eine feste Regel.',
};
const MANDATE_LAST = 'Eine feste Regel daraus kann der Inhaber anlegen.';
function forMandate(sentence: string, reason: Reason): string {
	if (OWNER_LAST[reason] === '') return sentence;
	expect(sentence.endsWith(` ${OWNER_LAST[reason]}`)).toBe(true);
	return `${sentence.slice(0, -OWNER_LAST[reason].length)}${MANDATE_LAST}`;
}
const MANDATE = Object.fromEntries(REASONS.map((r) => [r, { named: forMandate(SENTENCES[r].named, r), unnamed: forMandate(SENTENCES[r].unnamed, r) }])) as Record<Reason, { named: string; unnamed: string }>;
const OFFERS_FIXED: Record<Reason, boolean> = {
	rule_withheld_classifier: true,
	rule_withheld_unchecked: true,
	rule_withheld_sensitive: false,
	forwarded_by_person: true,
};
/** A forwarded mail's sender is the person who forwarded it: only the subject is offered. */
const OFFERS_SENDER: Record<Reason, boolean> = {
	rule_withheld_classifier: true,
	rule_withheld_unchecked: true,
	rule_withheld_sensitive: false,
	forwarded_by_person: false,
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
		expect(subject?.textContent?.trim()).toBe(t('inbox.rule_withheld_from_subject'));
		if (OFFERS_SENDER[reason]) {
			expect(sender?.textContent?.trim()).toBe(t('inbox.rule_withheld_from_sender'));
			const s = new URL(sender!.getAttribute('href')!, 'http://localhost');
			expect(s.pathname).toBe('/app/inbox/rules');
			expect(Object.fromEntries(s.searchParams)).toEqual({ accountId: 'info', kind: 'from', value: 'mahnung@inkasso.example' });
		} else {
			expect(sender).toBeNull();
		}
		const j = new URL(subject!.getAttribute('href')!, 'http://localhost');
		expect(Object.fromEntries(j.searchParams)).toEqual({ accountId: 'info', kind: 'subject_contains', value: 'Zahlungserinnerung 42' });
	});

	it('forwarded_by_person: offers the subject rule and no sender rule', async () => {
		await render(item({ id: 'rul_1', name: 'Mahnungen', reason: 'forwarded_by_person' }));
		expect(byTestId('inbox-rule-withheld-from-subject')?.textContent?.trim()).toBe(t('inbox.rule_withheld_from_subject'));
		expect(byTestId('inbox-rule-withheld-from-sender')).toBeNull();
	});

	it.each(REASONS)('%s: offers a mandate no fixed rule, and still says why the rule was held back', async (reason) => {
		await render(item({ id: 'rul_1', name: 'Mahnungen', reason }), 'mandate');
		expect(byTestId('inbox-rule-withheld-text')?.textContent).toBe(MANDATE[reason].named);
		expect(byTestId('inbox-rule-withheld-from-sender')).toBeNull();
		expect(byTestId('inbox-rule-withheld-from-subject')).toBeNull();
	});

	it.each(REASONS)('%s: tells a mandate, without a name too, that the owner can make the fixed rule', async (reason) => {
		await render(item({ id: 'rul_1', name: null, reason }), 'mandate');
		expect(byTestId('inbox-rule-withheld-text')?.textContent).toBe(MANDATE[reason].unnamed);
	});

	it('tells a mandate in English too', async () => {
		setLocale('en');
		await render(item({ id: 'rul_1', name: 'Dunning', reason: 'rule_withheld_unchecked' }), 'mandate');
		expect(byTestId('inbox-rule-withheld-text')?.textContent).toBe('Rule “Dunning” held back: the check could not run, for example because of no AI budget or credit, so lynox shows you the mail. The owner can turn it into a fixed rule.');
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

	it.each([
		['a zero-width space', 'Newsletter\u200B KW 45', 'Newsletter'],
		['a combining grapheme joiner padding', 'Sale \u034F\u034F\u034F jetzt kaufen', 'jetzt kaufen'],
		['a tab of an unfolded header', 'Re: Rechnung\tNr. 42', 'Re: Rechnung'],
		['a byte order mark in front', '\uFEFFZahlungserinnerung 42', 'Zahlungserinnerung 42'],
	])('offers from a subject with %s only a piece the subject contains as it is', async (_label, subject, value) => {
		await render(item({ id: 'rul_1', name: 'Mahnungen', reason: 'rule_withheld_classifier' }, { subject }));
		const link = byTestId('inbox-rule-withheld-from-subject') as HTMLAnchorElement | null;
		const prefilled = new URL(link!.getAttribute('href')!, 'http://localhost').searchParams.get('value');
		expect(prefilled).toBe(value);
		expect(subject.includes(prefilled!)).toBe(true);
	});

	it.each(['Hi', ' Re ', 'ab\u200Bcd', '\u{1F600}\u{1F600}'])('offers no subject rule for "%s", which has no piece of 3 characters', async (subject) => {
		await render(item({ id: 'rul_1', name: 'Mahnungen', reason: 'rule_withheld_classifier' }, { subject }));
		expect(byTestId('inbox-rule-withheld-from-subject')).toBeNull();
		expect(byTestId('inbox-rule-withheld-from-sender')).not.toBeNull();
	});

	it.each(['Inkasso AG', 'undisclosed-recipients:;', '<mahnung@inkasso.example>', 'mahnung@inkasso.example\u200B'])('offers no sender rule for a sender "%s" that is not one address', async (fromAddress) => {
		await render(item({ id: 'rul_1', name: 'Mahnungen', reason: 'rule_withheld_classifier' }, { fromAddress }));
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
