import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { pickBackupConfig, type BackupConfigFields, requestRestore } from './backup-config.js';

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
		// The save projects here; the read goes through fetchBackupConfig, which projects
		// (witnessed below: a response-only key does not survive the read).
		expect(src.match(/pickBackupConfig\(/g) ?? []).toHaveLength(1);
		expect(src.match(/fetchBackupConfig\(/g) ?? []).toHaveLength(1);
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

describe('fetchBackupConfig', () => {
	afterEach(() => { vi.unstubAllGlobals(); });

	it('resolves null, not defaults, when the request fails or is refused', async () => {
		const { fetchBackupConfig } = await import('./backup-config.js');
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
		await expect(fetchBackupConfig('/api')).resolves.toBeNull();
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 500 })));
		await expect(fetchBackupConfig('/api')).resolves.toBeNull();
	});

	it('returns only the two backup keys when the read works', async () => {
		const { fetchBackupConfig } = await import('./backup-config.js');
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ backup_retention_days: 7, backup_encrypt: true, managed: true }), { status: 200 })));
		await expect(fetchBackupConfig('/api')).resolves.toEqual({ backup_retention_days: 7, backup_encrypt: true });
	});
});

describe('requestRestore', () => {
	afterEach(() => { vi.unstubAllGlobals(); });

	const reply = (body: unknown, status: number) => vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));

	it('sends no body until the user said yes, and turns the refusal into a question', async () => {
		const fetchMock = reply({ success: false, code: 'unverified_backup', error: 'no proof of origin' }, 409);
		vi.stubGlobal('fetch', fetchMock);
		expect(await requestRestore('/api', 'b 1', false)).toEqual({ kind: 'ask', reason: 'no proof of origin', mismatch: false });
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('/api/backups/b%201/restore');
		expect(init.body).toBeUndefined();
	});

	it('marks a signature that does not match apart from a missing one', async () => {
		vi.stubGlobal('fetch', reply({ success: false, code: 'unverified_backup', provenance: 'mismatch', error: 'changed' }, 409));
		expect(await requestRestore('/api', 'b1', false)).toEqual({ kind: 'ask', reason: 'changed', mismatch: true });
	});

	it('sends allow_unverified: true once the user said yes, and does not ask again', async () => {
		const fetchMock = reply({ success: false, code: 'unverified_backup', error: 'still refused' }, 409);
		vi.stubGlobal('fetch', fetchMock);
		expect(await requestRestore('/api', 'b1', true)).toEqual({ kind: 'failed', error: 'still refused' });
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(JSON.parse(String(init.body))).toEqual({ allow_unverified: true });
	});

	it('reports a restore and any other refusal as they are', async () => {
		vi.stubGlobal('fetch', reply({ success: true }, 200));
		expect(await requestRestore('/api', 'b1', false)).toEqual({ kind: 'restored' });
		vi.stubGlobal('fetch', reply({ success: false, error: 'verification failed' }, 500));
		expect(await requestRestore('/api', 'b1', false)).toEqual({ kind: 'failed', error: 'verification failed' });
	});
});

describe('BackupsView restore wiring', () => {
	const src = readFileSync(new URL('./components/BackupsView.svelte', import.meta.url), 'utf-8');

	it('restores only through requestRestore, and its second yes passes true', () => {
		expect(src.match(/requestRestore\(/g) ?? []).toHaveLength(1);
		expect(src.match(/restoreBackup\(backup\.backup_id, true\)/g) ?? []).toHaveLength(1);
		expect(src).not.toContain('/restore`');
		// A wrong signature gets its own warning AND its own button; a missing one the mild pair.
		expect(src.match(/unverified\.mismatch \? 'backups\.restore_(mismatch|anyway)'/g) ?? []).toHaveLength(2);
	});
});
