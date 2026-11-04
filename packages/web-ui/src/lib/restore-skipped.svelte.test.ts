import { describe, it, expect, afterEach } from 'vitest';
import { restoreSkippedLines } from './backup-config.js';
import { t, tf, setLocale, getLocale } from './i18n.svelte.js';

describe('restoreSkippedLines: the notice after a restore that left entries out (U-132)', () => {
	const before = getLocale();
	afterEach(() => setLocale(before));
	const paths = (n: number): string[] => Array.from({ length: n }, (_, i) => `memory/old-${String(i + 1)}.md`);

	it('says nothing when nothing was left out', () => {
		expect(restoreSkippedLines([], '/b', false, t, tf)).toEqual([]);
	});

	it('one entry, unencrypted: the singular, and the folder to copy it from', () => {
		setLocale('de');
		expect(restoreSkippedLines(paths(1), '/data/backups/b1', false, t, tf)).toEqual([
			'Backup wiederhergestellt, aber einen Eintrag hat lynox nicht zurückgeschrieben, weil sein Name zu keinem heutigen Bereich passt: memory/old-1.md. Er bleibt in diesem Backup, solange du es behältst.',
			'Brauchst du ihn, kopier ihn von Hand aus dem Backup-Ordner: /data/backups/b1',
		]);
		setLocale('en');
		expect(restoreSkippedLines(paths(1), '/data/backups/b1', false, t, tf)).toEqual([
			'Backup restored, but lynox did not write back one entry because its name matches no current area: memory/old-1.md. It stays in this backup for as long as you keep it.',
			'If you need it, copy it by hand from the backup folder: /data/backups/b1',
		]);
	});

	it('more than five, encrypted: the first five, how many more, and no way it does not have', () => {
		setLocale('de');
		expect(restoreSkippedLines(paths(7), '/data/backups/b1', true, t, tf)).toEqual([
			'Backup wiederhergestellt, aber 7 Einträge hat lynox nicht zurückgeschrieben, weil ihr Name zu keinem heutigen Bereich passt: memory/old-1.md, memory/old-2.md, memory/old-3.md, memory/old-4.md, memory/old-5.md und 2 weitere. Sie bleiben in diesem Backup, solange du es behältst.',
			'Das Backup ist verschlüsselt; einzeln herausholen lassen sich diese Einträge heute nicht.',
		]);
		setLocale('en');
		expect(restoreSkippedLines(paths(7), '/data/backups/b1', true, t, tf)).toEqual([
			'Backup restored, but lynox did not write back 7 entries because their names match no current area: memory/old-1.md, memory/old-2.md, memory/old-3.md, memory/old-4.md, memory/old-5.md and 2 more. They stay in this backup for as long as you keep it.',
			'The backup is encrypted; these entries cannot be taken out one by one today.',
		]);
	});

	it('exactly five names all of them and says no "more"; the encrypted singular has its own sentence', () => {
		setLocale('en');
		const [first] = restoreSkippedLines(paths(5), '/b', false, t, tf);
		expect(first).toContain('memory/old-5.md. They stay');
		expect(first).not.toContain('more');
		expect(restoreSkippedLines(paths(1), '/b', true, t, tf)[1]).toBe('The backup is encrypted; this entry cannot be taken out on its own today.');
		expect(restoreSkippedLines(paths(2), '/b', false, t, tf)[1]).toBe('If you need one of them, copy it by hand from the backup folder: /b');
	});

	it('names no folder it does not know', () => {
		expect(restoreSkippedLines(paths(2), null, false, t, tf)).toHaveLength(1);
	});
});
