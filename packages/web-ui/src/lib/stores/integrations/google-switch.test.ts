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
