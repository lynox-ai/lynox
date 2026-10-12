import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OAUTH_DECLINE_CODES } from '../../contract/http.js';
import { googleOAuthErrorNotice } from './google-oauth-error.js';

/**
 * A Google connect that comes back without a grant carries `google_oauth_error`.
 * The card must say something for every code in the contract set and for a value
 * outside it; before this, the parameter was read nowhere and the user landed on
 * an unchanged card.
 */
describe('googleOAuthErrorNotice', () => {
	it('is silent when there is no parameter', () => {
		expect(googleOAuthErrorNotice(null)).toBeNull();
	});

	it('maps each contract code to its notice', () => {
		const got = Object.fromEntries(OAUTH_DECLINE_CODES.map((c) => [c, googleOAuthErrorNotice(c)]));
		expect(got).toEqual({
			missing_token: { key: 'integrations.google_oauth_link_stale', type: 'error' },
			expired: { key: 'integrations.google_oauth_link_stale', type: 'error' },
			replayed: { key: 'integrations.google_oauth_link_stale', type: 'error' },
			bad_signature: { key: 'integrations.google_oauth_failed', type: 'error' },
			instance_unbound: { key: 'integrations.google_oauth_failed', type: 'error' },
			access_denied: { key: 'integrations.google_oauth_cancelled', type: 'info' },
			exchange_failed: { key: 'integrations.google_oauth_failed', type: 'error' },
		});
	});

	it('gives a value outside the contract set the generic failure, never silence', () => {
		for (const raw of ['admin_policy_enforced', '', 'ACCESS_DENIED']) {
			expect(googleOAuthErrorNotice(raw)).toEqual({ key: 'integrations.google_oauth_failed', type: 'error' });
		}
	});
});

// Source-level, because neither the card nor i18n can be imported here (the root
// config has no svelte plugin) and the two files must agree with the helper.
const card = readFileSync(fileURLToPath(new URL('../../components/GoogleSettings.svelte', import.meta.url)), 'utf-8');
const i18n = readFileSync(fileURLToPath(new URL('../../i18n.svelte.ts', import.meta.url)), 'utf-8');

describe('the Google card reads the parameter', () => {
	it('reads google_oauth_error, removes it from the URL and shows the notice', () => {
		expect(card).toContain("googleOAuthErrorNotice(params.get('google_oauth_error'))");
		expect(card).toContain("url.searchParams.delete('google_oauth_error')");
		expect(card).toContain('addToast(t(notice.key), notice.type, 12000)');
	});
});

describe('every notice key has one German and one English line', () => {
	const lines: Record<string, string> = {
		'integrations.google_oauth_cancelled': "\t'integrations.google_oauth_cancelled': { de: 'Google-Verbindung abgebrochen. Es wurde nichts verbunden.', en: 'Google connection cancelled. Nothing was connected.' },",
		'integrations.google_oauth_link_stale': "\t'integrations.google_oauth_link_stale': { de: 'Der Verbindungslink war abgelaufen oder schon benutzt. Bitte verbinde Google erneut.', en: 'The connection link had expired or was already used. Please connect Google again.' },",
		'integrations.google_oauth_failed': "\t'integrations.google_oauth_failed': { de: 'Google-Verbindung fehlgeschlagen. Bitte versuche es erneut. Gehört dein Konto zu einem Google Workspace deiner Firma, muss dessen Admin lynox eventuell zuerst freigeben.', en: 'Google connection failed. Please try again. If your account belongs to your company\\'s Google Workspace, its admin may need to allow lynox first.' },",
	};
	for (const [key, line] of Object.entries(lines)) {
		it(key, () => {
			const hits = i18n.split('\n').filter((l) => l.includes(`'${key}':`));
			expect(hits).toEqual([line]);
		});
	}
});
