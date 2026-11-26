import { describe, it, expect } from 'vitest';
import { ACTION_WORDS, API_SETUP_DIALOG, PRESET_NOTE } from './dialog-text.js';
import { flattenPrompt, pv } from '../core/prompt-value.js';

/**
 * Verbatim (U-459): the questions and notes about an API connection call it a "connection",
 * as the settings page does, and the sign-in it holds a "sign-in". The sentences are written out
 * here, not read from the table, so a change of wording fails this test until the review has seen it.
 */
const word = pv`API`;

describe('the API connection questions say connection', () => {
  it('names the delete action a connection delete', () => {
    expect(ACTION_WORDS['api_setup']!['delete']).toEqual({ en: 'delete connection', de: 'Verbindung löschen' });
  });

  it('asks to save a connection', () => {
    expect(flattenPrompt(API_SETUP_DIALOG.en.save(word, 'CRM', [], ''))).toBe('⚠ API: saving "CRM" needs your acceptance.\n\nAccept and save this connection?');
    expect(flattenPrompt(API_SETUP_DIALOG.de.save(word, 'CRM', [], ''))).toBe('⚠ API: Zum Speichern von „CRM“ braucht es deine Zustimmung.\n\nDiese Verbindung annehmen und speichern?');
  });

  it('sends the browser to authorize a connection', () => {
    expect(API_SETUP_DIALOG.en.redirect(['auth.example'])).toBe('You will be sent to auth.example in your own browser to authorize this connection. You sign in there, to that provider — not to lynox — and what comes back is stored here for this connection.');
    expect(API_SETUP_DIALOG.de.redirect(['auth.example'])).toBe('Zur Freigabe dieser Verbindung öffnet sich auth.example in deinem eigenen Browser. Du meldest dich dort beim Anbieter an, nicht bei lynox, und was zurückkommt, wird hier für diese Verbindung gespeichert.');
  });

  it('says what a delete takes from the vault, with the sign-in as the token holder', () => {
    expect(flattenPrompt(API_SETUP_DIALOG.en.losesTokens(2))).toBe(' The 2 token(s) its sign-in stored are removed from the vault with it, also where another connection reads them, which then has to be authorized again.');
    expect(flattenPrompt(API_SETUP_DIALOG.de.losesTokens(1))).toBe(' Das Token, das ihre Anmeldung gespeichert hat, wird mit ihr aus dem Vault entfernt, auch dort, wo eine andere Verbindung es liest; diese muss dann neu autorisiert werden.');
    expect(flattenPrompt(API_SETUP_DIALOG.de.losesTokens(3))).toBe(' Die 3 Tokens, die ihre Anmeldung gespeichert hat, werden mit ihr aus dem Vault entfernt, auch dort, wo eine andere Verbindung sie liest; diese muss dann neu autorisiert werden.');
    expect(flattenPrompt(API_SETUP_DIALOG.de.losesSettings)).toBe(' Die Einstellungen der Verbindung (Endpunkte, Richtlinien, Anmeldeart) werden entfernt.');
  });

  it('asks to adopt the sign-in of a connection', () => {
    const p = { name: 'CRM', id: 'crm-api', by: 'mandate:abc', known: true, hosts: ['api.crm.example'], names: ['CRM_TOKEN'] };
    expect(flattenPrompt(API_SETUP_DIALOG.en.adopt(word, p))).toBe('⚠ API: adopt the sign-in of API connection CRM (id crm-api)? It was authorized at the provider in the session of mandate:abc, which is not active. Once adopted, the connection is yours. The engine then sends to api.crm.example, for your requests and runs, the sign-in\'s tokens and the vault names this connection names, read like any of your connections, values from the environment included: CRM_TOKEN. Adopt it?');
    expect(flattenPrompt(API_SETUP_DIALOG.de.adopt(word, p))).toBe('⚠ API: Die Anmeldung der API-Verbindung CRM (Id crm-api) übernehmen? Sie wurde beim Anbieter in der Sitzung von mandate:abc autorisiert, deren Zugang nicht mehr aktiv ist. Nach der Übernahme gehört die Verbindung dir. lynox sendet dann bei deinen Anfragen und Läufen an api.crm.example die Tokens der Anmeldung und die Vault-Namen, die diese Verbindung nennt. Sie werden gelesen wie bei jeder deiner Verbindungen, Werte aus der Umgebung eingeschlossen: CRM_TOKEN. Übernehmen?');
  });

  it('asks to delete a connection', () => {
    expect(flattenPrompt(API_SETUP_DIALOG.en.deleteProfile(word, 'CRM', 'crm-api', 'api.crm.example', pv``))).toBe('⚠ API: delete the API connection CRM (id crm-api, host api.crm.example)? Delete it?');
    expect(flattenPrompt(API_SETUP_DIALOG.de.deleteProfile(word, 'CRM', 'crm-api', 'api.crm.example', pv``))).toBe('⚠ API: die API-Verbindung CRM löschen (Id crm-api, Host api.crm.example)? Löschen?');
  });

  it('asks to release a vault key to a connection, and refers to it as the connection', () => {
    const p = { name: 'CRM_TOKEN', trailId: 'crm-api', author: 'mandate:abc', slots: [], hosts: ['api.crm.example'], more: 0, viewed: undefined, version: 'v1', clientId: false, held: true };
    expect(flattenPrompt(API_SETUP_DIALOG.en.release(word, p))).toMatch(/^⚠ API: release the vault key CRM_TOKEN to API connection crm-api\? It was set up in the session of mandate:abc\. /);
    expect(flattenPrompt(API_SETUP_DIALOG.de.release(word, p))).toMatch(/^⚠ API: Den Vault-Schlüssel CRM_TOKEN für die API-Verbindung crm-api freigeben\? Sie wurde in der Sitzung von mandate:abc eingerichtet\. /);
  });

  it('says why no authorization address could be derived, about the connection', () => {
    expect(PRESET_NOTE.en.unknownProvider('google')).toBe('No authorization address could be derived: this connection names a provider this engine does not have built in, so there is nothing here to disclose or accept. It knows: google.');
    expect(PRESET_NOTE.en.badPreset('x', 'bad')).toBe('No authorization address could be derived: the built-in provider "x" is defined wrongly in this engine — bad. Nothing on this connection fixes that; report it.');
    expect(PRESET_NOTE.en.missingParam('x', 'the shop', 'shop')).toBe('No authorization address could be derived: the provider "x" needs the shop (auth.oauth.preset_params.shop), which this connection does not supply. Set it with api_setup update — the host is disclosed then.');
    expect(PRESET_NOTE.en.refusedParam('x', 'the shop', 'shop')).toBe('No authorization address could be derived: the value this connection supplies for the shop (auth.oauth.preset_params.shop) is not one the provider "x" accepts. Correct it with api_setup update — the host is disclosed then.');
    expect(PRESET_NOTE.de.unknownProvider('google')).toBe('Es liess sich keine Anmeldeadresse ableiten: Diese Verbindung nennt einen Anbieter, den lynox nicht eingebaut hat, daher gibt es hier nichts offenzulegen oder anzunehmen. Eingebaut sind: google.');
    expect(PRESET_NOTE.de.badPreset('x', 'bad')).toBe('Es liess sich keine Anmeldeadresse ableiten: Der eingebaute Anbieter "x" ist in lynox falsch definiert — bad. An dieser Verbindung lässt sich das nicht beheben; melde es.');
    expect(PRESET_NOTE.de.missingParam('x', 'den Shop', 'shop')).toBe('Es liess sich keine Anmeldeadresse ableiten: Der Anbieter "x" braucht den Shop (auth.oauth.preset_params.shop), und diese Verbindung gibt es nicht an. Setze es mit api_setup update — dann wird der Host offengelegt.');
    expect(PRESET_NOTE.de.refusedParam('x', 'den Shop', 'shop')).toBe('Es liess sich keine Anmeldeadresse ableiten: Der Wert, den diese Verbindung für den Shop (auth.oauth.preset_params.shop) angibt, ist keiner, den der Anbieter "x" annimmt. Korrigiere ihn mit api_setup update — dann wird der Host offengelegt.');
  });
});
