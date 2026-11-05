import { describe, it, expect, afterEach } from 'vitest';
import { bootStoreLineKeys, bootStoresOf, type BootStore } from './boot-store-notice.js';
import { t, setLocale, getLocale } from './i18n.svelte.js';

/**
 * Verbatim: the status bar line for a boot store that did not open, in both languages, for every
 * combination of stores, both engine.db sentences and both closing sentences, paragraph by paragraph. The strings are written out here, not read
 * from the table, so a change of wording fails this test until the review has seen it.
 */

const ENGINE = {
	de: 'Die Engine ist ohne engine.db gestartet: Trigger und Workflows laufen nicht und lassen sich nicht ändern. API-Verbindungen wie bexio oder Shopify stammen aus einer älteren Kopie; was du an ihnen änderst, kann verloren gehen, sobald die Engine engine.db wieder öffnet.',
	en: 'The engine started without engine.db: triggers and workflows do not run and cannot be changed. API connections such as bexio or Shopify come from an older copy; what you change in them can be lost once the engine opens engine.db again.',
};
// With durable memory on and not loaded for want of engine.db: memory is an old state, access cannot sign in.
const ENGINE_MEMORY = {
	de: 'Die Engine ist ohne engine.db gestartet: Trigger und Workflows laufen nicht und lassen sich nicht ändern, lynox kennt nur einen alten Stand seines Gedächtnisses, und Personen, denen du Zugang gegeben hast, können sich nicht anmelden. API-Verbindungen wie bexio oder Shopify stammen aus einer älteren Kopie; was du an ihnen änderst, kann verloren gehen, sobald die Engine engine.db wieder öffnet.',
	en: 'The engine started without engine.db: triggers and workflows do not run and cannot be changed, lynox only knows an old state of its memory, and people you gave access cannot sign in. API connections such as bexio or Shopify come from an older copy; what you change in them can be lost once the engine opens engine.db again.',
};
const HISTORY = {
	de: 'Die Engine ist ohne history.db gestartet: Verlauf, Threads, Aufgaben, Trigger und Workflows sind nicht verfügbar. Neue Chats werden nicht gespeichert; sie gehen beim Neuladen der Seite oder nach etwa einer halben Stunde ohne Eingabe verloren. Tages- und Monatsgrenzen für Kosten gelten in dieser Zeit nicht.',
	en: 'The engine started without history.db: history, threads, tasks, triggers and workflows are not available. New chats are not saved; they are lost when the page is reloaded or after about half an hour without input. Daily and monthly cost limits do not apply meanwhile.',
};
const SELFHOST = {
	de: 'Das bleibt so, bis die Engine neu startet und dabei wieder alle ihre Dateien öffnen kann. Den Grund nennt das Log, das die Engine beim Start schreibt; behebe ihn und starte die Engine neu.',
	en: 'This lasts until the engine restarts and can open all its files again. The log the engine writes at startup names the cause; fix it and restart the engine.',
};
const MANAGED = {
	de: 'Das bleibt so, bis die Engine neu startet und dabei wieder alle ihre Dateien öffnen kann. Das lynox-Team bekommt dazu automatisch eine Meldung.',
	en: 'This lasts until the engine restarts and can open all its files again. The lynox team gets an automatic alert about it.',
};

const initial = getLocale();
afterEach(() => setLocale(initial));

const render = (missing: BootStore[], alerted: boolean, memoryOld = false): string[] =>
	bootStoreLineKeys(missing, alerted, memoryOld).map((p) => p.map((k) => t(k)).join(' '));

describe('the boot store line, verbatim, one paragraph per store and one for the close', () => {
	for (const lang of ['de', 'en'] as const) {
		for (const alerted of [false, true]) {
			const close = alerted ? MANAGED[lang] : SELFHOST[lang];
			const mode = alerted ? 'managed' : 'self-host';
			it(`${lang}, ${mode}: engine.db alone`, () => {
				setLocale(lang);
				expect(render(['engine.db'], alerted)).toEqual([ENGINE[lang], close]);
			});
			it(`${lang}, ${mode}: engine.db alone with durable memory not loaded`, () => {
				setLocale(lang);
				expect(render(['engine.db'], alerted, true)).toEqual([ENGINE_MEMORY[lang], close]);
			});
			it(`${lang}, ${mode}: history.db alone, the memory flag changes nothing`, () => {
				setLocale(lang);
				expect(render(['history.db'], alerted)).toEqual([HISTORY[lang], close]);
				expect(render(['history.db'], alerted, true)).toEqual([HISTORY[lang], close]);
			});
			it(`${lang}, ${mode}: both, the closing paragraph once`, () => {
				setLocale(lang);
				expect(render(['engine.db', 'history.db'], alerted)).toEqual([ENGINE[lang], HISTORY[lang], close]);
				expect(render(['engine.db', 'history.db'], alerted, true)).toEqual([ENGINE_MEMORY[lang], HISTORY[lang], close]);
			});
		}
	}

	it('is empty when nothing is missing, in either mode', () => {
		expect(bootStoreLineKeys([], false)).toEqual([]);
		expect(bootStoreLineKeys([], true)).toEqual([]);
	});

	it('reads only the two store names from the field, in a fixed order', () => {
		expect(bootStoresOf(['history.db', 'engine.db'])).toEqual(['engine.db', 'history.db']);
		expect(bootStoresOf(['vault.db', 42, null, 'history.db'])).toEqual(['history.db']);
		expect(bootStoresOf('engine.db')).toEqual([]);
		expect(bootStoresOf(undefined)).toEqual([]);
	});
});
