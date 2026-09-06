import { describe, it, expect } from 'vitest';
import {
	grantedServices,
	scopeMismatch,
	toggleForServerMode,
	driveIsAppFilesOnly,
} from './google-scope-labels.js';

/** The set the managed broker actually asks for (PRD Stage 1 §3.1). */
const STAGE_1_GRANT = [
	'openid',
	'https://www.googleapis.com/auth/userinfo.email',
	'https://www.googleapis.com/auth/calendar.events',
	'https://www.googleapis.com/auth/calendar.freebusy',
	'https://www.googleapis.com/auth/drive.file',
];

describe('grantedServices — the card must not over-claim', () => {
	it('labels drive.file as "files lynox creates", not read-write', () => {
		const rows = grantedServices(STAGE_1_GRANT);
		const drive = rows.find((r) => r.name === 'Drive');
		expect(drive).toBeDefined();
		// The defect this replaces: `s.includes('/drive') && !s.includes('.readonly')`
		// is TRUE for drive.file, so the card announced full Drive read-write
		// next to a consent screen that had granted no such thing.
		expect(drive?.labelKey).toBe('integrations.scope_label_drive_file');
		expect(drive?.labelKey).not.toBe('integrations.scope_label_readwrite');
	});

	it('labels a real full-Drive grant as read-write — the control on the line above', () => {
		const drive = grantedServices(['https://www.googleapis.com/auth/drive'])
			.find((r) => r.name === 'Drive');
		expect(drive?.labelKey).toBe('integrations.scope_label_readwrite');
	});

	it('names Calendar by the event grant rather than as blanket read-write', () => {
		const cal = grantedServices(STAGE_1_GRANT).find((r) => r.name === 'Calendar');
		expect(cal?.labelKey).toBe('integrations.scope_label_calendar_events');
	});

	it('lists no product the grant does not cover', () => {
		expect(grantedServices(STAGE_1_GRANT).map((r) => r.name)).toEqual(['Calendar', 'Drive']);
		// Sheets, Docs and Gmail are absent because the broker set grants none
		// of them — the row this proves is "the card says what was granted".
	});

	it('emits ONE row per product, strongest grant first', () => {
		const rows = grantedServices([
			'https://www.googleapis.com/auth/drive',
			'https://www.googleapis.com/auth/drive.file',
			'https://www.googleapis.com/auth/drive.readonly',
		]);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.labelKey).toBe('integrations.scope_label_readwrite');
	});

	it('matches scopes exactly, so a look-alike string grants nothing', () => {
		expect(grantedServices(['https://evil.example.org/auth/drive'])).toEqual([]);
		expect(grantedServices(['https://www.googleapis.com/auth/drive.appdata'])).toEqual([]);
	});
});

describe('driveIsAppFilesOnly — three conditions, each one wrong in a draft', () => {
	const FILE = 'https://www.googleapis.com/auth/drive.file';
	const FULL = 'https://www.googleapis.com/auth/drive';
	const READ = 'https://www.googleapis.com/auth/drive.readonly';

	it('is true for exactly the Stage-1 Drive grant', () => {
		expect(driveIsAppFilesOnly(STAGE_1_GRANT)).toBe(true);
		expect(driveIsAppFilesOnly([FILE])).toBe(true);
	});

	it('is FALSE with no Drive access at all', () => {
		// Dropping the `drive.file` requirement survived every other test: the
		// note then appears on a connection that has no Drive to qualify.
		expect(driveIsAppFilesOnly([])).toBe(false);
		expect(driveIsAppFilesOnly(['https://www.googleapis.com/auth/calendar.events'])).toBe(false);
	});

	it('is FALSE when the grant really does reach the whole Drive', () => {
		// Any of the three is enough to make the note untrue. `drive.metadata.readonly`
		// is the one lynox never REQUESTS — it is only accepted — and it still sees
		// every file's metadata, so a "only files lynox created" note would be false.
		const META = 'https://www.googleapis.com/auth/drive.metadata.readonly';
		expect(driveIsAppFilesOnly([FILE, FULL])).toBe(false);
		expect(driveIsAppFilesOnly([FILE, READ])).toBe(false);
		expect(driveIsAppFilesOnly([FILE, META])).toBe(false);
		expect(driveIsAppFilesOnly([FULL])).toBe(false);
	});
});

describe('scopeMismatch — intent, not observation', () => {
	const base = { authenticated: true, serverMode: 'legacy' as const, toggle: 'standard' as const };

	it('is false for a legacy grant nobody has touched', () => {
		expect(scopeMismatch({ ...base, touched: false })).toBe(false);
	});

	it('becomes true once the user picks a mode the grant does not carry', () => {
		expect(scopeMismatch({ ...base, touched: true, toggle: 'full' })).toBe(true);
	});

	it('is false when the picked mode is the granted one', () => {
		expect(scopeMismatch({ touched: true, authenticated: true, serverMode: 'full', toggle: 'full' })).toBe(false);
	});

	it('is false with no connection at all, however the toggle stands', () => {
		expect(scopeMismatch({ touched: true, authenticated: false, serverMode: null, toggle: 'full' })).toBe(false);
	});
});

describe('toggleForServerMode', () => {
	it('parks legacy at standard without calling it standard', () => {
		expect(toggleForServerMode('legacy')).toBe('standard');
		expect(toggleForServerMode(null)).toBe('standard');
		expect(toggleForServerMode('standard')).toBe('standard');
		expect(toggleForServerMode('full')).toBe('full');
	});
});
