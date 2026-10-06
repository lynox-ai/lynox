/**
 * The two backup keys this view actually controls, and the projection that
 * keeps a save from touching anything else.
 *
 * `GET /api/config` returns the user config plus response-only fields
 * (`managed`, `capabilities`, `locks`, `bugsink_dsn_configured`,
 * `*_configured`). The PUT schema is `.strict()` (`src/types/schemas.ts`
 * ends `}).strict()`), so re-sending one of those 400s the whole save —
 * which is why both directions go through this projection rather than
 * `JSON.stringify(config)`.
 *
 * ⚠ `backup_schedule` is deliberately NOT in here, and the reason is the
 * PUT's merge semantics. `src/server/http-api.ts` builds `{...existing}`
 * and overwrites only the keys the request carries ("Merge with existing
 * config so partial updates don't lose other fields"); only an explicit
 * `null` deletes. So a key left out is simply not touched — but a key sent
 * back is **re-asserted at the value this view read when it mounted**. The
 * view has no control for `backup_schedule` (the select was removed
 * because nothing in the engine reads the value), so including it would
 * mean every save silently reverts a `backup_schedule` edited in the
 * config file, or set by a project `config.json`, since this view loaded.
 * A view may re-assert what it owns; it must not re-assert what it only
 * happened to read.
 *
 * ⚠ And no `??` defaults here. `undefined` must stay `undefined`: the
 * engine derives `encrypt: backup_encrypt ?? !!LYNOX_VAULT_KEY`
 * (`src/core/engine.ts`), so sending a literal `false` for an unset
 * `backup_encrypt` would overwrite that derivation with a decision the
 * user never made. `JSON.stringify` drops an `undefined` value, which is
 * exactly the wanted behaviour under a merging PUT.
 */
export interface BackupConfigFields {
	backup_encrypt?: boolean | undefined;
	backup_retention_days?: number | undefined;
}

/**
 * Project an arbitrary config object down to exactly the keys this view owns.
 * Deliberately not generic and deliberately without defaults — see above.
 */
export function pickBackupConfig(src: BackupConfigFields): BackupConfigFields {
	return {
		backup_encrypt: src.backup_encrypt,
		backup_retention_days: src.backup_retention_days,
	};
}

/**
 * Read the backup settings, or `null` when they could not be read. Never rejects. A view must not
 * fall back to defaults on `null`: an editable form showing defaults would let a save overwrite the
 * real settings with values the user never saw.
 */
export async function fetchBackupConfig(apiBase: string): Promise<BackupConfigFields | null> {
	try {
		const res = await fetch(`${apiBase}/config`);
		if (!res.ok) return null;
		return pickBackupConfig((await res.json()) as BackupConfigFields);
	} catch {
		return null;
	}
}
