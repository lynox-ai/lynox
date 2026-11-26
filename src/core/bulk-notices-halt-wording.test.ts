import { describe, it, expect } from 'vitest';
import { BULK_NOTICES } from './bulk-notices.js';
import { BULK_HALT_REASONS } from './bulk-ledger.js';

/**
 * Verbatim: the German push for a run halted on its stored access names the settings page by
 * its label, "API-Verbindungen". Written out here, so a change of wording fails until reviewed.
 */
describe('the German halt notice for a stored access', () => {
  it('names the page where the access is connected again', () => {
    expect(BULK_NOTICES.de.halted('apply', BULK_HALT_REASONS.credential)).toBe('lynox findet keinen gespeicherten Zugang zum Zielsystem. Verbinde ihn unter Einstellungen → API-Verbindungen neu oder bitte lynox im Chat darum.');
    expect(BULK_NOTICES.de.halted('apply', BULK_HALT_REASONS.unauthorized)).toBe('Das Zielsystem hat den gespeicherten Zugang abgelehnt. Ist er unter Einstellungen → API-Verbindungen neu verbunden, lässt sich der Lauf fortsetzen.');
  });
});

/**
 * Verbatim: the English push for the same halts, and the Shopify consent halt in both languages
 * with the run's own summary, name the page by its label, "API connections" / "API-Verbindungen".
 */
describe('the halt notices that name the connections page', () => {
  it('says the English stored-access halts with the page label', () => {
    expect(BULK_NOTICES.en.halted('apply', BULK_HALT_REASONS.credential)).toBe('lynox finds no stored access to the target system. Reconnect it under Settings → API connections, or ask lynox in the chat to do so.');
    expect(BULK_NOTICES.en.halted('apply', BULK_HALT_REASONS.unauthorized)).toBe('The target system refused the stored access. Once it is reconnected under Settings → API connections, the run can be continued.');
  });

  it('says the English Shopify consent halt with the page label', () => {
    expect(BULK_NOTICES.en.halted('apply', BULK_HALT_REASONS.consentOutdated)).toBe('This Shopify connection does not yet let lynox change these fields. Reconnect Shopify (Settings → API connections), then ask lynox in the chat to plan the run again.');
  });

  it('says the Shopify consent summary with the page label, in German and English', () => {
    expect(BULK_NOTICES.de.consentOutdated(['descriptionHtml'], true)).toBe('lynox hat nichts geschrieben. Diese Shopify-Verbindung erlaubt lynox noch nicht, die Beschreibung zu ändern. Verbinde Shopify neu (Einstellungen → API-Verbindungen); dann bitte lynox im Chat, den Lauf neu zu planen.');
    expect(BULK_NOTICES.en.consentOutdated(['descriptionHtml'], false)).toBe('lynox writes nothing more in this run; what it already wrote stays. This Shopify connection does not yet let lynox change the description. Reconnect Shopify (Settings → API connections), then ask lynox in the chat to plan the run again.');
  });
});

/**
 * Verbatim (U-459): the halt for app credentials stored under other names calls the stored
 * access a Shopify connection, and the German push stays within the 157 characters it is held to.
 */
describe('the halt notice for app credentials under other names', () => {
  it('says connection, in German and English', () => {
    const de = BULK_NOTICES.de.halted('apply', BULK_HALT_REASONS.storeClientMisnamed);
    expect(de).toBe('In der Shopify-Verbindung liegen die App-Zugangsdaten unter anderen Namen. Lass das im Chat von lynox anpassen, dann lässt sich der Lauf fortsetzen.');
    expect(de.length).toBeLessThanOrEqual(157);
    expect(BULK_NOTICES.en.halted('apply', BULK_HALT_REASONS.storeClientMisnamed)).toBe('The Shopify connection keeps the app credentials under other names. Have lynox fix that in the chat, then the run can be continued.');
  });
});
