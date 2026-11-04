import { describe, it, expect, afterEach } from 'vitest';
import { t, setLocale, getLocale } from './i18n.svelte.js';

describe('the notice when another restore is running (U-139)', () => {
	const before = getLocale();
	afterEach(() => setLocale(before));

	it('says it word for word in both languages', () => {
		setLocale('en');
		expect(t('backups.restore_running')).toBe('A restore is already running, so this one was not started. Wait for the running restore: when it succeeds, the instance restarts. If the instance does not restart, the running restore did not succeed, and you can start a restore again.');
		setLocale('de');
		expect(t('backups.restore_running')).toBe('Es läuft bereits eine Wiederherstellung, diese hier wurde nicht gestartet. Warte, bis sie fertig ist: Gelingt sie, startet die Instanz neu. Startet sie nicht neu, ist die laufende Wiederherstellung nicht gelungen, und du kannst sie neu starten.');
	});
});
