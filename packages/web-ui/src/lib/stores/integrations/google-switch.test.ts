import { describe, it, expect, vi } from 'vitest';
import { deleteClientPair, performSwitchToManaged, type FetchLike } from './google-switch.js';

const BASE = '/api';

/** A fetch stub whose per-path outcome the test names. Default: everything 200. */
function stub(overrides: Record<string, boolean> = {}): { fn: FetchLike; calls: string[] } {
	const calls: string[] = [];
	const fn: FetchLike = async (input, init) => {
		calls.push(`${init?.method ?? 'GET'} ${input}`);
		const key = Object.keys(overrides).find((k) => input.endsWith(k));
		return { ok: key === undefined ? true : overrides[key]! };
	};
	return { fn, calls };
}

describe('deleteClientPair — both deletions are checked', () => {
	it('reports success only when both answer 2xx', async () => {
		const { fn, calls } = stub();
		expect(await deleteClientPair(fn, BASE)).toBe(true);
		expect(calls).toEqual([
			'DELETE /api/secrets/GOOGLE_CLIENT_ID',
			'DELETE /api/secrets/GOOGLE_CLIENT_SECRET',
		]);
	});

	it('reports failure when the ID delete fails', async () => {
		// The half-deleted pair is the whole point: `fetch` rejects only on a
		// network error, so a 500 here is a resolved promise and the old
		// `Promise.all` with no `.ok` check called it a success.
		expect(await deleteClientPair(stub({ GOOGLE_CLIENT_ID: false }).fn, BASE)).toBe(false);
	});

	it('reports failure when the SECRET delete fails', async () => {
		// Both directions, because checking one and not the other passes a test
		// written for either half alone.
		expect(await deleteClientPair(stub({ GOOGLE_CLIENT_SECRET: false }).fn, BASE)).toBe(false);
	});
});

describe('performSwitchToManaged — nothing proceeds on a failed step', () => {
	it('drops the local grant first, then the pair, then reloads', async () => {
		const { fn, calls } = stub();
		expect(await performSwitchToManaged(fn, BASE)).toEqual({ ok: true });
		expect(calls).toEqual([
			'POST /api/google/disconnect',
			'DELETE /api/secrets/GOOGLE_CLIENT_ID',
			'DELETE /api/secrets/GOOGLE_CLIENT_SECRET',
			'POST /api/google/reload',
		]);
		// The order is the safety argument, so it is asserted as an order and
		// not as a set.
		expect(calls[0]).toContain('/google/disconnect');
	});

	it('destroys nothing when the disconnect fails', async () => {
		const { fn, calls } = stub({ '/google/disconnect': false });
		expect(await performSwitchToManaged(fn, BASE)).toEqual({ ok: false, stage: 'disconnect' });
		expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false);
	});

	it('reports the HALF-done state when the pair delete fails after a successful disconnect', async () => {
		const { fn, calls } = stub({ GOOGLE_CLIENT_SECRET: false });
		// `stage` exists so the card can say "your connection was reset" rather
		// than "nothing changed" — which would be a lie, the grant is gone.
		expect(await performSwitchToManaged(fn, BASE)).toEqual({ ok: false, stage: 'pair' });
		expect(calls).toContain('POST /api/google/disconnect');
		expect(calls).not.toContain('POST /api/google/reload');
	});

	it('never issues a revoke request to Google', async () => {
		// D12: the grant is the user's and revoking it is irreversible. The
		// engine-side `/google/disconnect` is what makes this possible; this
		// asserts the client never reaches for `/google/revoke` instead.
		const { fn, calls } = stub();
		await performSwitchToManaged(fn, BASE);
		expect(calls.some((c) => c.includes('/google/revoke'))).toBe(false);
		expect(calls.some((c) => c.includes('accounts.google.com'))).toBe(false);
	});

	it('the stub can fail — positive control', async () => {
		// Without this, a stub that always answers `ok:true` would make every
		// failure case above pass for the wrong reason.
		const { fn } = stub({ '/google/disconnect': false });
		expect((await fn('/api/google/disconnect', { method: 'POST' })).ok).toBe(false);
		expect((await fn('/api/google/reload', { method: 'POST' })).ok).toBe(true);
	});
});

describe('revokeNotice — the page reports a revocation only when Google confirmed it', () => {
	it('says revoked when the engine reports Google confirmed it', async () => {
		const { revokeNotice } = await import('./google-switch.js');
		expect(revokeNotice({ ok: true, revoked_at_google: true })).toEqual({ key: 'integrations.google_revoked', type: 'success' });
	});

	it('says disconnected here only, when Google did not confirm', async () => {
		const { revokeNotice } = await import('./google-switch.js');
		expect(revokeNotice({ ok: true, revoked_at_google: false })).toEqual({ key: 'integrations.google_revoked_locally_only', type: 'info' });
	});

	it('does not read a missing field as a revocation (an older engine sends none)', async () => {
		const { revokeNotice } = await import('./google-switch.js');
		expect(revokeNotice({ ok: true }).type).toBe('info');
		expect(revokeNotice(null).type).toBe('info');
	});
});

describe('driveBackupNotice — a copy that may remain is never reported as gone', () => {
	it('names a degraded deletion as an error, whatever was deleted before it', async () => {
		const { driveBackupNotice } = await import('./google-switch.js');
		expect(driveBackupNotice({ drive_backups: { status: 'degraded', deleted: 4, folders_kept: 2, problems: ['x'] } }))
			.toEqual({ key: 'integrations.google_drive_backups_degraded', type: 'error', count: 4 });
	});

	it('reports a completed deletion with its count', async () => {
		const { driveBackupNotice } = await import('./google-switch.js');
		expect(driveBackupNotice({ drive_backups: { status: 'deleted', deleted: 3, folders_kept: 1, problems: [] } }))
			.toEqual({ key: 'integrations.google_drive_backups_deleted', type: 'success', count: 3 });
	});

	it('says nothing when there was nothing to see, and for an older engine', async () => {
		const { driveBackupNotice } = await import('./google-switch.js');
		expect(driveBackupNotice({ drive_backups: { status: 'none', deleted: 0 } })).toBeNull();
		expect(driveBackupNotice({ drive_backups: { status: 'unchecked', deleted: 0 } })).toBeNull();
		expect(driveBackupNotice({ ok: true, revoked_at_google: true })).toBeNull();
		expect(driveBackupNotice(null)).toBeNull();
	});
});

describe('revokeGoogle reports through revokeNotice', () => {
	// A source guard, because the store is not injectable. It pins only that the
	// call is there — the behaviour of the decision is pinned above, on the pure
	// function. Without the call, the page would report a revocation whatever
	// the engine answered.
	it('builds its message from revokeNotice', async () => {
		const { readFileSync } = await import('node:fs');
		const { fileURLToPath } = await import('node:url');
		const source = readFileSync(fileURLToPath(new URL('./google.svelte.ts', import.meta.url)), 'utf-8');
		const start = source.indexOf('export async function revokeGoogle(');
		expect(start, 'revokeGoogle not found — this guard is pinned to a name that moved').toBeGreaterThan(-1);
		const body = source.slice(start, source.indexOf('\n}\n', start));
		expect(body.replace(/\/\/.*$/gm, '')).toMatch(/revokeNotice\(/);
		// And the Drive half: without it a failed deletion would never reach the page.
		expect(body.replace(/\/\/.*$/gm, '')).toMatch(/driveBackupNotice\(/);
		// The route deletes only when asked, so the page that showed the
		// confirmation must ask — in JSON, which is what keeps it off a cross-site post.
		expect(body.replace(/\/\/.*$/gm, '')).toMatch(/JSON\.stringify\(\{ delete_drive_backups: true \}\)/);
		expect(body.replace(/\/\/.*$/gm, '')).toMatch(/'Content-Type': 'application\/json'/);
	});
});

describe('the Disconnect button asks first', () => {
	// A source guard, like the one above: the component is not mounted in this
	// suite. The click now deletes the user's Drive backups and revokes at Google,
	// neither of which can be undone, so it must open the confirmation rather than
	// run the revoke, and the confirmation must name the Drive step when the grant
	// could have uploaded any.
	it('opens the confirmation; only the confirmation revokes', async () => {
		const { readFileSync } = await import('node:fs');
		const { fileURLToPath } = await import('node:url');
		const source = readFileSync(fileURLToPath(new URL('../../components/GoogleSettings.svelte', import.meta.url)), 'utf-8');
		expect(source).not.toMatch(/onclick=\{revokeGoogle\}/);
		const confirm = source.slice(source.indexOf('async function confirmDisconnect('));
		expect(confirm.slice(0, confirm.indexOf('\n\t}\n'))).toMatch(/await revokeGoogle\(\)/);
		expect(source).toMatch(/\{#if grantSeesDrive\}\s*<p[^>]*>\{t\('integrations\.google_disconnect_confirm_drive'\)\}/);
	});
});
