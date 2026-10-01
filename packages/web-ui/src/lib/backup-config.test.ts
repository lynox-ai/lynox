import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { pickBackupConfig, type BackupConfigFields } from './backup-config.js';

describe('pickBackupConfig', () => {
	it('does NOT re-assert backup_schedule, which this view has no control for', () => {
		// The one that matters, and it points the opposite way to the obvious
		// guess. `PUT /api/config` MERGES (`{...existing}`, only an explicit
		// `null` deletes), so leaving a key out never loses it — but sending it
		// back writes the value this view read at mount. There is no control for
		// `backup_schedule` here, so including it would revert a hand edit, or a
		// project `config.json`, made since the view loaded.
		const loaded = { backup_schedule: '0 3 * * *', backup_encrypt: true } as BackupConfigFields;
		expect(Object.keys(pickBackupConfig(loaded))).not.toContain('backup_schedule');
	});

	it('leaves an unset backup_encrypt undefined instead of defaulting it to false', () => {
		// A `?? false` here would survive every presence assertion and still be
		// a behaviour change: the engine derives
		// `encrypt: backup_encrypt ?? !!LYNOX_VAULT_KEY`, so a literal `false`
		// would overwrite that derivation with a decision nobody made.
		const payload = pickBackupConfig({ backup_retention_days: 30 });
		expect(payload.backup_encrypt).toBeUndefined();
		expect(payload.backup_encrypt).not.toBe(false);
	});

	it('leaves an unset retention undefined rather than inventing the engine default', () => {
		// Same shape, the other field: the engine uses `?? 30`, and 30 sent
		// explicitly is indistinguishable from 30 chosen — until the default moves.
		expect(pickBackupConfig({ backup_encrypt: false }).backup_retention_days).toBeUndefined();
	});

	it('carries both owned fields through, including a false that was chosen', () => {
		// Two witnesses, and `false` is the interesting value: a projection using
		// truthiness instead of passing the value would drop it.
		const payload = pickBackupConfig({ backup_encrypt: false, backup_retention_days: 14 });
		expect(payload.backup_encrypt).toBe(false);
		expect(payload.backup_retention_days).toBe(14);
	});

	it('drops the response-only fields that would 400 a strict save', () => {
		const fromGet = {
			backup_encrypt: true,
			backup_retention_days: 30,
			backup_schedule: '0 3 * * *',
			managed: true,
			capabilities: ['x'],
			locks: {},
			bugsink_dsn_configured: true,
		} as BackupConfigFields;
		expect(Object.keys(pickBackupConfig(fromGet)).sort()).toEqual([
			'backup_encrypt',
			'backup_retention_days',
		]);
	});

	it('does not confuse the two keys with each other', () => {
		expect(pickBackupConfig({ backup_encrypt: true, backup_retention_days: 7 })).toEqual({
			backup_encrypt: true,
			backup_retention_days: 7,
		});
	});
});

describe('BackupsView wiring', () => {
	// A SOURCE-TEXT test, with the limitation stated: it reads what the file
	// says, not what runs, so it cannot see whether either call is reached.
	// What it does cover is the one mutant the unit tests above cannot — the
	// view bypassing the projection and sending its raw state — and the
	// package has precedent for this shape (`mail-settings-defaults.test.ts`,
	// `trigger-consent-surface.test.ts`, `knowledge-chip.test.ts` all read a
	// `.svelte` file with `readFileSync`). This package has no DOM or component
	// harness at all — no testing-library, no jsdom environment, not one
	// component test — so wiring can be judged from source text or from a
	// browser run, and only the first of those happens in CI.
	const src = readFileSync(
		new URL('./components/BackupsView.svelte', import.meta.url),
		'utf-8',
	);

	it('reads the file it means to check', () => {
		// Positive control: a null from any assertion below must not be able to
		// come from an empty or wrong file.
		expect(src.length).toBeGreaterThan(2000);
		expect(src).toContain('/config');
	});

	it('routes both config directions through the projection', () => {
		expect(src.match(/pickBackupConfig\(/g) ?? []).toHaveLength(2);
	});

	// ⚠ There is no "the file must not contain pattern X" assertion here, and the
	// first version of this block had one — it matched the explanatory COMMENT
	// three lines above the code it was meant to judge. A text test cannot tell
	// code from comment, and the repair is not a comment-stripping scanner (that
	// road has its own fail-opens); it is to assert something a comment cannot
	// satisfy. A COUNT of call sites is that: dropping either call makes it 1,
	// adding a raw-object save path does not make it 2.

	it('has no control that writes backup_schedule', () => {
		expect(src).not.toContain('backup_schedule');
		expect(src).not.toContain('backup-schedule');
	});
});
