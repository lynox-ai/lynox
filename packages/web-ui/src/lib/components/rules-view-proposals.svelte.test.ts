import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { t, tf, setLocale, getLocale } from '../i18n.svelte.js';
import { resetSettingsViewer } from '../stores/settings-viewer.svelte.js';

// The rule view's proposals, its description kind and its prefill from a link. A proposal waits
// above the rules that apply; the owner reads what confirming does before the button, a mandate
// reads that only the owner can confirm. Mounted once per case, against a stubbed API.

const CLIENT_ENTRY = vi.hoisted(() => {
	const { createRequire: req } = require('node:module') as typeof import('node:module');
	const { dirname: dir, join: jn } = require('node:path') as typeof import('node:path');
	return jn(dir(req(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
});
vi.mock('svelte', async () => import(/* @vite-ignore */ CLIENT_ENTRY));
// The page's URL, set per test before the mount: the view reads it once, as it is created.
const pageUrl = vi.hoisted(() => ({ href: 'http://localhost/app/inbox/rules' }));
vi.mock('$app/stores', async () => {
	const { readable } = await import('svelte/store');
	return { page: { subscribe: (run: (v: { url: URL }) => void) => readable({ url: new URL(pageUrl.href) }).subscribe(run) } };
});
type SvelteClient = {
	mount: (c: unknown, o: { target: Element; props?: Record<string, unknown> }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

type Viewer = 'mandate' | 'owner';

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
const localeBefore = getLocale();
/** Every request other than a GET, with its body. */
let writes: Array<{ method: string; path: string; body: unknown }>;

beforeEach(() => {
	setLocale('de');
	resetSettingsViewer();
	writes = [];
	pageUrl.href = 'http://localhost/app/inbox/rules';
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	resetSettingsViewer();
	if (component) unmount(component);
	component = undefined;
	target.remove();
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

const proposal = {
	id: 'rul_p1', tenantId: 'default', accountId: 'info', matcherKind: 'from', matcherValue: 'rechnung@lieferant.example',
	bucket: 'requires_user', action: 'show', source: 'agent', createdAt: '2026-11-01T00:00:00Z', name: 'Lieferantenrechnungen', runId: 'run-1',
};
const confirmed = {
	id: 'rul_c1', tenantId: 'default', accountId: 'info', matcherKind: 'subject_contains', matcherValue: 'Newsletter',
	bucket: 'auto_handled', action: 'archive', source: 'on_demand', createdAt: '2026-10-01T00:00:00Z', name: 'Newsletter', confirmedAt: '2026-10-01T00:00:00Z',
};

interface Answers {
	/** Whose session the server names; a function answers `/config` itself (held, refused). */
	viewer: Viewer | (() => Promise<Response> | Response);
	/** The rules listed; a function is asked on every list. */
	rules?: unknown[] | (() => unknown[]);
	/** The waiting proposals per account, as `/inbox/counts` gives them. */
	pendingByAccount?: Record<string, number>;
	/** The answer to a POST of a new rule. */
	create?: () => Response;
	/** The answer to a confirm. */
	confirm?: () => Response;
}

async function render(a: Answers): Promise<void> {
	vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
		const path = String(url).split('?')[0]!;
		if (init?.method !== undefined && init.method !== 'GET') {
			writes.push({ method: init.method, path, body: typeof init.body === 'string' ? JSON.parse(init.body) as unknown : null });
			if (path.endsWith('/confirm')) return a.confirm ? a.confirm() : Response.json({ id: path.split('/').at(-2) });
			if (path.endsWith('/inbox/rules')) return a.create ? a.create() : Response.json({ id: 'rul_new' }, { status: 201 });
			return Response.json({ error: 'unexpected' }, { status: 500 });
		}
		if (path.endsWith('/config')) return typeof a.viewer === 'function' ? a.viewer() : Response.json({ viewer: a.viewer });
		if (path.endsWith('/inbox/counts')) return Response.json({ counts: {}, snoozed: 0, rulesPending: 1, rulesPendingByAccount: a.pendingByAccount ?? {} });
		if (path.endsWith('/mail/accounts')) return Response.json({ accounts: [{ id: 'info', displayName: 'Info', address: 'info@example.com', isDefault: true }, { id: 'sales', address: 'sales@example.com' }] });
		if (path.endsWith('/inbox/rules')) return Response.json({ rules: typeof a.rules === 'function' ? a.rules() : a.rules ?? [proposal, confirmed] });
		return Response.json({ error: 'not found' }, { status: 404 });
	}));
	const { default: Page } = await import('./RulesView.svelte');
	component = mount(Page, { target });
	await settle();
}

function byTestId(id: string): HTMLElement | null {
	return target.querySelector(`[data-testid="${id}"]`);
}
function button(text: string): HTMLButtonElement | undefined {
	return [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
}
function radio(name: string, value: string): HTMLInputElement {
	const el = target.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
	if (el === null) throw new Error(`no radio ${name}=${value}`);
	return el;
}
async function choose(name: string, value: string): Promise<void> {
	const el = radio(name, value);
	el.checked = true;
	el.dispatchEvent(new Event('change', { bubbles: true }));
	await settle();
}
async function openForm(): Promise<void> {
	button(t('inbox.rules_add'))!.click();
	await settle();
}
async function type(input: HTMLInputElement, value: string): Promise<void> {
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	await settle();
}
function textInputs(): HTMLInputElement[] {
	return [...target.querySelectorAll<HTMLInputElement>('form input[type="text"]')];
}

describe('RulesView — proposals', () => {
	it('lists a waiting proposal above the rules that apply, with its badge, name, check, value and bucket', async () => {
		await render({ viewer: 'owner' });
		const section = byTestId('rules-proposals');
		expect(section).not.toBeNull();
		expect(section!.textContent).toContain(t('inbox.rules_proposals_title'));
		expect(section!.textContent).toContain(t('inbox.rules_proposals_intro'));
		const item = byTestId('rules-proposal')!;
		expect(item.querySelector('[data-testid="rules-proposal-badge"]')?.textContent?.trim()).toBe(t('inbox.rules_proposal_badge'));
		expect(item.textContent).toContain('Lieferantenrechnungen');
		expect(item.textContent).toContain(t('inbox.rules_match_from'));
		expect(item.querySelector('.font-mono')?.textContent).toBe('rechnung@lieferant.example');
		expect(item.textContent).toContain(t('inbox.zone_needs_you'));
		// The confirmed rule is not in the proposals, and the proposal not in the confirmed list.
		expect(section!.textContent).not.toContain('Newsletter');
		const confirmedList = [...target.querySelectorAll('li')].filter((li) => !section!.contains(li));
		expect(confirmedList).toHaveLength(1);
		expect(confirmedList[0]!.textContent).toContain('Newsletter');
		// Proposals come first in the page.
		expect(section!.compareDocumentPosition(confirmedList[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it('shows no badge on a waiting rule the assistant did not propose', async () => {
		await render({ viewer: 'owner', rules: [{ ...proposal, source: 'on_demand' }] });
		expect(byTestId('rules-proposal')).not.toBeNull();
		expect(byTestId('rules-proposal-badge')).toBeNull();
	});

	it('shows the owner what confirming does before the click: name, check, value and bucket', async () => {
		await render({ viewer: 'owner' });
		const text = byTestId('rules-confirm-text')!.textContent;
		expect(text).toBe('Regel „Lieferantenrechnungen“ bestätigen? Wenn Absender ist „rechnung@lieferant.example“, dann „Braucht dich“. Sie wirkt, sobald du bestätigst.');
		expect(text).toBe(tf('inbox.rules_confirm_text', { name: 'Lieferantenrechnungen', match: t('inbox.rules_match_from'), value: 'rechnung@lieferant.example', bucket: t('inbox.zone_needs_you') }));
		expect(button(t('inbox.rules_confirm'))).toBeDefined();
		expect(byTestId('rules-proposals-mandate')).toBeNull();
	});

	it('names an unnamed proposal by its value, as the server does', async () => {
		await render({ viewer: 'owner', rules: [{ ...proposal, name: undefined }] });
		expect(byTestId('rules-confirm-text')!.textContent).toMatch(/^Regel „rechnung@lieferant\.example“ bestätigen\? Wenn/);
	});

	it('confirms through the owner route and reloads the rules and the count', async () => {
		let rulesAfter: unknown[] = [proposal, confirmed];
		await render({ viewer: 'owner', rules: () => rulesAfter, confirm: () => { rulesAfter = [{ ...proposal, confirmedAt: '2026-11-05T00:00:00Z' }, confirmed]; return Response.json({ id: 'rul_p1' }); } });
		const listsBefore = (vi.mocked(fetch).mock.calls as Array<[string, RequestInit?]>).filter(([u, i]) => String(u).split('?')[0] === '/api/inbox/rules' && i?.method === undefined).length;
		button(t('inbox.rules_confirm'))!.click();
		await settle();
		expect(writes).toEqual([{ method: 'POST', path: '/api/inbox/rules/rul_p1/confirm', body: {} }]);
		const calls = vi.mocked(fetch).mock.calls as Array<[string, RequestInit?]>;
		const fetched = calls.map(([u]) => String(u).split('?')[0]);
		expect(fetched.filter((p) => p === '/api/inbox/counts').length).toBeGreaterThanOrEqual(2);
		// The rules are listed again: the confirmed proposal leaves the proposals and joins the rules that apply.
		expect(calls.filter(([u, i]) => String(u).split('?')[0] === '/api/inbox/rules' && i?.method === undefined).length).toBe(listsBefore + 1);
		expect(byTestId('rules-proposals')).toBeNull();
		expect([...target.querySelectorAll('li')].map((li) => li.id)).toEqual(['rule-rul_p1', 'rule-rul_c1']);
	});

	it('ties each confirm button to its own confirm sentence for a screen reader', async () => {
		const second = { ...proposal, id: 'rul_p2', name: 'Zweiter', matcherValue: 'zwei@lieferant.example' };
		await render({ viewer: 'owner', rules: [proposal, second] });
		const buttons = [...target.querySelectorAll('button')].filter((b) => b.textContent?.trim() === t('inbox.rules_confirm'));
		expect(buttons).toHaveLength(2);
		const described = buttons.map((b) => document.getElementById(b.getAttribute('aria-describedby') ?? '')?.textContent);
		expect(described[0]).toContain('Lieferantenrechnungen');
		expect(described[1]).toContain('Zweiter');
		expect(described[0]).not.toContain('Zweiter');
	});

	it('shows neither the confirm nor the mandate sentence while the server has not said whose session it is', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => { release = r; });
		await render({ viewer: async () => { await gate; return Response.json({ viewer: 'owner' }); } });
		expect(byTestId('rules-proposal')).not.toBeNull();
		expect(button(t('inbox.rules_confirm'))).toBeUndefined();
		expect(byTestId('rules-confirm-text')).toBeNull();
		expect(byTestId('rules-proposals-mandate')).toBeNull();
		release();
		await settle();
		expect(button(t('inbox.rules_confirm'))).toBeDefined();
		expect(byTestId('rules-proposals-mandate')).toBeNull();
	});

	it('scrolls to the rule a link points at once the list has loaded', async () => {
		const scrolled: Element[] = [];
		const original = Element.prototype.scrollIntoView;
		Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
		try {
			pageUrl.href = 'http://localhost/app/inbox/rules?accountId=info#rule-rul_c1';
			await render({ viewer: 'owner' });
			const el = document.getElementById('rule-rul_c1');
			expect(el).not.toBeNull();
			expect(scrolled).toEqual([el]);
		} finally {
			Element.prototype.scrollIntoView = original;
		}
	});

	it('scrolls nowhere without a rule in the link', async () => {
		const scrolled: Element[] = [];
		const original = Element.prototype.scrollIntoView;
		Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
		try {
			pageUrl.href = 'http://localhost/app/inbox/rules?accountId=info#top';
			await render({ viewer: 'owner' });
			expect(scrolled).toEqual([]);
		} finally {
			Element.prototype.scrollIntoView = original;
		}
	});

	it('says so when the confirm fails and keeps the proposal', async () => {
		const toasts = await import('../stores/toast.svelte.js');
		const spy = vi.spyOn(toasts, 'addToast');
		await render({ viewer: 'owner', confirm: () => Response.json({ error: 'rule not found' }, { status: 404 }) });
		button(t('inbox.rules_confirm'))!.click();
		await settle();
		expect(spy).toHaveBeenCalledWith(t('inbox.rules_error_confirm'), 'error');
		expect(byTestId('rules-proposal')).not.toBeNull();
		spy.mockRestore();
	});

	it('shows a mandate the proposal without a confirm and says who confirms', async () => {
		await render({ viewer: 'mandate' });
		expect(byTestId('rules-proposal')!.textContent).toContain('rechnung@lieferant.example');
		expect(byTestId('rules-proposals-mandate')?.textContent?.trim()).toBe(t('inbox.rules_proposals_mandate'));
		expect(button(t('inbox.rules_confirm'))).toBeUndefined();
		expect(byTestId('rules-confirm-text')).toBeNull();
		expect(writes).toEqual([]);
	});

	it('has no proposals section without a waiting rule', async () => {
		await render({ viewer: 'owner', rules: [confirmed] });
		expect(byTestId('rules-proposals')).toBeNull();
	});

	it('links each confirmed rule to its items in the inbox, and no proposal', async () => {
		await render({ viewer: 'owner' });
		const links = [...target.querySelectorAll<HTMLAnchorElement>('[data-testid="rules-items-link"]')];
		expect(links).toHaveLength(1);
		expect(links[0]!.textContent?.trim()).toBe(t('inbox.rules_items_link'));
		const href = new URL(links[0]!.getAttribute('href')!, 'http://localhost');
		expect(href.pathname).toBe('/app/inbox');
		expect(href.searchParams.get('ruleId')).toBe('rul_c1');
		expect(href.searchParams.get('accountId')).toBe('info');
		expect(href.searchParams.get('zone')).toBe('auto_handled');
	});
});

describe('RulesView — the description kind', () => {
	it('offers it with its placeholder, length note, overlap and out-of-office sentences', async () => {
		await render({ viewer: 'owner', rules: [] });
		await openForm();
		expect(byTestId('rules-description-hints')).toBeNull();
		await choose('rule-match-kind', 'matches_description');
		const hints = byTestId('rules-description-hints')!.textContent!;
		expect(hints).toContain(t('inbox.rules_description_hint'));
		expect(hints).toContain(t('inbox.rules_description_overlap'));
		expect(hints).toContain(t('inbox.rules_description_out_of_office'));
		const [name, value] = textInputs();
		expect(value!.placeholder).toBe(t('inbox.rules_description_placeholder'));
		expect(value!.maxLength).toBe(300);
		expect(name!.placeholder).toBe(t('inbox.rules_name_placeholder'));
		expect(name!.maxLength).toBe(80);
		expect(target.textContent).toContain(t('inbox.rules_name_label'));
		expect(target.textContent).toContain(t('inbox.rules_match_description'));
	});

	it.each([
		['archive', 'Mit „Automatisch archivieren“ greift eine Beschreibungsregel nur, wenn auch der Klassifikator die Mail so einordnet. Sonst hält lynox die Regel zurück und zeigt dir die Mail.'],
		['silent', 'Mit „Lesen markieren & ausblenden“ greift eine Beschreibungsregel nur, wenn auch der Klassifikator die Mail so einordnet. Sonst hält lynox die Regel zurück und zeigt dir die Mail.'],
	] as const)('names the chosen handled option "%s" in the hint', async (preset, sentence) => {
		await render({ viewer: 'owner', rules: [] });
		await openForm();
		await choose('rule-match-kind', 'matches_description');
		await choose('rule-then-preset', preset);
		expect(byTestId('rules-handled-hint')?.textContent).toBe(sentence);
	});

	it('shows no handled hint for "keep under Needs you", nor for a fixed rule', async () => {
		await render({ viewer: 'owner', rules: [] });
		await openForm();
		await choose('rule-match-kind', 'matches_description');
		await choose('rule-then-preset', 'escalate');
		expect(byTestId('rules-handled-hint')).toBeNull();
		await choose('rule-then-preset', 'archive');
		expect(byTestId('rules-handled-hint')).not.toBeNull();
		await choose('rule-match-kind', 'from');
		expect(byTestId('rules-handled-hint')).toBeNull();
	});

	it('sends the name, and says in the form when the server refuses a label such as R1', async () => {
		const toasts = await import('../stores/toast.svelte.js');
		const spy = vi.spyOn(toasts, 'addToast');
		await render({ viewer: 'owner', rules: [], create: () => Response.json({ error: 'description must not name a rule label such as R1' }, { status: 400 }) });
		await openForm();
		await choose('rule-match-kind', 'matches_description');
		const [name, value] = textInputs();
		await type(name!, ' Mahnungen ');
		await type(value!, 'Mahnungen wie R1');
		target.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await settle();
		expect(writes[0]).toMatchObject({ method: 'POST', path: '/api/inbox/rules', body: { matcherKind: 'matches_description', matcherValue: 'Mahnungen wie R1', name: 'Mahnungen', source: 'on_demand' } });
		expect(byTestId('rules-label-error')?.textContent).toBe(t('inbox.rules_error_rule_label'));
		expect(target.querySelector('form')).not.toBeNull();
		expect(spy).not.toHaveBeenCalledWith(t('inbox.rules_error_create'), 'error');
		spy.mockRestore();
	});

	it('toasts any other refusal and shows no label error', async () => {
		const toasts = await import('../stores/toast.svelte.js');
		const spy = vi.spyOn(toasts, 'addToast');
		await render({ viewer: 'owner', rules: [], create: () => Response.json({ error: 'at most 20 description rules per account' }, { status: 400 }) });
		await openForm();
		await type(textInputs()[1]!, 'noreply@');
		target.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await settle();
		expect(spy).toHaveBeenCalledWith(t('inbox.rules_error_create'), 'error');
		expect(byTestId('rules-label-error')).toBeNull();
		expect((writes[0]!.body as Record<string, unknown>)['name']).toBeUndefined();
		spy.mockRestore();
	});
});

describe('RulesView — prefill from a link', () => {
	it('opens the form on the linked account with the kind and value of the link', async () => {
		pageUrl.href = 'http://localhost/app/inbox/rules?accountId=sales&kind=subject_contains&value=Rechnung%20Nr.%2042';
		await render({ viewer: 'owner', rules: [] });
		const account = target.querySelector<HTMLInputElement>('input[list="rules-account-list"]')!;
		expect(account.value).toBe('sales');
		expect(radio('rule-match-kind', 'subject_contains').checked).toBe(true);
		expect(textInputs()[1]!.value).toBe('Rechnung Nr. 42');
		const fetched = (vi.mocked(fetch).mock.calls as Array<[string, RequestInit?]>).map(([u]) => String(u));
		expect(fetched).toContain('/api/inbox/rules?accountId=sales');
	});

	it('opens no form for a kind a link may not prefill, nor without a value', async () => {
		pageUrl.href = 'http://localhost/app/inbox/rules?accountId=sales&kind=matches_description&value=Mahnungen';
		await render({ viewer: 'owner', rules: [] });
		expect(target.querySelector('form')).toBeNull();
		if (component) unmount(component);
		component = undefined;
		pageUrl.href = 'http://localhost/app/inbox/rules?accountId=sales&kind=from&value=%20';
		await render({ viewer: 'owner', rules: [] });
		expect(target.querySelector('form')).toBeNull();
	});

	it('opens no form for a list id, which cannot be created', async () => {
		pageUrl.href = 'http://localhost/app/inbox/rules?accountId=sales&kind=list_id&value=news.shop.example';
		await render({ viewer: 'owner', rules: [] });
		expect(target.querySelector('form')).toBeNull();
	});

	it('opens no form for a mandate', async () => {
		pageUrl.href = 'http://localhost/app/inbox/rules?accountId=sales&kind=from&value=a%40b.example';
		await render({ viewer: 'mandate', rules: [] });
		expect(target.querySelector('form')).toBeNull();
	});
});

describe('RulesView — the account with waiting proposals', () => {
	function accountInput(): HTMLInputElement {
		return target.querySelector<HTMLInputElement>('input[list="rules-account-list"]')!;
	}
	function listedFor(): string[] {
		return (vi.mocked(fetch).mock.calls as Array<[string, RequestInit?]>).map(([u]) => String(u)).filter((u) => u.startsWith('/api/inbox/rules?'));
	}

	it('opens the first account with proposals waiting when the link names none', async () => {
		await render({ viewer: 'owner', pendingByAccount: { sales: 2 }, rules: [{ ...proposal, accountId: 'sales' }] });
		expect(accountInput().value).toBe('sales');
		expect(listedFor()).toEqual(['/api/inbox/rules?accountId=sales']);
		expect(byTestId('rules-proposal')).not.toBeNull();
	});

	it('keeps the default account without any proposal waiting', async () => {
		await render({ viewer: 'owner', pendingByAccount: {}, rules: [confirmed] });
		expect(accountInput().value).toBe('info');
		expect(listedFor()).toEqual(['/api/inbox/rules?accountId=info']);
	});

	it('keeps the account a link names, whoever has proposals waiting', async () => {
		pageUrl.href = 'http://localhost/app/inbox/rules?accountId=info';
		await render({ viewer: 'owner', pendingByAccount: { sales: 2 } });
		expect(accountInput().value).toBe('info');
	});

	it('shows the number of waiting proposals next to each account in the picker', async () => {
		await render({ viewer: 'owner', pendingByAccount: { sales: 2 } });
		const options = [...target.querySelectorAll('#rules-account-list option')].map((o) => o.textContent);
		expect(options).toEqual(['Info <info@example.com>', 'sales@example.com (2)']);
	});
});

describe('RulesView — a form a link opened', () => {
	const PREFILL = 'http://localhost/app/inbox/rules?accountId=info&kind=from&value=chef%40firma.example';
	function save(): HTMLButtonElement {
		return button(t('inbox.rules_save'))!;
	}
	function thenRadios(): HTMLInputElement[] {
		return [...target.querySelectorAll<HTMLInputElement>('input[name="rule-then-preset"]')];
	}

	it('opens with no "then" chosen, says to choose one, and saves only after a choice, with the choice', async () => {
		pageUrl.href = PREFILL;
		await render({ viewer: 'owner', rules: [] });
		expect(textInputs()[1]!.value).toBe('chef@firma.example');
		expect(thenRadios()).toHaveLength(3);
		expect(thenRadios().filter((r) => r.checked)).toEqual([]);
		expect(save().disabled).toBe(true);
		expect(byTestId('rules-then-choose-hint')?.textContent).toBe(t('inbox.rules_then_choose_hint'));
		// A submit without a choice sends nothing.
		target.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await settle();
		expect(writes).toEqual([]);
		await choose('rule-then-preset', 'escalate');
		expect(save().disabled).toBe(false);
		expect(byTestId('rules-then-choose-hint')).toBeNull();
		target.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await settle();
		expect(writes).toHaveLength(1);
		expect(writes[0]).toMatchObject({ method: 'POST', path: '/api/inbox/rules', body: { matcherKind: 'from', matcherValue: 'chef@firma.example', bucket: 'requires_user', action: 'show' } });
	});

	it.each(['preset', 'then', 'action', 'bucket'])('chooses nothing from a "%s" in the link', async (param) => {
		pageUrl.href = `${PREFILL}&${param}=archive&preset=silent`;
		await render({ viewer: 'owner', rules: [] });
		expect(target.querySelector('form')).not.toBeNull();
		expect(thenRadios().filter((r) => r.checked)).toEqual([]);
		expect(save().disabled).toBe(true);
	});

	it('reads no parameter of the link but account, kind and value', async () => {
		const { default: src } = (await import('./RulesView.svelte?raw')) as { default: string };
		const read = [...src.matchAll(/params\.get\('([^']+)'\)/g)].map((m) => m[1]).sort();
		expect(read).toEqual(['accountId', 'kind', 'value']);
		expect(src).not.toMatch(/searchParams\.(getAll|entries|forEach|keys|values|has)\b/);
	});

	it('keeps "add rule" as it was: archive chosen and Save ready once a value is typed', async () => {
		await render({ viewer: 'owner', rules: [] });
		await openForm();
		expect(radio('rule-then-preset', 'archive').checked).toBe(true);
		expect(byTestId('rules-then-choose-hint')).toBeNull();
		await type(textInputs()[1]!, 'news@shop.example');
		expect(save().disabled).toBe(false);
	});
});

describe('RulesView — the sender of a fixed rule', () => {
	it('shows a whole address as the example for a sender, and the shared one for a subject', async () => {
		await render({ viewer: 'owner', rules: [] });
		await openForm();
		expect(textInputs()[1]!.placeholder).toBe(t('inbox.rules_match_from_placeholder'));
		await choose('rule-match-kind', 'subject_contains');
		expect(textInputs()[1]!.placeholder).toBe(t('inbox.rules_match_value_placeholder'));
	});

	it.each(['noreply@', '@lieferant.ch', 'lieferant.ch'])('says in the form when the server refuses "%s" as not one whole address', async (value) => {
		const toasts = await import('../stores/toast.svelte.js');
		const spy = vi.spyOn(toasts, 'addToast');
		await render({ viewer: 'owner', rules: [], create: () => Response.json({ error: 'matcherValue must be one sender address' }, { status: 400 }) });
		await openForm();
		await type(textInputs()[1]!, value);
		target.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await settle();
		expect(writes[0]).toMatchObject({ body: { matcherKind: 'from', matcherValue: value } });
		expect(byTestId('rules-from-address-error')?.textContent).toBe(t('inbox.rules_error_from_address'));
		expect(byTestId('rules-from-address-error')?.textContent).toBe('Trag eine ganze Absenderadresse ein, etwa rechnung@lieferant.ch. Die Regel prüft genau diese eine Adresse; Teile wie „noreply@“ oder eine Domain allein gehen nicht. Für mehrere Adressen leg je eine Regel an.');
		expect(byTestId('rules-label-error')).toBeNull();
		expect(target.querySelector('form')).not.toBeNull();
		expect(spy).not.toHaveBeenCalledWith(t('inbox.rules_error_create'), 'error');
		spy.mockRestore();
	});
});

describe('RulesView — what the form says when the server refuses the value', () => {
	async function submitRefused(error: string, kind: string, value: string): Promise<ReturnType<typeof vi.spyOn>> {
		const toasts = await import('../stores/toast.svelte.js');
		const spy = vi.spyOn(toasts, 'addToast');
		await render({ viewer: 'owner', rules: [], create: () => Response.json({ error }, { status: 400 }) });
		await openForm();
		await choose('rule-match-kind', kind);
		await type(textInputs()[1]!, value);
		target.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await settle();
		return spy;
	}
	const ALERTS = ['rules-from-address-error', 'rules-label-error', 'rules-hidden-chars-error', 'rules-subject-short-error', 'rules-too-long-error', 'rules-list-id-error'];

	it.each([
		['subject phrase must be at least 3 characters', 'subject_contains', 'Hi', 'rules-subject-short-error', 'inbox.rules_error_subject_short'],
		['matcherValue holds characters a reader does not see', 'subject_contains', 'News\u200Bletter', 'rules-hidden-chars-error', 'inbox.rules_error_hidden_chars'],
		['matcherValue must be one line', 'from', 'a@b.example', 'rules-hidden-chars-error', 'inbox.rules_error_hidden_chars'],
		['description holds characters a reader does not see', 'matches_description', 'Mahnungen', 'rules-hidden-chars-error', 'inbox.rules_error_hidden_chars'],
		['list_id rules do not apply yet', 'from', 'a@b.example', 'rules-list-id-error', 'inbox.rules_error_list_id'],
		['matcherValue exceeds 200 characters', 'subject_contains', 'Rechnung', 'rules-too-long-error', 'inbox.rules_error_too_long'],
	])('says "%s" in the form, as an alert, and toasts nothing', async (error, kind, value, testId, key) => {
		const spy = await submitRefused(error, kind, value);
		const alert = byTestId(testId);
		expect(alert?.textContent).toBe(t(key));
		expect(alert?.getAttribute('role')).toBe('alert');
		expect(ALERTS.filter((id) => byTestId(id) !== null)).toEqual([testId]);
		expect(target.querySelector('form')).not.toBeNull();
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});
	it('clears the refusal when the value is sent again, and when the form is opened again', async () => {
		let reply: () => Response = () => Response.json({ error: 'subject phrase must be at least 3 characters' }, { status: 400 });
		await render({ viewer: 'owner', rules: [], create: () => reply() });
		await openForm();
		await choose('rule-match-kind', 'subject_contains');
		await type(textInputs()[1]!, 'Hi');
		target.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await settle();
		expect(byTestId('rules-subject-short-error')).not.toBeNull();
		// Sent again, refused for a reason the form does not name: the old reason must not stay.
		reply = () => Response.json({ error: 'bad' }, { status: 400 });
		target.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await settle();
		expect(byTestId('rules-subject-short-error')).toBeNull();
		// Refused again, then cancelled and opened anew: the new form starts without a refusal.
		reply = () => Response.json({ error: 'subject phrase must be at least 3 characters' }, { status: 400 });
		target.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await settle();
		expect(byTestId('rules-subject-short-error')).not.toBeNull();
		[...target.querySelectorAll<HTMLButtonElement>('form button')].find((b) => b.textContent?.trim() === t('inbox.rules_cancel'))!.click();
		await settle();
		await openForm();
		expect(byTestId('rules-subject-short-error')).toBeNull();
	});

	it('caps a sender or subject value at 200 and a description at 300 in the input', async () => {
		await render({ viewer: 'owner', rules: [] });
		await openForm();
		for (const [kind, max] of [['from', '200'], ['subject_contains', '200'], ['matches_description', '300']] as const) {
			await choose('rule-match-kind', kind);
			expect(textInputs()[1]!.getAttribute('maxlength'), kind).toBe(max);
		}
	});
});

describe('RulesView — list id rules', () => {
	const listRule = { ...confirmed, id: 'rul_l1', matcherKind: 'list_id', matcherValue: 'news.shop.example', name: 'Shop-Newsletter' };

	it('offers no list id kind in the form', async () => {
		await render({ viewer: 'owner', rules: [] });
		await openForm();
		const kinds = [...target.querySelectorAll<HTMLInputElement>('input[name="rule-match-kind"]')].map((r) => r.value);
		expect(kinds).toEqual(['from', 'subject_contains', 'matches_description']);
	});

	it('says under a stored list id rule that it does not apply, keeps its delete, and says it under no other rule', async () => {
		await render({ viewer: 'owner', rules: [confirmed, listRule] });
		const items = [...target.querySelectorAll<HTMLLIElement>('li[id^="rule-"]')];
		expect(items.map((li) => li.id)).toEqual(['rule-rul_c1', 'rule-rul_l1']);
		expect(items[0]!.querySelector('[data-testid="rules-list-id-inactive"]')).toBeNull();
		expect(items[1]!.querySelector('[data-testid="rules-list-id-inactive"]')?.textContent).toBe(t('inbox.rules_list_id_inactive'));
		expect(items[1]!.textContent).toContain(t('inbox.rules_match_list_id'));
		expect(items[1]!.querySelector(`button[aria-label="${t('inbox.rules_delete')}"]`)).not.toBeNull();
		expect(target.querySelectorAll('[data-testid="rules-list-id-inactive"]')).toHaveLength(1);
	});
});

describe('RulesView — the count and the bucket of a rule', () => {
	it('counts the rules that apply with their noun, one and many', async () => {
		await render({ viewer: 'owner', rules: [confirmed] });
		expect(byTestId('rules-count')?.textContent).toBe('1 Regel');
		if (component) unmount(component);
		component = undefined;
		await render({ viewer: 'owner', rules: [confirmed, { ...confirmed, id: 'rul_c2' }, { ...confirmed, id: 'rul_c3' }] });
		expect(byTestId('rules-count')?.textContent).toBe('3 Regeln');
		if (component) unmount(component);
		component = undefined;
		await render({ viewer: 'owner', rules: [] });
		expect(byTestId('rules-count')?.textContent).toBe('0 Regeln');
	});

	// The server files every proposal under "Needs you"; a waiting rule that files mail as handled
	// is not data it sends today. The label is held here so a rule sentence never names the zone.
	it('names the handled bucket of a rule "Erledigt", not the zone "Erledigt heute"', async () => {
		await render({ viewer: 'owner', rules: [{ ...proposal, bucket: 'auto_handled', action: 'archive' }] });
		expect(byTestId('rules-confirm-text')!.textContent).toBe('Regel „Lieferantenrechnungen“ bestätigen? Wenn Absender ist „rechnung@lieferant.example“, dann „Erledigt“. Sie wirkt, sobald du bestätigst.');
		expect(byTestId('rules-proposal')!.textContent).toContain('→ Erledigt');
		expect(byTestId('rules-proposal')!.textContent).not.toContain(t('inbox.zone_handled'));
	});
});
