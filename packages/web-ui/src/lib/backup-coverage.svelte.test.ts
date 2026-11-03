import { describe, it, expect, afterEach } from 'vitest';
import { backupCoverageNotice, migrationWorkspaceNotice, OMITTED_SIDECAR } from './backup-coverage.js';
import { t, setLocale, getLocale } from './i18n.svelte.js';

const OMITTED = { workspace: OMITTED_SIDECAR };

describe('backupCoverageNotice: what the backup list says about the workspace (row 987, U-030)', () => {
	it('says nothing for a verified backup without a record: it covers everything', () => {
		expect(backupCoverageNotice({ provenance: 'verified' }, false)).toBeNull();
		expect(backupCoverageNotice({ provenance: 'verified', coverage: null }, true)).toBeNull();
	});

	it('names the omission on a verified backup with the record, with the way out of the tier', () => {
		expect(backupCoverageNotice({ provenance: 'verified', coverage: OMITTED }, true)).toEqual({
			badge: 'backups.coverage_omitted_badge', lines: ['backups.coverage_omitted_managed'], tone: 'muted',
		});
		expect(backupCoverageNotice({ provenance: 'verified', coverage: OMITTED }, false)).toEqual({
			badge: 'backups.coverage_omitted_badge', lines: ['backups.coverage_omitted_self'], tone: 'muted',
		});
	});

	it('an unsigned backup is unclear whatever its coverage says, and only a keyed engine advises a new backup', () => {
		const unclear = { badge: 'backups.coverage_unclear_badge', lines: ['backups.coverage_unclear', 'backups.coverage_unclear_new_backup'], tone: 'muted' };
		// `coverage` on an unsigned manifest is whatever its writer put there: absent or present, same notice.
		expect(backupCoverageNotice({ provenance: 'none' }, false)).toEqual(unclear);
		expect(backupCoverageNotice({ provenance: 'none', coverage: OMITTED }, true)).toEqual(unclear);
		// Without a vault key a new backup would be unsigned too.
		expect(backupCoverageNotice({ provenance: 'no-key' }, false)).toEqual({ ...unclear, lines: ['backups.coverage_unclear'] });
	});

	it('a missing or unknown provenance is unclear, never complete', () => {
		expect(backupCoverageNotice({}, false)?.badge).toBe('backups.coverage_unclear_badge');
		expect(backupCoverageNotice({ provenance: 'Verified' }, false)?.badge).toBe('backups.coverage_unclear_badge');
	});

	it('a mismatch warns, whatever the coverage says', () => {
		const mismatch = { badge: 'backups.coverage_mismatch_badge', lines: ['backups.coverage_mismatch', 'backups.coverage_mismatch_advice'], tone: 'warning' };
		expect(backupCoverageNotice({ provenance: 'mismatch' }, false)).toEqual(mismatch);
		expect(backupCoverageNotice({ provenance: 'mismatch', coverage: OMITTED }, true)).toEqual(mismatch);
	});
});

describe('migrationWorkspaceNotice: the done step of a migration that left the workspace out (U-046)', () => {
	it('is null when the workspace went along', () => {
		expect(migrationWorkspaceNotice({}, true)).toBeNull();
		expect(migrationWorkspaceNotice({ workspace: 'something-else' }, false)).toBeNull();
	});

	it('replaces the description and the toast, and names the way out of the tier', () => {
		expect(migrationWorkspaceNotice({ workspace: OMITTED_SIDECAR }, true)).toEqual({
			description: 'migration.success_desc_without_workspace', line: 'migration.workspace_omitted_managed', toast: 'migration.success_without_workspace',
		});
		expect(migrationWorkspaceNotice({ workspace: OMITTED_SIDECAR }, false)?.line).toBe('migration.workspace_omitted_self');
	});
});

describe('the texts, as ux wrote them', () => {
	const before = getLocale();
	afterEach(() => setLocale(before));
	const both = (key: string): { de: string; en: string } => {
		setLocale('de'); const de = t(key);
		setLocale('en'); const en = t(key);
		return { de, en };
	};

	it('U-030, the backup list', () => {
		expect(both('backups.coverage_omitted_badge')).toEqual({ de: 'ohne Arbeitsbereich', en: 'without workspace' });
		expect(both('backups.coverage_omitted_managed')).toEqual({
			de: 'Die Dateien des Arbeitsbereichs sind nicht in diesem Backup. lynox sichert sie getrennt; zum Wiederherstellen schreib an support@lynox.ai.',
			en: 'The workspace files are not in this backup. lynox backs them up separately; to restore them, write to support@lynox.ai.',
		});
		expect(both('backups.coverage_omitted_self')).toEqual({
			de: 'Die Dateien des Arbeitsbereichs sind nicht in diesem Backup. Sichere sie dort, wo du sie verwaltest.',
			en: 'The workspace files are not in this backup. Back them up where you manage them.',
		});
		expect(both('backups.coverage_unclear_badge')).toEqual({ de: 'Arbeitsbereich unklar', en: 'workspace unclear' });
		expect(both('backups.coverage_unclear')).toEqual({
			de: 'Ob die Dateien des Arbeitsbereichs in diesem Backup sind, lässt sich nicht belegen.',
			en: 'Whether the workspace files are in this backup cannot be confirmed.',
		});
		expect(both('backups.coverage_unclear_new_backup')).toEqual({ de: 'Willst du sicher sein, mach ein neues Backup.', en: 'To be sure, make a new backup.' });
		expect(both('backups.coverage_mismatch_badge')).toEqual({ de: 'passt nicht zum Schlüssel', en: 'does not match your key' });
		expect(both('backups.coverage_mismatch_advice')).toEqual({ de: 'Stell es nur wieder her, wenn du weisst, woher es stammt.', en: 'Only restore it if you know where it came from.' });
	});

	it('the list\'s mismatch sentence is the first sentence of the restore refusal, word for word', () => {
		// ux: "erster Satz von backups.restore_mismatch wörtlich". Kept equal here, so a change to one
		// of them cannot drift from the other.
		for (const locale of ['de', 'en'] as const) {
			setLocale(locale);
			const sentence = t('backups.coverage_mismatch');
			expect(sentence.endsWith('.')).toBe(true);
			expect(t('backups.restore_mismatch').startsWith(`${sentence} `)).toBe(true);
		}
	});

	it('U-046, the migration done step', () => {
		expect(both('migration.success_without_workspace')).toEqual({ de: 'Migration abgeschlossen, ohne die Dateien des Arbeitsbereichs.', en: 'Migration complete, without the workspace files.' });
		expect(both('migration.success_desc_without_workspace')).toEqual({
			de: 'Deine Daten sind jetzt auf deiner Managed-Instanz verfügbar, ausser den Dateien des Arbeitsbereichs.',
			en: 'Your data is now available on your managed instance, except for the workspace files.',
		});
		expect(both('migration.workspace_omitted_managed')).toEqual({
			de: 'Diese Dateien hat die Migration nicht übertragen. Für eine Kopie auf die neue Instanz schreib an support@lynox.ai.',
			en: 'The migration did not transfer these files. To have them copied to the new instance, write to support@lynox.ai.',
		});
		expect(both('migration.workspace_omitted_self')).toEqual({
			de: 'Diese Dateien hat die Migration nicht übertragen. Übertrage sie dort, wo du sie verwaltest.',
			en: 'The migration did not transfer these files. Move them where you manage them.',
		});
	});
});
