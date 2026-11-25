import { describe, it, expect, afterEach } from 'vitest';
import { t, setLocale, getLocale } from './i18n.svelte.js';

/**
 * Verbatim: the API connections page and the texts that point at it say "connection", not
 * "profile", and the first connect has its own sentence and button. The strings are written out
 * here, not read from the table, so a change of wording fails this test until the review has seen it.
 */
const WORDING: Array<[string, string, string]> = [
	["settings.apis", "API-Verbindungen", "API connections"],
	["apis.title", "API-Verbindungen", "API connections"],
	["apis.no_profiles", "Noch keine API-Verbindung eingerichtet.", "No API connection set up yet."],
	["apis.import_waiting", "Die API-Verbindungen von vor der Umstellung auf engine.db sind noch nicht übernommen: Der Import wartet auf die folgenden Dateien im Ordner der API-Verbindungen. Bis jede repariert oder gelöscht ist, fehlen alle diese Verbindungen. Repariere die Datei oder lösche sie; übernommen wird beim nächsten Start.", "The API connections saved before the move to engine.db are not imported yet: the import waits on the files below in the API connections directory. Until each is repaired or deleted, none of those connections are available. Repair the file or delete it; the import runs at the next start."],
	["apis.import_waiting_not_a_profile", "ist keine lesbare API-Verbindung (nötig sind id und base_url als Text, name als Text oder Zahl und description)", "is no API connection that can be read (it needs an id and a base_url that are text, a name that is text or a number, and a description)"],
	["apis.endpoints", "Endpunkte", "Endpoints"],
	["apis.delete_confirm", "API-Verbindung „{name}“ wirklich löschen?", "Really delete the API connection “{name}”?"],
	["apis.delete_left_slot_partner", "Im Vault geblieben: {names}. Eine andere Verbindung, deren ID sich nur durch - statt _ unterscheidet, nutzt denselben Platz und denselben Token.", "Left in the vault: {names}. Another connection whose id differs only in - versus _ uses the same slot and the same token."],
	["apis.delete_left_unreadable", "Im Vault geblieben: {names}. Eine gespeicherte Verbindung, die nicht gelesen werden konnte, nennt sie auch, deshalb wurden sie nicht entfernt. Kein späteres Löschen nimmt sie mit: Entferne sie von Hand, sobald klar ist, dass sie nicht zu jener Verbindung gehören.", "Left in the vault: {names}. A stored connection that could not be read names them too, so they were not removed. No later delete takes them: remove them by hand once it is clear they are not that connection's."],
	["apis.create_in_chat", "Neue Verbindung", "New connection"],
	["apis.create_in_chat_prompt", "Ich möchte eine neue API-Verbindung einrichten.", "I'd like to set up a new API connection."],
	["apis.manage_in_chat_prompt", "Ich möchte diese API-Verbindung verwalten:", "I'd like to manage this API connection:"],
	["apis.reconnect_not_yours", "Neu verbinden kannst du diese Verbindung nicht, weil du sie nicht eingerichtet hast. Brauchst du sie, wende dich an den Inhaber.", "You cannot reconnect this connection because you did not set it up. If you need it, ask the owner."],
	["apis.owner_only_notice", "Verbindungen löschen und den App-Zugang eintragen kann nur der Inhaber dieser Instanz. Brauchst du das, wende dich an den Inhaber.", "Only the owner of this instance can delete connections or enter app credentials. If you need that, ask the owner."],
	["integrations.preset_client_other_names", "Diese Verbindung nutzt einen App-Zugang, den lynox früher anders gespeichert hat. Was du hier einträgst, käme bei ihr nicht an. Bitte lynox im Chat, die Verbindung zu aktualisieren. Danach zeigt sie hier den App-Zugang dieser Instanz. Ist das Formular leer, trägst du Client-ID und Client-Secret noch einmal ein.", "This connection uses app credentials that lynox stored differently in the past. What you enter here would not reach it. Ask lynox in the chat to update the connection. It then shows the app credentials of this instance here. If the form is empty, enter the Client ID and Client Secret once more."],
	["takeover.connection", "{name} hat {provider} mit einem eigenen Konto verbunden{account}. Nach dem Übernehmen nutzt der Plan diese Verbindung nicht mehr. Braucht er sie, verbinde das Programm selbst mit deinem Konto: in den Einstellungen unter „API-Verbindungen“ über „Neue Verbindung“. Sonst kann der Plan diesen Schritt nicht ausführen.", "{name} connected {provider} with an account of their own{account}. After you take over, the plan no longer uses this connection. If it needs it, connect the service yourself with your own account: in Settings under “API connections”, via “New connection”. Otherwise the plan cannot run this step."],
	["integrations.preset_client_saved", "Gespeichert. Verbinde jetzt dein Konto mit dem Knopf unten.", "Saved. Connect your account with the button below."],
	["integrations.preset_client_saved_plain", "Gespeichert.", "Saved."],
	["apis.connect_first_intro", "Der App-Zugang ist gespeichert. Verbinde jetzt dein {provider}-Konto, damit lynox es nutzen kann.", "The app credentials are saved. Connect your {provider} account so lynox can use it."],
	["apis.connect_first", "Konto verbinden", "Connect account"],
	["apis.connect_first_not_yours", "Verbinden kann diese Verbindung nur, wer sie eingerichtet hat. Brauchst du sie, wende dich an den Inhaber.", "Only the person who set up this connection can connect it. If you need it, ask the owner."],
	["bulk.halt.credential_before", "Öffne Einstellungen → API-Verbindungen und tippe bei der Verbindung für {provider} auf das Chat-Symbol, um den Zugang neu zu verbinden. Gibt es dort keine, bitte lynox im Chat, den Zugang einzurichten.", "Open Settings → API connections and tap the chat icon next to the connection for {provider} to reconnect the access. If there is no connection, ask lynox in the chat to set up the access."],
	["bulk.halt.unauthorized_before", "Öffne Einstellungen → API-Verbindungen und tippe bei der Verbindung für {provider} auf das Chat-Symbol, um den Zugang neu zu verbinden. Danach kannst du fortsetzen.", "Open Settings → API connections and tap the chat icon next to the connection for {provider} to reconnect the access. Then you can continue."],
	["secrets.preset_client_use_form", "Das ist das Client-Secret einer eingebauten Verbindung. Du trägst es im App-Zugang der Verbindung ein (Einstellungen → API-Verbindungen), nicht hier.", "This is the client secret of a built-in provider. Enter it under “App credentials” in its connection (Settings → API connections), not here."],
	["bulk.halt.unauthorized_before_check", "Öffne Einstellungen → API-Verbindungen und tippe bei der Verbindung für {provider} auf das Chat-Symbol, um den Zugang neu zu verbinden. Danach kannst du nachprüfen.", "Open Settings → API connections and tap the chat icon next to the connection for {provider} to reconnect the access. Then you can check again."],
	["apis.delete_confirm_unnamed", "Diese API-Verbindung wirklich löschen?", "Really delete this API connection?"],
	["apis.delete_confirm_host", "Die API-Verbindung für {host} wirklich löschen?", "Really delete the API connection for {host}?"],
	["secrets.retired_preset_client", "Dieser Name gehört zu einer eingebauten Verbindung, die lynox nicht mehr anbietet, und lässt sich hier nicht speichern. Wähl für eine eigene Verbindung einen anderen Namen.", "This name belongs to a built-in provider lynox no longer offers, so it can't be saved here. For a connection of your own, choose another name."],
	["workflow_library.takeover.connection", "{name} hat {provider} mit einem eigenen Konto verbunden{account}. Nach dem Übernehmen nutzt der Workflow diese Verbindung nicht mehr. Braucht er sie, verbinde das Programm selbst mit deinem Konto: in den Einstellungen unter „API-Verbindungen“ über „Neue Verbindung“. Sonst scheitern die markierten Schritte.", "{name} connected {provider} with an account of their own{account}. After you take over, the workflow no longer uses this connection. If it needs it, connect the service yourself with your own account: in Settings under “API connections”, via “New connection”. Otherwise the marked steps fail."],
];

/**
 * Left out on purpose: the five erasure notices on the same page still say "profile". They are
 * binding text and change only after their own sign-off; their wording is held verbatim in
 * `components/apistoreview-provider-revocation.svelte.test.ts`.
 */
const NOT_YET = ['apis.erasure_notice', 'apis.erasure_notice_avert', 'apis.erasure_reconnected_notice', 'apis.erasure_reconnected_avert', 'apis.erasure_connected_again_notice'];

const before = getLocale();
afterEach(() => { setLocale(before); });

describe('the API connections wording', () => {
	it.each(WORDING)('%s, German', (key, de) => {
		setLocale('de');
		expect(t(key)).toBe(de);
	});
	it.each(WORDING)('%s, English', (key, _de, en) => {
		setLocale('en');
		expect(t(key)).toBe(en);
	});
	it('leaves the erasure notices out of this change', () => {
		expect(WORDING.map(([k]) => k).filter((k) => NOT_YET.includes(k))).toEqual([]);
	});
});
