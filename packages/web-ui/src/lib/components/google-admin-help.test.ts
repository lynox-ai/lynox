import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GOOGLE_BROKER_SCOPES } from '../contract/http.js';

/**
 * A company account whose Google Workspace admin restricts third-party apps cannot connect through
 * lynox's client until the admin configures it, and Google shows that refusal on its own page. So
 * the Google card says so before the connect, and links the admin's instructions in the docs.
 *
 * Source is read, not mounted: `i18n.svelte.ts` holds the locale in a `$state` rune, and the docs
 * page is the far side of the link.
 */
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const I18N = read('../i18n.svelte.ts');
const CARD = read('./GoogleSettings.svelte');
const DOCS = read('../../../../../docs/src/content/docs/integrations/google-workspace.md');

const HELP_URL = 'https://docs.lynox.ai/integrations/google-workspace/#workspace-admin-approval';

function entry(key: string): { de: string; en: string } | null {
	const lines = I18N.split('\n').filter((l) => l.trimStart().startsWith(`'${key}':`));
	if (lines.length !== 1) return null;
	const de = /\bde:\s*'((?:[^'\\]|\\.)*)'/.exec(lines[0]!);
	const en = /\ben:\s*'((?:[^'\\]|\\.)*)'/.exec(lines[0]!);
	return de && en ? { de: de[1]!, en: en[1]! } : null;
}

describe('the Google card names the admin\'s approval before the connect', () => {
	it('the sentence and the link read as ux wrote them (U-057)', () => {
		expect(entry('integrations.google_workspace_admin_hint')).toEqual({
			de: 'Nutzt du ein Google-Workspace-Konto deiner Firma, muss dessen Admin lynox womöglich zuerst freigeben.',
			en: 'Using a company Google Workspace account? Its admin may need to allow lynox first.',
		});
		expect(entry('integrations.google_workspace_admin_link')).toEqual({
			de: 'Anleitung für den Admin (englisch)',
			en: 'Instructions for your admin',
		});
	});

	it('it stands in the brokered branch, right after the connect button, and nowhere else', () => {
		const branch = /\{#if brokerAvailable\}([\s\S]*?)\{:else\}/.exec(CARD);
		expect(branch, 'the brokered branch is not where it was').not.toBeNull();
		const inBranch = branch![1]!;
		const button = inBranch.indexOf("{t('integrations.google_broker_connect')}");
		const hint = inBranch.indexOf("{t('integrations.google_workspace_admin_hint')}");
		expect(button).toBeGreaterThan(-1);
		expect(hint).toBeGreaterThan(button);
	});

	it('the switch from the tenant\'s own client to lynox\'s says it in its own words, inside its confirm', () => {
		// The switch starts lynox's consent directly; it never passes the brokered card above. The way back,
		// entering the pair again, is in the confirm's body; the next test holds the place to do it reachable.
		const confirm = /\{#if switchConfirmOpen\}([\s\S]*?)\{\/if\}/.exec(CARD);
		expect(confirm, 'the switch confirm is not where it was').not.toBeNull();
		const inConfirm = confirm![1]!;
		const hint = inConfirm.indexOf("{t('integrations.google_switch_admin_hint')}");
		const link = inConfirm.indexOf("{t('integrations.google_workspace_admin_link')}");
		expect(hint).toBeGreaterThan(-1);
		expect(link).toBeGreaterThan(hint);
		expect(link).toBeLessThan(inConfirm.indexOf('onclick={confirmSwitchToManaged}'));
		// Its paragraphs in the text colour: the warning's orange on its tint is under 4.5:1 (ux U-057).
		const paragraphs = [...inConfirm.matchAll(/<p class="([^"]*)"[^>]*>\s*\{t\('integrations\.(google_switch_confirm_body|google_grant_stays|google_switch_admin_hint)'\)\}/g)];
		expect(paragraphs.map((m) => m[2])).toEqual(['google_switch_confirm_body', 'google_grant_stays', 'google_switch_admin_hint']);
		for (const m of paragraphs) expect(m[1]!.split(/\s+/)).toEqual(['text-xs', 'text-text']);
		// Each sentence in its one place.
		expect(CARD.split("t('integrations.google_workspace_admin_hint')").length - 1).toBe(1);
		expect(CARD.split("t('integrations.google_switch_admin_hint')").length - 1).toBe(1);
	});

	it('the way back it names is on the brokered card, outside the condition on lynox\'s client being offered', () => {
		const brokered = /\{:else if isBroker && !getGoogleStatus\(\)\?\.authenticated\}([\s\S]*?)\{:else if/.exec(CARD);
		expect(brokered).not.toBeNull();
		const afterBranch = brokered![1]!.slice(brokered![1]!.indexOf('{/if}'));
		expect(afterBranch).toContain("{t('integrations.google_advanced')}");
		expect(afterBranch).toContain('onclick={saveGoogleCredentials}');
	});

	it('the switch\'s sentences read as ux wrote them (U-057)', () => {
		expect(entry('integrations.google_switch_admin_hint')).toEqual({
			de: 'Hat der Admin deiner Firma bisher nur deinen eigenen Client freigegeben, sperrt Google den Client von lynox, bis er auch diesen freigibt.',
			en: 'If your company\\\'s admin has approved only your own client so far, Google blocks lynox\\\'s client until they approve it too.',
		});
	});

	it('the link opens the docs section in a new tab, so the connect stays open', () => {
		const links = [...CARD.matchAll(/<a\s+href="([^"]+)"\s+target="([^"]+)"\s+rel="([^"]+)"[^>]*>\{t\('integrations\.google_workspace_admin_link'\)\}<\/a>/g)];
		expect(links).toHaveLength(2);
		for (const link of links) {
			expect(link[1]).toBe(HELP_URL);
			expect(link[2]).toBe('_blank');
			expect(link[3]).toBe('noopener noreferrer');
		}
	});
});

describe('the docs section the link leads to', () => {
	const section = (): string => {
		const start = DOCS.indexOf('\n## Workspace admin approval\n');
		expect(start, 'the heading the anchor is made from is gone').toBeGreaterThan(-1);
		// A second heading of that name would move the anchor to `-1`.
		expect(DOCS.split(/^#+ Workspace admin approval$/m).length - 1).toBe(1);
		const end = DOCS.indexOf('\n## ', start + 1);
		return DOCS.slice(start, end);
	};

	it('has the heading the link\'s anchor is made from, once', () => {
		expect(DOCS).toContain('\n## Workspace admin approval\n');
		// A second heading of that name would move the anchor to `-1`.
		expect(DOCS.split(/^#+ Workspace admin approval$/m).length - 1).toBe(1);
	});

	it('names the client id an admin searches for', () => {
		expect(section()).toContain('`554097075249-lcpcoqjhjef3aum3olhffshtvr0k94k5.apps.googleusercontent.com`');
	});

	it('names exactly the scopes lynox\'s client asks for', () => {
		// The contract list is the one the control plane's broker is to send (bound on its side separately).
		const row = /^\| Scopes \| (.+) \|$/m.exec(section());
		expect(row).not.toBeNull();
		const scopes = [...row![1]!.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
		expect(scopes).toEqual([...GOOGLE_BROKER_SCOPES]);
	});

	it('explains every data scope on the list, and its Gmail sentence still holds', () => {
		// When the list changes, the paragraph under it changes in the same PR (legal, row 370).
		const s = section();
		const start = s.indexOf('`calendar.events` and');
		const end = s.indexOf('**Where to configure it**');
		expect(start, 'the paragraph under the table is gone').toBeGreaterThan(-1);
		expect(end, 'the heading after the paragraph is gone').toBeGreaterThan(start);
		const paragraph = s.slice(start, end);
		const identity = new Set(['openid', 'https://www.googleapis.com/auth/userinfo.email']);
		const named = GOOGLE_BROKER_SCOPES.filter((x) => !identity.has(x)).map((x) => x.replace('https://www.googleapis.com/auth/', ''));
		// Both directions: every data scope is explained, and nothing it explains has left the list.
		const mentioned = new Set([...paragraph.matchAll(/`([^`]+)`/g)].map((m) => m[1]!));
		expect([...mentioned].sort()).toEqual([...named].sort());
		expect(paragraph).toContain('lynox does not ask for Gmail with this client.');
		const list: readonly string[] = GOOGLE_BROKER_SCOPES;
		expect(list.filter((x) => x.includes('/auth/gmail') || x === 'https://mail.google.com/')).toEqual([]);
	});

	it('says what drive.file reaches as Google defines it', () => {
		expect(section()).toContain('`drive.file` is per file: it reaches only files lynox created or that the person opened or shared with lynox, not the rest of their Drive.');
	});

	it('names the console path', () => {
		const s = section();
		expect(s).toContain('**Security** → **Access and data control** → **API controls**');
		expect(s).toContain('**Manage App Access** → **Configure new app**');
	});
});

describe('the other places on the page that say what the Standard set holds', () => {
	// Row 370: besides the admin table, the page says in prose what the standard consent asks
	// for. Each statement is tied to the contract list, so a scope change in EITHER direction
	// fails here until the page says the new truth.
	const short = (x: string): string => x.replace('https://www.googleapis.com/auth/', '');
	const identity = new Set(['openid', 'userinfo.email']);
	const inSet = new Set(GOOGLE_BROKER_SCOPES.map(short).filter((x) => !identity.has(x)));

	// Every scope the prose has a phrase for, sent or not. A phrase must appear in both passages
	// exactly while its scope is on the list — so dropping a scope forces its phrase out.
	const PHRASES: Record<string, string> = {
		'calendar.events': 'calendar events',
		'calendar.freebusy': 'free/busy',
		'drive.file': 'drive files lynox',
	};
	const NOT_IN_THE_SET = ['gmail', 'sheets', 'docs', 'document', 'spreadsheet', 'full drive', 'contacts', 'tasks'];

	const between = (from: string, to: string, fence?: string): string => {
		const start = DOCS.indexOf(from);
		expect(start, `the passage opening with ${from} is gone`).toBeGreaterThan(-1);
		const end = DOCS.indexOf(to, start + from.length);
		expect(end, `the end of the passage opening with ${from} is gone`).toBeGreaterThan(start);
		if (fence !== undefined) {
			const close = DOCS.indexOf(fence, start + from.length);
			expect(close, 'the end anchor moved out of its block').toBeGreaterThan(end);
		}
		return DOCS.slice(start, end).toLowerCase();
	};
	// The managed tip, up to the sentence that names what the set does NOT include.
	const tip = (): string => between(':::tip[On lynox.cloud you can skip all of it]', 'If you need more than that', '\n:::');
	const standardRow = (): string => between('| **Standard** (default) |', '\n');

	it('has a phrase for every data scope on the list, and the phrases cannot stand in for each other', () => {
		for (const scope of inSet) expect(Object.keys(PHRASES), `no phrase for ${scope}`).toContain(scope);
		const phrases = Object.values(PHRASES);
		for (const a of phrases) for (const b of phrases) if (a !== b) expect(b.includes(a), `${a} is inside ${b}`).toBe(false);
	});

	it.each([['the managed tip', tip], ['the Standard row of the access-level table', standardRow]] as const)(
		'%s names exactly the scopes on the list, and nothing outside the set',
		(_name, passage) => {
			const text = passage();
			for (const [scope, phrase] of Object.entries(PHRASES)) {
				expect(text.includes(phrase), `${phrase} (${scope}) ${inSet.has(scope) ? 'missing' : 'still named, but off the list'}`).toBe(inSet.has(scope));
			}
			for (const word of NOT_IN_THE_SET) expect(text, `names ${word}`).not.toContain(word);
		},
	);

	it('the per-service sections claim membership only for scopes on the list', () => {
		// `Standard grants \`x\`` and `\`x\` is part of Standard` are claims about the list.
		const claimed = [
			...[...DOCS.matchAll(/Standard grants `([^`]+)`/g)].map((m) => m[1]!),
			...[...DOCS.matchAll(/`([^`]+)` is part of Standard/g)].map((m) => m[1]!),
		];
		expect(claimed.length, 'the membership claims are gone').toBeGreaterThan(0);
		for (const scope of claimed) expect(inSet, `${scope} is claimed for Standard`).toContain(scope);
		// The Calendar heading says the whole service is in; it is while events are.
		expect(DOCS.includes('### Google Calendar — in the Standard set')).toBe(inSet.has('calendar.events'));
		// The services the page says Standard leaves out are out.
		const list: readonly string[] = GOOGLE_BROKER_SCOPES;
		const out: Array<[string, RegExp]> = [
			['Gmail is **not** part of the Standard set.', /\/auth\/gmail|mail\.google\.com/],
			['Standard grants no Sheets access.', /\/auth\/spreadsheets/],
			['Standard grants no Docs access at all, reading included.', /\/auth\/documents/],
		];
		for (const [sentence, scope] of out) {
			expect(DOCS, `the sentence "${sentence}" is gone`).toContain(sentence);
			expect(list.filter((x) => scope.test(x)), sentence).toEqual([]);
		}
	});
});
