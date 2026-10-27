// Runs in the browser-compile project (vitest.config.ts): the i18n table is a Svelte module.
import { describe, it, expect, afterEach } from 'vitest';
import { t, setLocale, getLocale } from '../i18n.svelte.js';
import { escalationNotice } from './trigger-escalation.js';

const AT = '2026-10-09T08:00:00.000Z';
const said = (outcome: string): string =>
	t(escalationNotice({ last_escalation_at: AT, last_escalation_outcome: outcome })!.key);

/**
 * The whole sentence per branch (ux U-033): a notice that a wakeup reached nobody names why and
 * where the owner fixes it. Without a thread id on the trigger, no branch says where the
 * question is.
 */
describe('what the trigger view says when a wakeup reached nobody', () => {
	const before = getLocale();
	afterEach(() => { setLocale(before); });

	it('no device accepted it: where push is turned on or checked', () => {
		setLocale('de');
		expect(said('not_delivered')).toBe('Keine Benachrichtigung angekommen: kein Gerät hat sie angenommen. Push-Benachrichtigungen schaltest du unter Einstellungen › Kanäle › Push-Benachrichtigungen ein oder prüfst sie dort.');
		setLocale('en');
		expect(said('not_delivered')).toBe('No notification arrived: no device accepted it. Turn on or check push notifications under Settings › Channels › Push notifications.');
	});

	it('push not available on the instance: the reason', () => {
		setLocale('de');
		expect(said('no_channel')).toBe('Keine Benachrichtigung verschickt: Push-Benachrichtigungen sind auf dieser Instanz gerade nicht verfügbar.');
		setLocale('en');
		expect(said('no_channel')).toBe('No notification sent: push notifications are not available on this instance right now.');
	});
});
