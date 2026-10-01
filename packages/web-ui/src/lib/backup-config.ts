/**
 * The three backup keys the Backups view reads and writes, plus the projection
 * that keeps a save from touching anything else.
 *
 * `GET /api/config` returns the user config plus response-only fields
 * (`managed`, `capabilities`, `locks`, `bugsink_dsn_configured`,
 * `*_configured`). The PUT schema is `.strict()` (PRD-IA-V2 P1-PR-A2), so
 * re-sending one of those 400s the whole save — which is why both directions
 * go through the same projection rather than `JSON.stringify(config)`.
 *
 * ⚠ `backup_schedule` has NO control in this view any more: the select was
 * removed because nothing in the engine reads the value, and a control that
 * writes a key nobody reads is a promise the product does not keep. The field
 * stays in the projection anyway, and that is load-bearing — the save sends a
 * COMPLETE object for these three keys, so dropping it here would make every
 * save from this view silently WIPE a `backup_schedule` the user set by hand
 * in the config file (which is the only way to set it, and the docs say so).
 * It is safe to drop only once the PUT is a partial merge, or once the key
 * itself is gone from the config schema. `backup-config.test.ts` fails if
 * someone removes it before then.
 */
export interface BackupConfigFields {
	backup_schedule?: string | undefined;
	backup_encrypt?: boolean | undefined;
	backup_retention_days?: number | undefined;
}

/** Project an arbitrary config object down to exactly the three backup keys. */
export function pickBackupConfig(src: BackupConfigFields): BackupConfigFields {
	return {
		backup_schedule: src.backup_schedule,
		backup_encrypt: src.backup_encrypt,
		backup_retention_days: src.backup_retention_days,
	};
}
