import { describe, it, expect, afterEach } from 'vitest';
import { setAsideCopiesNotice, noticeText, type SetAsideCopy } from './erasure-set-aside.js';
import { t, setLocale, getLocale } from './i18n.svelte.js';

describe('setAsideCopiesNotice: what the person erasure says about set-aside copies (U-389)', () => {
	const before = getLocale();
	afterEach(() => setLocale(before));
	const copy = (file: string, ...companions: string[]): SetAsideCopy => ({ file, companions });
	const one = [copy('engine.db.corrupt-1700000000000')];
	const two = [copy('agent-memory.db.corrupt-1700000000001'), copy('engine.db.corrupt-1700000000000')];
	const text = (copies: SetAsideCopy[] | null | undefined, way: 'managed' | 'self' | 'loading' | 'failed'): string[] =>
		noticeText(setAsideCopiesNotice(copies, way, t));

	it('says nothing when no copy was set aside, or the engine does not send the field', () => {
		expect(setAsideCopiesNotice([], 'managed', t)).toEqual([]);
		expect(setAsideCopiesNotice(undefined, 'self', t)).toEqual([]);
	});

	it('one copy on lynox Cloud: the singular and the support address, DE and EN', () => {
		setLocale('de');
		expect(text(one, 'managed').join(' ')).toBe('Eine als beschädigt beiseitegelegte Kopie der Datenbank engine.db.corrupt-1700000000000 kann noch Daten zu dieser Person enthalten. Diese Löschung erreicht sie nicht. Wir entfernen sie, wenn du an support@lynox.ai schreibst.');
		setLocale('en');
		expect(text(one, 'managed').join(' ')).toBe('A copy of the database that was set aside as damaged engine.db.corrupt-1700000000000 may still hold data about this person. This erasure does not reach it. We remove it if you write to support@lynox.ai.');
	});

	it('two copies on lynox Cloud: the plural, both names in one sentence', () => {
		setLocale('de');
		expect(text(two, 'managed').join(' ')).toBe('Als beschädigt beiseitegelegte Kopien der Datenbank agent-memory.db.corrupt-1700000000001 engine.db.corrupt-1700000000000 können noch Daten zu dieser Person enthalten. Diese Löschung erreicht sie nicht. Wir entfernen sie, wenn du an support@lynox.ai schreibst.');
		setLocale('en');
		expect(text(two, 'managed').join(' ')).toBe('Copies of the database that were set aside as damaged agent-memory.db.corrupt-1700000000001 engine.db.corrupt-1700000000000 may still hold data about this person. This erasure does not reach them. We remove them if you write to support@lynox.ai.');
	});

	it('one copy self-hosted: the file in the data directory, no path', () => {
		setLocale('de');
		expect(text(one, 'self').join(' ')).toBe('Eine als beschädigt beiseitegelegte Kopie der Datenbank engine.db.corrupt-1700000000000 kann noch Daten zu dieser Person enthalten. Diese Löschung erreicht sie nicht. Du kannst die Datei im Datenverzeichnis löschen.');
		setLocale('en');
		expect(text(one, 'self').join(' ')).toBe('A copy of the database that was set aside as damaged engine.db.corrupt-1700000000000 may still hold data about this person. This erasure does not reach it. You can delete the file in the data directory.');
	});

	it('two copies self-hosted: the files', () => {
		setLocale('de');
		expect(text(two, 'self').join(' ')).toBe('Als beschädigt beiseitegelegte Kopien der Datenbank agent-memory.db.corrupt-1700000000001 engine.db.corrupt-1700000000000 können noch Daten zu dieser Person enthalten. Diese Löschung erreicht sie nicht. Du kannst die Dateien im Datenverzeichnis löschen.');
		setLocale('en');
		expect(text(two, 'self').join(' ')).toBe('Copies of the database that were set aside as damaged agent-memory.db.corrupt-1700000000001 engine.db.corrupt-1700000000000 may still hold data about this person. This erasure does not reach them. You can delete the files in the data directory.');
	});

	it('one copy with its -wal and -shm, self-hosted: the companions with the way, the core names only the copy', () => {
		const withBoth = [copy('engine.db.corrupt-1700000000000', 'engine.db.corrupt-1700000000000-wal', 'engine.db.corrupt-1700000000000-shm')];
		setLocale('de');
		expect(text(withBoth, 'self').join(' ')).toBe('Eine als beschädigt beiseitegelegte Kopie der Datenbank engine.db.corrupt-1700000000000 kann noch Daten zu dieser Person enthalten. Diese Löschung erreicht sie nicht. Du kannst die Datei im Datenverzeichnis löschen, zusammen mit engine.db.corrupt-1700000000000-wal engine.db.corrupt-1700000000000-shm.');
		setLocale('en');
		expect(text(withBoth, 'self').join(' ')).toBe('A copy of the database that was set aside as damaged engine.db.corrupt-1700000000000 may still hold data about this person. This erasure does not reach it. You can delete the file in the data directory, together with engine.db.corrupt-1700000000000-wal engine.db.corrupt-1700000000000-shm.');
		// On lynox Cloud support removes all of them: the sentence stays as it is, DE and EN.
		expect(text(withBoth, 'managed').join(' ')).toBe('A copy of the database that was set aside as damaged engine.db.corrupt-1700000000000 may still hold data about this person. This erasure does not reach it. We remove it if you write to support@lynox.ai.');
		setLocale('de');
		expect(text(withBoth, 'managed').join(' ')).toBe('Eine als beschädigt beiseitegelegte Kopie der Datenbank engine.db.corrupt-1700000000000 kann noch Daten zu dieser Person enthalten. Diese Löschung erreicht sie nicht. Wir entfernen sie, wenn du an support@lynox.ai schreibst.');
	});

	it('two copies, only one with companions, self-hosted: the plural, its companions in the order of the copies', () => {
		const mixed = [copy('agent-memory.db.corrupt-1700000000001'), copy('engine.db.corrupt-1700000000000', 'engine.db.corrupt-1700000000000-wal')];
		setLocale('de');
		expect(text(mixed, 'self').join(' ')).toBe('Als beschädigt beiseitegelegte Kopien der Datenbank agent-memory.db.corrupt-1700000000001 engine.db.corrupt-1700000000000 können noch Daten zu dieser Person enthalten. Diese Löschung erreicht sie nicht. Du kannst die Dateien im Datenverzeichnis löschen, zusammen mit engine.db.corrupt-1700000000000-wal.');
		setLocale('en');
		expect(text(mixed, 'self').join(' ')).toBe('Copies of the database that were set aside as damaged agent-memory.db.corrupt-1700000000001 engine.db.corrupt-1700000000000 may still hold data about this person. This erasure does not reach them. You can delete the files in the data directory, together with engine.db.corrupt-1700000000000-wal.');
		expect(setAsideCopiesNotice(mixed, 'self', t)[1]!.filter(s => 'mark' in s)).toEqual([{ mark: 'engine.db.corrupt-1700000000000-wal' }]);
		// Both ways while the way out is not known: the cloud sentence and the one with the companions.
		expect(text(mixed, 'loading')).toEqual([
			'Copies of the database that were set aside as damaged agent-memory.db.corrupt-1700000000001 engine.db.corrupt-1700000000000 may still hold data about this person. This erasure does not reach them.',
			'We remove them if you write to support@lynox.ai.',
			'You can delete the files in the data directory, together with engine.db.corrupt-1700000000000-wal.',
		]);
		setLocale('de');
		expect(text(mixed, 'loading')).toEqual([
			'Als beschädigt beiseitegelegte Kopien der Datenbank agent-memory.db.corrupt-1700000000001 engine.db.corrupt-1700000000000 können noch Daten zu dieser Person enthalten. Diese Löschung erreicht sie nicht.',
			'Wir entfernen sie, wenn du an support@lynox.ai schreibst.',
			'Du kannst die Dateien im Datenverzeichnis löschen, zusammen mit engine.db.corrupt-1700000000000-wal.',
		]);
	});

	it('names both ways while the way out is loading or could not be read, DE and EN, one and two copies', () => {
		for (const way of ['loading', 'failed'] as const) {
			setLocale('de');
			expect(text(one, way)).toEqual([
				'Eine als beschädigt beiseitegelegte Kopie der Datenbank engine.db.corrupt-1700000000000 kann noch Daten zu dieser Person enthalten. Diese Löschung erreicht sie nicht.',
				'Wir entfernen sie, wenn du an support@lynox.ai schreibst.',
				'Du kannst die Datei im Datenverzeichnis löschen.',
			]);
			expect(text(two, way)).toEqual([
				'Als beschädigt beiseitegelegte Kopien der Datenbank agent-memory.db.corrupt-1700000000001 engine.db.corrupt-1700000000000 können noch Daten zu dieser Person enthalten. Diese Löschung erreicht sie nicht.',
				'Wir entfernen sie, wenn du an support@lynox.ai schreibst.',
				'Du kannst die Dateien im Datenverzeichnis löschen.',
			]);
			setLocale('en');
			expect(text(one, way)).toEqual([
				'A copy of the database that was set aside as damaged engine.db.corrupt-1700000000000 may still hold data about this person. This erasure does not reach it.',
				'We remove it if you write to support@lynox.ai.',
				'You can delete the file in the data directory.',
			]);
			expect(text(two, way)).toEqual([
				'Copies of the database that were set aside as damaged agent-memory.db.corrupt-1700000000001 engine.db.corrupt-1700000000000 may still hold data about this person. This erasure does not reach them.',
				'We remove them if you write to support@lynox.ai.',
				'You can delete the files in the data directory.',
			]);
		}
	});

	it('the data directory could not be listed: says it could not check, per way out, with the name pattern self-hosted', () => {
		setLocale('de');
		const coreDe = 'lynox konnte das Datenverzeichnis nicht lesen und deshalb nicht prüfen, ob es als beschädigt beiseitegelegte Kopien der Datenbank gibt. Falls ja, können sie noch Daten zu dieser Person enthalten, und diese Löschung erreicht sie nicht.';
		expect(text(null, 'managed')).toEqual([coreDe, 'Wir prüfen das und entfernen sie, wenn du an support@lynox.ai schreibst.']);
		expect(text(null, 'self')).toEqual([coreDe, 'Sieh im Datenverzeichnis nach solchen Kopien; sie heissen *.corrupt-*. Du kannst sie löschen.']);
		expect(text(null, 'loading')).toHaveLength(3);
		setLocale('en');
		const coreEn = 'lynox could not read the data directory, so it could not check for copies of the database that were set aside as damaged. If there are any, they may still hold data about this person, and this erasure does not reach them.';
		expect(text(null, 'managed')).toEqual([coreEn, 'We check this and remove them if you write to support@lynox.ai.']);
		expect(text(null, 'self')).toEqual([coreEn, 'Look in the data directory for such copies; their names follow *.corrupt-*. You can delete them.']);
	});

	it('puts each file name and the pattern in its own box and the address as a link', () => {
		setLocale('en');
		const lines = setAsideCopiesNotice(two, 'managed', t);
		expect(lines[0]!.filter(s => 'mark' in s)).toEqual([{ mark: two[0]!.file }, { mark: two[1]!.file }]);
		expect(lines[1]!.filter(s => 'mail' in s)).toEqual([{ mail: 'support@lynox.ai' }]);
		expect(setAsideCopiesNotice(null, 'self', t)[1]!.filter(s => 'mark' in s)).toEqual([{ mark: '*.corrupt-*' }]);
	});
});
