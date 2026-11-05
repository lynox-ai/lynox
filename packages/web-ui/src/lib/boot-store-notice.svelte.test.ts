import { describe, it, expect, afterEach } from 'vitest';
import { bootStoreLineKeys, bootStoresOf, type BootStore } from './boot-store-notice.js';
import { t, setLocale, getLocale } from './i18n.svelte.js';

/**
 * U-162, verbatim: the status bar line for a boot store that did not open, in both languages, for
 * every combination of stores and both closing sentences. The strings are written out here, not read
 * from the table, so a change of wording fails this test until the review has seen it.
 */

const ENGINE = {
	de: 'Die Engine ist ohne engine.db gestartet: Trigger und Workflows laufen nicht und lassen sich nicht ändern, lynox kennt nur einen alten Stand seines Gedächtnisses, und Personen, denen du Zugang gegeben hast, können sich nicht anmelden. API-Verbindungen wie bexio oder Shopify stammen aus einer älteren Kopie; was du an ihnen änderst, geht verloren, sobald die Engine engine.db wieder öffnet.',
	en: 'The engine started without engine.db: triggers and workflows do not run and cannot be changed, lynox only knows an old state of its memory, and people you gave access cannot sign in. API connections such as bexio or Shopify come from an older copy; what you change in them is lost once the engine opens engine.db again.',
};
const HISTORY = {
	de: 'Die Engine ist ohne history.db gestartet: Verlauf, Threads, Aufgaben, Trigger und Workflows sind nicht verfügbar. Neue Chats werden nicht gespeichert; sie gehen beim Neuladen der Seite oder nach einer halben Stunde ohne Eingabe verloren. Tages- und Monatsgrenzen für Kosten gelten in dieser Zeit nicht.',
	en: 'The engine started without history.db: history, threads, tasks, triggers and workflows are not available. New chats are not saved; they are lost when the page is reloaded or after half an hour without input. Daily and monthly cost limits do not apply meanwhile.',
};
const SELFHOST = {
	de: 'Das bleibt so, bis die Engine neu startet und dabei wieder alle ihre Dateien öffnen kann. Den Grund nennt das Container-Log; behebe ihn und starte die Engine neu.',
	en: 'This lasts until the engine restarts and can open all its files again. The container log names the cause; fix it and restart the engine.',
};
const MANAGED = {
	de: 'Das bleibt so, bis die Engine neu startet und dabei wieder alle ihre Dateien öffnen kann. Das lynox-Team bekommt dazu automatisch eine Meldung.',
	en: 'This lasts until the engine restarts and can open all its files again. The lynox team gets an automatic alert about it.',
};

const initial = getLocale();
afterEach(() => setLocale(initial));

const render = (missing: BootStore[], alerted: boolean): string => bootStoreLineKeys(missing, alerted).map((k) => t(k)).join(' ');

describe('the boot store line, verbatim (U-162)', () => {
	for (const lang of ['de', 'en'] as const) {
		for (const alerted of [false, true]) {
			const close = alerted ? MANAGED[lang] : SELFHOST[lang];
			const mode = alerted ? 'managed' : 'self-host';
			it(`${lang}, ${mode}: engine.db alone`, () => {
				setLocale(lang);
				expect(render(['engine.db'], alerted)).toBe(`${ENGINE[lang]} ${close}`);
			});
			it(`${lang}, ${mode}: history.db alone`, () => {
				setLocale(lang);
				expect(render(['history.db'], alerted)).toBe(`${HISTORY[lang]} ${close}`);
			});
			it(`${lang}, ${mode}: both, the closing sentence once`, () => {
				setLocale(lang);
				expect(render(['engine.db', 'history.db'], alerted)).toBe(`${ENGINE[lang]} ${HISTORY[lang]} ${close}`);
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
