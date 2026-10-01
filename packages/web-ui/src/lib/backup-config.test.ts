import { describe, it, expect } from 'vitest';
import { pickBackupConfig, type BackupConfigFields } from './backup-config.js';

describe('pickBackupConfig', () => {
	it('carries a hand-set backup_schedule through, so a save does not wipe it', () => {
		// The one that matters. This view has no control for `backup_schedule`
		// (see the module docblock), and the PUT sends a complete object for
		// these three keys — so if the projection drops the field, every save
		// from the Backups view deletes a value the user set by hand.
		const loaded: BackupConfigFields = { backup_schedule: '0 3 * * *' };
		expect(pickBackupConfig(loaded).backup_schedule).toBe('0 3 * * *');
	});

	it('keeps the schedule AND the edited field in one payload', () => {
		// Two witnesses: a round-tripped value the UI cannot edit, and a value
		// the UI did edit. A projection that kept only one of them would pass a
		// single-field assertion.
		const payload = pickBackupConfig({
			backup_schedule: '0 3 * * 1',
			backup_retention_days: 14,
		});
		expect(payload.backup_schedule).toBe('0 3 * * 1');
		expect(payload.backup_retention_days).toBe(14);
	});

	it('drops the response-only fields that would 400 a strict save', () => {
		const fromGet = {
			backup_schedule: '0 3 * * *',
			backup_encrypt: true,
			backup_retention_days: 30,
			managed: true,
			capabilities: ['x'],
			locks: {},
			bugsink_dsn_configured: true,
		} as BackupConfigFields;
		expect(Object.keys(pickBackupConfig(fromGet)).sort()).toEqual([
			'backup_encrypt',
			'backup_retention_days',
			'backup_schedule',
		]);
	});

	it('leaves an unset schedule unset rather than inventing a value', () => {
		// The negative direction: nothing to preserve means nothing is sent.
		// `JSON.stringify` omits an `undefined` value, so an unset key stays
		// unset on the server — this asserts the projection does not turn it
		// into `''` or a default cron line.
		expect(pickBackupConfig({ backup_encrypt: false }).backup_schedule).toBeUndefined();
	});

	it('does not confuse the three keys with each other', () => {
		// A projection that assigned the wrong source field to a target would
		// satisfy every assertion above that only checks presence.
		expect(
			pickBackupConfig({
				backup_schedule: 'S',
				backup_encrypt: true,
				backup_retention_days: 7,
			}),
		).toEqual({ backup_schedule: 'S', backup_encrypt: true, backup_retention_days: 7 });
	});
});
