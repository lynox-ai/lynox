import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MIGRATION_START_CODES, MIGRATION_STOP_RETRY } from '../../../../src/core/migration-stop.js';
import { getLocale, setLocale, t } from './i18n.svelte.js';
import { MIGRATION_BROWSER_CODES, migrationErrorView, migrationNotStarted, migrationStopKey } from './migration-error-text.js';

/**
 * Every code a migration stop can reach the wizard with has its sentence in both languages, and the
 * retry each case gives is the one its wording was written for. The table below is that wording's
 * case list: a code added on either side without a row here, or without a sentence, fails.
 *
 * `state`: from the target's session when the stop came (`later` while it may hold one, `now` once
 * it does not, `check` once the restore request went out).
 */
const CASES: Record<string, 'none' | 'check' | 'later' | 'now' | 'state'> = {
	// Start checks: the migration did not start, and trying the same again changes nothing.
	start_missing_input: 'none',
	start_not_https: 'none',
	start_invalid_url: 'none',
	start_not_public: 'none',
	start_managed: 'none',
	// Preparing the data.
	vault_key_missing: 'none',
	data_too_large: 'none',
	folder_too_large: 'none',
	export_failed: 'state',
	// Setting up the connection: not reachable, not sent, no lynox instance that takes a migration.
	handshake_unreachable: 'state',
	handshake_blocked: 'none',
	handshake_not_lynox: 'none',
	target_session_active: 'state',
	// The target refusing: as it is (4xx), or failing or busy (5xx, 429).
	handshake_refused: 'none',
	handshake_unavailable: 'state',
	handshake_unverified: 'none',
	handshake_incomplete: 'state',
	// Before the data is sent.
	manifest_unreachable: 'state',
	manifest_refused: 'none',
	manifest_unavailable: 'state',
	// The parts of the data: the target keeps its session.
	chunk_unreachable: 'later',
	chunk_refused: 'later',
	// The deadline: before the restore was asked for, and while the target restores.
	transfer_out_of_time: 'later',
	restore_out_of_time: 'check',
	// The restore.
	restore_unreadable: 'check',
	restore_blocked: 'later',
	restore_failed: 'check',
	restore_refused: 'later',
	restore_failed_on_target: 'check',
	// Anything else.
	unknown: 'state',
};

/** The wizard's own codes and their retry. */
const BROWSER_CASES: Record<string, 'none' | 'check' | 'later' | 'now' | 'state'> = {
	browser_invalid_url: 'none',
	connection_lost: 'check',
	cancelled: 'state',
	connection_failed: 'now',
	start_refused: 'now',
};

// vitest runs from the repository's root (packages/web-ui/vitest.config.ts switches to it).
const ROUTE = readFileSync(resolve('src/server/http-api.ts'), 'utf8');
const CRYPTO = readFileSync(resolve('src/core/migration-crypto.ts'), 'utf8');

function inBoth(key: string): void {
	const before = getLocale();
	try {
		for (const lang of ['de', 'en'] as const) {
			setLocale(lang);
			expect(t(key), `${key} (${lang})`).not.toBe(key);
			expect(t(key).trim(), `${key} (${lang})`).not.toBe('');
		}
	} finally {
		setLocale(before);
	}
}

describe('the codes of a migration stop', () => {
	it('are exactly the case list, each with the retry its wording was written for', () => {
		expect(Object.keys(MIGRATION_STOP_RETRY).sort()).toEqual(Object.keys(CASES).sort());
		for (const [code, retry] of Object.entries(MIGRATION_STOP_RETRY)) expect(retry, code).toBe(CASES[code]);
		expect(Object.keys(MIGRATION_BROWSER_CODES).sort()).toEqual(Object.keys(BROWSER_CASES).sort());
		for (const [code, retry] of Object.entries(MIGRATION_BROWSER_CODES)) expect(retry, code).toBe(BROWSER_CASES[code]);
	});

	it('each have a sentence in German and in English, the engine\'s and the wizard\'s', () => {
		for (const code of [...Object.keys(MIGRATION_STOP_RETRY), ...Object.keys(MIGRATION_BROWSER_CODES)]) {
			if (code === 'start_refused') inBoth('migration.error_not_started');
			else inBoth(migrationStopKey(code));
		}
		for (const key of ['migration.stop.unknown_nothing_sent', 'migration.stop.data_too_large_parts', 'migration.stop.data_too_large_size', 'migration.target_says', 'migration.message', 'migration.part', 'migration.part_kind', 'migration.duration_minutes', 'migration.duration_seconds']) inBoth(key);
	});

	it('name the start codes the route sends as the ones that say the migration did not start', () => {
		const sent = [...ROUTE.matchAll(/errorResponse\(res, 400, '[^']*', '(start_\w+)'\)/g)].map((m) => m[1]);
		expect(ROUTE).toMatch(/denyOnManagedInstance\(res, 'migration export', 'start_managed'\)/);
		expect([...sent, 'start_managed'].sort()).toEqual([...MIGRATION_START_CODES].sort());
		for (const code of MIGRATION_START_CODES) expect(migrationNotStarted(code), code).toBe(true);
		expect(migrationNotStarted('browser_invalid_url')).toBe(true);
		expect(migrationNotStarted('handshake_refused')).toBe(false);
	});

	it('give every kind of part a word in both languages', () => {
		const list = /MIGRATION_CHUNK_TYPES = \[([^\]]*)\]/.exec(CRYPTO)?.[1] ?? '';
		const kinds = [...list.matchAll(/'(\w+)'/g)].map((m) => m[1] ?? '');
		expect(kinds.length).toBeGreaterThan(5);
		for (const kind of kinds) inBoth(`migration.kind.${kind}`);
	});

	it('say an unknown code as a reason lynox could not read, nothing sent only where that is certain', () => {
		expect(migrationErrorView('no_such_code', { nothingSent: true }).segments).toEqual([{ text: t('migration.stop.unknown') }]);
		expect(migrationErrorView('unknown', { nothingSent: true }).segments).toEqual([{ text: t('migration.stop.unknown_nothing_sent') }]);
		expect(migrationErrorView('unknown', {}).segments).toEqual([{ text: t('migration.stop.unknown') }]);
	});
});

describe('the sentence of a migration stop', () => {
	const plain = (code: string, params: Record<string, string | number | boolean>): string =>
		migrationErrorView(code, params).segments.map((s) => ('text' in s ? s.text : `[${s.value}]`)).join('');

	it('names a part by its number out of all, with its kind only for a kind it knows', () => {
		const before = getLocale();
		try {
			setLocale('de');
			expect(plain('chunk_unreachable', { part: 3, parts: 7, kind: 'sqlite_db' })).toBe('Bei Teil 3 von 7 der Daten (Datenbank) ist die Übertragung zur Zielinstanz abgebrochen. lynox hat gestoppt. Die Zielinstanz hat noch nichts wiederhergestellt.');
			expect(plain('chunk_refused', { part: 3, parts: 7, kind: 'history.db' })).toBe('Die Zielinstanz hat Teil 3 von 7 der Daten abgelehnt. lynox hat gestoppt. Die Zielinstanz hat noch nichts wiederhergestellt.');
			setLocale('en');
			expect(plain('chunk_unreachable', { part: 3, parts: 7, kind: 'memory' })).toBe('The transfer to the target instance broke off at part 3 of 7 of the data (memory). lynox stopped. The target instance has not restored anything yet.');
		} finally {
			setLocale(before);
		}
	});

	it('says sizes and durations readably, in the UI\'s language', () => {
		const before = getLocale();
		try {
			setLocale('de');
			expect(plain('data_too_large', { parts: 9, maxParts: 8, bytes: 600 * 1024 * 1024, maxBytes: 500 * 1024 * 1024 })).toBe('Die Daten dieser Instanz passen nicht in eine Migration: sie brauchen 9 Teile, eine Migration trägt höchstens 8 und sie sind 600 MiB gross, eine Migration trägt höchstens 500 MiB. Es wurde nichts übertragen, und die Daten hier sind unverändert. Eine Migration kann nicht nur einen Teil davon übertragen. Schreib an support@lynox.ai und leg diese Meldung bei.');
			expect(plain('transfer_out_of_time', { durationMs: 15 * 60_000 })).toContain('länger als 15 Minuten');
			expect(plain('folder_too_large', { dir: 'apis', entries: 20000, bytes: 64 * 1024 * 1024 })).toBe(`Der Ordner „[apis]“ ist zu gross für eine Migration. Möglich sind höchstens ${(20000).toLocaleString('de-CH')} Einträge und 64 MiB. lynox überträgt keine halbe Kopie davon. Es wurde nichts übertragen. Verkleinere den Ordner oder schreib an support@lynox.ai.`);
			setLocale('en');
			expect(plain('restore_out_of_time', { durationMs: 90_000 })).toContain('longer than 90 seconds');
			// Two sizes that would read the same are said in bytes.
			expect(plain('data_too_large', { bytes: 500 * 1024 * 1024 + 1, maxBytes: 500 * 1024 * 1024 })).toContain('it is 524,288,001 bytes, and a migration carries at most 524,288,000 bytes');
		} finally {
			setLocale(before);
		}
	});

	it('sets the vault key\'s variable, file and key file apart as values', () => {
		const view = migrationErrorView('vault_key_missing');
		expect(view.segments.filter((s) => 'value' in s)).toEqual([{ value: 'LYNOX_VAULT_KEY' }, { value: '~/.lynox/.env' }, { value: 'vault.key' }]);
		expect(view.box).toBeNull();
	});

	it('puts the target\'s words under the sentence, and this instance\'s error text only where it is the message', () => {
		expect(migrationErrorView('handshake_refused', { targetText: 'Invalid migration token' }).box).toEqual({ label: t('migration.target_says'), value: 'Invalid migration token' });
		expect(migrationErrorView('handshake_refused', {}).box).toBeNull();
		expect(migrationErrorView('export_failed', { detail: 'config unreadable' }).box).toEqual({ label: t('migration.message'), value: 'config unreadable' });
		expect(migrationErrorView('restore_failed', { detail: 'x' }).box).toEqual({ label: t('migration.message'), value: 'x' });
		expect(migrationErrorView('handshake_unreachable', { detail: 'x' }).box).toBeNull();
	});
});
