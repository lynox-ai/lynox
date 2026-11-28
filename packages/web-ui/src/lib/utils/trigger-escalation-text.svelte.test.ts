// Runs in the browser-compile project (vitest.config.ts): the i18n table is a Svelte module.
import { describe, it, expect, afterEach } from 'vitest';
import { t, setLocale, getLocale } from '../i18n.svelte.js';
import { escalationChatLink, escalationNotice } from './trigger-escalation.js';

const AT = '2026-10-09T08:00:00.000Z';
const said = (outcome: string): string =>
	t(escalationNotice({ last_escalation_at: AT, last_escalation_outcome: outcome })!.key);

/**
 * The whole sentence per branch: a notice that a wakeup reached nobody names why and
 * where the owner fixes it, when that helps. Where the question or alert is, the link below
 * the notice says (`escalationChatLink`), not the sentence.
 */
describe('what the trigger view says when a wakeup reached nobody', () => {
	const before = getLocale();
	afterEach(() => { setLocale(before); });

	// Also what a push that reached only a mandate's device records (worker-loop-task-ask-hooks.test.ts).
	it('none of the owner\'s devices received it: where push is turned on or checked', () => {
		setLocale('de');
		expect(said('not_delivered')).toBe('Keine Push-Benachrichtigung angekommen: keines deiner Geräte hat sie erhalten. Push-Benachrichtigungen schaltest du unter Einstellungen › Kanäle › Push-Benachrichtigungen ein oder prüfst sie dort.');
		setLocale('en');
		expect(said('not_delivered')).toBe('No push notification arrived: none of your devices received it. Turn on or check push notifications under Settings › Channels › Push notifications.');
	});

	it('no device set up, or its setup expired: where to set it up', () => {
		const saidCase = (c: string): string => t(escalationNotice({ last_escalation_at: AT, last_escalation_outcome: 'not_delivered', last_escalation_case: c })!.key);
		setLocale('de');
		expect(saidCase('no_subscription')).toBe('Keine Push-Benachrichtigung angekommen: Auf keinem deiner Geräte sind Push-Benachrichtigungen eingerichtet, oder die Einrichtung ist abgelaufen. Richte sie unter Einstellungen › Kanäle › Push-Benachrichtigungen ein.');
		setLocale('en');
		expect(saidCase('no_subscription')).toBe('No push notification arrived: push notifications are not set up on any of your devices, or their setup has expired. Set them up under Settings › Channels › Push notifications.');
	});

	it('the push service refused or could not be reached: that the settings are not the cause', () => {
		const saidCase = (c: string): string => t(escalationNotice({ last_escalation_at: AT, last_escalation_outcome: 'not_delivered', last_escalation_case: c })!.key);
		setLocale('de');
		expect(saidCase('send_failed')).toBe('Keine Push-Benachrichtigung angekommen: Der Push-Dienst hat sie nicht angenommen oder war nicht erreichbar. An deinen Einstellungen liegt es nicht.');
		setLocale('en');
		expect(saidCase('send_failed')).toBe('No push notification arrived: the push service did not accept it or could not be reached. Your settings are not the cause.');
	});

	it('a sent or unconfirmed question says question, an alert says alert', () => {
		const saidKind = (outcome: string, kind: string): string => t(escalationNotice({ last_escalation_at: AT, last_escalation_outcome: outcome, last_escalation_kind: kind })!.key);
		setLocale('de');
		expect([saidKind('delivered', 'question'), saidKind('unconfirmed', 'question'), saidKind('delivered', 'alert'), saidKind('unconfirmed', 'alert')])
			.toEqual(['Frage verschickt', 'Frage ausgelöst, Versand nicht bestätigt', 'Meldung verschickt', 'Meldung ausgelöst, Versand nicht bestätigt']);
		setLocale('en');
		expect([saidKind('delivered', 'question'), saidKind('unconfirmed', 'question'), saidKind('delivered', 'alert'), saidKind('unconfirmed', 'alert')])
			.toEqual(['Question sent', 'Question raised, sending not confirmed', 'Alert sent', 'Alert raised, sending not confirmed']);
	});

	it('the link to the chat says which it opens, a question or an alert', () => {
		const link = (kind: string): string => t(escalationChatLink({ last_escalation_at: AT, last_escalation_outcome: 'delivered', last_escalation_chat: { threadId: 'x', kind } })!.key);
		setLocale('de');
		expect([link('question'), link('alert')]).toEqual(['Frage im Chat öffnen', 'Meldung im Chat öffnen']);
		setLocale('en');
		expect([link('question'), link('alert')]).toEqual(['Open the question in the chat', 'Open the alert in the chat']);
	});

	it('push not available on the instance: the reason', () => {
		setLocale('de');
		expect(said('no_channel')).toBe('Keine Push-Benachrichtigung verschickt: Push-Benachrichtigungen waren auf dieser Instanz nicht verfügbar.');
		setLocale('en');
		expect(said('no_channel')).toBe('No push notification sent: push notifications were not available on this instance.');
	});
});
