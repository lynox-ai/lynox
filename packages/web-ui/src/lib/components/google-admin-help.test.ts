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
		expect(CARD.split("t('integrations.google_workspace_admin_hint')").length - 1).toBe(1);
	});

	it('the link opens the docs section in a new tab, so the connect stays open', () => {
		const link = /<a\s+href="([^"]+)"\s+target="([^"]+)"\s+rel="([^"]+)"[^>]*>\{t\('integrations\.google_workspace_admin_link'\)\}<\/a>/.exec(CARD);
		expect(link, 'the link is not where it was').not.toBeNull();
		expect(link![1]).toBe(HELP_URL);
		expect(link![2]).toBe('_blank');
		expect(link![3]).toBe('noopener noreferrer');
	});
});

describe('the docs section the link leads to', () => {
	const section = (): string => {
		const start = DOCS.indexOf('\n## Workspace admin approval\n');
		expect(start, 'the heading the anchor is made from is gone').toBeGreaterThan(-1);
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

	it('names the console path', () => {
		const s = section();
		expect(s).toContain('**Security** → **Access and data control** → **API controls**');
		expect(s).toContain('**Manage App Access** → **Configure new app**');
	});
});
