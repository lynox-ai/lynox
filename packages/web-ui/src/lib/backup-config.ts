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
 * What a save from a stored "never delete" (`backup_retention_days: 0`) asks for. 0 can no longer
 * be chosen: the engine refuses a change to 0, but a 0 already stored stays until the user picks a
 * number of days. So the view shows that setting as it is, with an empty field for days beside it.
 * `keep`: the field is empty, and the save re-sends the stored 0 unchanged (the engine accepts
 * that, so saving another setting still works). `confirm`: a valid number of days, which the user
 * must confirm, because older backups are deleted on the next run. `invalid`: anything else.
 * `badInput` is the field's own verdict: a number field holding text it cannot read ("30 Tage")
 * reports its value as empty, and that must not read as "no days entered".
 */
export type RetentionChange = { kind: 'keep' } | { kind: 'confirm'; days: number } | { kind: 'invalid' };

export function retentionChangeFromNever(input: unknown, badInput = false): RetentionChange {
	if (badInput) return { kind: 'invalid' };
	if (input === null || input === undefined || input === '') return { kind: 'keep' };
	const days = typeof input === 'number' ? input : Number(input);
	if (!Number.isInteger(days) || days < 1 || days > 365) return { kind: 'invalid' };
	return { kind: 'confirm', days };
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

/**
 * What a restore request came to. `ask`: the engine refused because the backup's origin is not
 * shown, and the view must ask before it sends the request again with `allowUnverified`.
 * `mismatch`: a signature is there and does not match, which is a stronger warning than none.
 */
export type RestoreOutcome =
	/** `skipped`: entries the restore did not write (archive paths); `backupPath`: the backup's folder on the server. */
	| { kind: 'restored'; skipped: string[]; backupPath: string | null }
	| { kind: 'ask'; reason: string; mismatch: boolean }
	/** Another restore is running on the engine (`restore_in_progress`): this one was not started. */
	| { kind: 'running' }
	| { kind: 'failed'; error: string | undefined };

/**
 * Ask the engine to restore a backup. `allowUnverified` is the user's explicit yes to a backup
 * without proof of origin; only then does the request carry `allow_unverified: true`. Rejects
 * only when the request itself fails.
 */
export async function requestRestore(apiBase: string, backupId: string, allowUnverified: boolean): Promise<RestoreOutcome> {
	const res = await fetch(`${apiBase}/backups/${encodeURIComponent(backupId)}/restore`, {
		method: 'POST',
		...(allowUnverified ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ allow_unverified: true }) } : {}),
	});
	const data = (await res.json()) as { success?: boolean; error?: string; code?: string; provenance?: string; skipped?: unknown; backup_path?: unknown };
	if (data.success === true) {
		const skipped = Array.isArray(data.skipped) ? data.skipped.filter((p): p is string => typeof p === 'string') : [];
		return { kind: 'restored', skipped, backupPath: typeof data.backup_path === 'string' ? data.backup_path : null };
	}
	if (data.code === 'unverified_backup' && !allowUnverified) return { kind: 'ask', reason: data.error ?? '', mismatch: data.provenance === 'mismatch' };
	if (data.code === 'restore_in_progress') return { kind: 'running' };
	return { kind: 'failed', error: data.error };
}

/** How many skipped paths the notice names before it says how many more there are. */
export const SKIPPED_SHOWN = 5;

/**
 * The lines of the notice after a restore that left entries out (U-132): what was not written and
 * why, then where the owner can still get one. Only a self-hosted engine restores (the route refuses
 * on a managed instance), so the way out is the backup folder, or, for an encrypted backup, the
 * honest "not one by one today". `tf`/`t` are passed in so the function stays pure.
 */
export function restoreSkippedLines(
	skipped: readonly string[],
	backupPath: string | null,
	encrypted: boolean,
	t: (key: string) => string,
	tf: (key: string, vars: Record<string, string>) => string,
): string[] {
	const n = skipped.length;
	if (n === 0) return [];
	const one = n === 1;
	const more = n - SKIPPED_SHOWN;
	const list = skipped.slice(0, SKIPPED_SHOWN).join(', ') + (more > 0 ? ` ${tf('backups.restore_skipped_more', { more: String(more) })}` : '');
	const lines = [tf(one ? 'backups.restore_skipped_one' : 'backups.restore_skipped', { n: String(n), list })];
	if (encrypted) lines.push(t(one ? 'backups.restore_skipped_self_encrypted_one' : 'backups.restore_skipped_self_encrypted'));
	else if (backupPath !== null) lines.push(tf(one ? 'backups.restore_skipped_self_one' : 'backups.restore_skipped_self', { path: backupPath }));
	return lines;
}
