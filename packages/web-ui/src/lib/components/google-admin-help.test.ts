import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
		// The switch starts lynox's consent directly; it never passes the brokered card above. The way back
		// (the pair entered again under "Advanced") is the confirm's body; the next test holds it reachable.
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

	it('names the client id an admin searches for', () => {
		expect(section()).toContain('`554097075249-lcpcoqjhjef3aum3olhffshtvr0k94k5.apps.googleusercontent.com`');
	});

	it('names exactly the scopes lynox\'s client asks for', () => {
		// The broker's list lives in the hosting repo (`DEFAULT_SCOPES`); this is the far side of it.
		const row = /^\| Scopes \| (.+) \|$/m.exec(section());
		expect(row).not.toBeNull();
		const scopes = [...row![1]!.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
		expect(scopes).toEqual([
			'openid',
			'https://www.googleapis.com/auth/userinfo.email',
			'https://www.googleapis.com/auth/calendar.events',
			'https://www.googleapis.com/auth/calendar.freebusy',
			'https://www.googleapis.com/auth/drive.file',
		]);
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
