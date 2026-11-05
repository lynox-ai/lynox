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
	viewer: Viewer;
	rules?: unknown[];
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
		if (path.endsWith('/config')) return Response.json({ viewer: a.viewer });
		if (path.endsWith('/inbox/counts')) return Response.json({ counts: {}, snoozed: 0, rulesPending: 1 });
		if (path.endsWith('/mail/accounts')) return Response.json({ accounts: [{ id: 'info', displayName: 'Info', address: 'info@example.com', isDefault: true }, { id: 'sales', address: 'sales@example.com' }] });
		if (path.endsWith('/inbox/rules')) return Response.json({ rules: a.rules ?? [proposal, confirmed] });
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
		expect(text).toBe('Regel bestätigen? Lieferantenrechnungen — wenn Absender enthält „rechnung@lieferant.example“, dann „Braucht dich“. Sie wirkt, sobald du bestätigst.');
		expect(text).toBe(tf('inbox.rules_confirm_text', { name: 'Lieferantenrechnungen', match: t('inbox.rules_match_from'), value: 'rechnung@lieferant.example', bucket: t('inbox.zone_needs_you') }));
		expect(button(t('inbox.rules_confirm'))).toBeDefined();
		expect(byTestId('rules-proposals-mandate')).toBeNull();
	});

	it('names an unnamed proposal by its value, as the server does', async () => {
		await render({ viewer: 'owner', rules: [{ ...proposal, name: undefined }] });
		expect(byTestId('rules-confirm-text')!.textContent).toMatch(/^Regel bestätigen\? rechnung@lieferant\.example — wenn/);
	});

	it('confirms through the owner route and reloads the rules and the count', async () => {
		let rulesAfter: unknown[] = [proposal, confirmed];
		await render({ viewer: 'owner', rules: rulesAfter, confirm: () => { rulesAfter = [{ ...proposal, confirmedAt: '2026-11-05T00:00:00Z' }, confirmed]; return Response.json({ id: 'rul_p1' }); } });
		button(t('inbox.rules_confirm'))!.click();
		await settle();
		expect(writes).toEqual([{ method: 'POST', path: '/api/inbox/rules/rul_p1/confirm', body: {} }]);
		const fetched = (vi.mocked(fetch).mock.calls as Array<[string, RequestInit?]>).map(([u]) => String(u).split('?')[0]);
		expect(fetched.filter((p) => p === '/api/inbox/counts').length).toBeGreaterThanOrEqual(2);
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

	it('opens no form for a mandate', async () => {
		pageUrl.href = 'http://localhost/app/inbox/rules?accountId=sales&kind=from&value=a%40b.example';
		await render({ viewer: 'mandate', rules: [] });
		expect(target.querySelector('form')).toBeNull();
	});
});
