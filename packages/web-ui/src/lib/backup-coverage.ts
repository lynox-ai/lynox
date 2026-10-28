/**
 * What the backup list and the migration's done step say about the workspace files (PRD
 * shell-sidecar-activation D7, walkers 1 and 2; ux U-030, U-046).
 *
 * In shell sidecar mode the engine leaves the workspace out of a backup and records that in the
 * manifest's `coverage`; a migration export leaves it out and says so in its `done` event. Without
 * a notice the owner sees only a smaller file count, or a migration that "completed successfully".
 *
 * The list may only trust `coverage` on a manifest whose origin the engine verified: `coverage` is
 * covered by the manifest MAC, so on an unsigned or foreign manifest its absence proves nothing,
 * and stripping it would turn a backup without the workspace into one that looks complete. Those
 * backups say the coverage cannot be confirmed instead of saying nothing.
 */

/** As `GET /api/backups` delivers each backup (`BackupListEntry` in the engine's `backup.ts`). */
export interface BackupCoverageFields {
	provenance?: unknown;
	coverage?: { workspace?: unknown } | null | undefined;
}

export interface CoverageNotice {
	/** i18n key of the badge next to "encrypted". */
	badge: string;
	/** i18n keys of the plain-text line under the entry, in order. */
	lines: string[];
	/** `warning` for a backup whose proof of origin does not match the key. */
	tone: 'muted' | 'warning';
}

/** The record the engine writes when it left the workspace out (`OMITTED_SIDECAR`). */
export const OMITTED_SIDECAR = 'omitted-sidecar';

/**
 * The notice for one backup, or `null` for a verified backup that covers everything. Anything
 * the engine did not call `verified` counts as unverified, including a missing `provenance`, so
 * an engine that does not deliver it never makes a backup look complete.
 */
export function backupCoverageNotice(backup: BackupCoverageFields, managed: boolean): CoverageNotice | null {
	const provenance = backup.provenance;
	if (provenance === 'verified') {
		if (backup.coverage?.workspace !== OMITTED_SIDECAR) return null;
		return {
			badge: 'backups.coverage_omitted_badge',
			lines: [managed ? 'backups.coverage_omitted_managed' : 'backups.coverage_omitted_self'],
			tone: 'muted',
		};
	}
	if (provenance === 'mismatch') {
		return {
			badge: 'backups.coverage_mismatch_badge',
			lines: ['backups.coverage_mismatch', 'backups.coverage_mismatch_advice'],
			tone: 'warning',
		};
	}
	// `none`: the engine has a vault key, so a new backup is signed and settles the question.
	// `no-key` (or anything else): a new backup would be unsigned too, so the advice is left out.
	return {
		badge: 'backups.coverage_unclear_badge',
		lines: provenance === 'none' ? ['backups.coverage_unclear', 'backups.coverage_unclear_new_backup'] : ['backups.coverage_unclear'],
		tone: 'muted',
	};
}

/** What the migration's done step says, from its `done` event. `null` when the workspace went along. */
export function migrationWorkspaceNotice(done: { workspace?: unknown }, managed: boolean): { description: string; line: string; toast: string } | null {
	if (done.workspace !== OMITTED_SIDECAR) return null;
	return {
		description: 'migration.success_desc_without_workspace',
		line: managed ? 'migration.workspace_omitted_managed' : 'migration.workspace_omitted_self',
		toast: 'migration.success_without_workspace',
	};
}
