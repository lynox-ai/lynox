import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const markSessionExpired = vi.fn();
vi.mock('../stores/session.svelte.js', () => ({ markSessionExpired: () => markSessionExpired() }));

const { installApiFetchInterceptor } = await import('./api-fetch-interceptor.js');

/** Install the interceptor over a fake `fetch` that answers every call with `status` and `body`. */
function installOver(status: number, body: string): void {
	vi.stubGlobal('window', { fetch: async () => new Response(body, { status, headers: { 'Content-Type': 'application/json' } }) });
	installApiFetchInterceptor();
}

const REVOKED = JSON.stringify({ error: 'This access has ended.', code: 'mandate_revoked' });

describe('api fetch interceptor', () => {
	beforeEach(() => { markSessionExpired.mockClear(); });
	afterEach(() => { vi.unstubAllGlobals(); });

	it('ends the session on the 403 of an ended access, and a view that reads 403 as its own state does not swallow it', async () => {
		installOver(403, REVOKED);
		// The shape of SecretsView: a 403 is read as "managed_blocked" and shown in place.
		const res = await window.fetch('/api/secrets');
		const viewState = res.status === 403 ? 'managed_blocked' : 'ok';
		expect(viewState).toBe('managed_blocked');
		expect(markSessionExpired).toHaveBeenCalledTimes(1);
		// The view still gets the whole body: the interceptor read a clone.
		expect(await res.json()).toEqual({ error: 'This access has ended.', code: 'mandate_revoked' });
	});

	it('leaves every other 403 to the view that got it', async () => {
		installOver(403, JSON.stringify({ error: 'Managed instance: secrets are system-controlled' }));
		await window.fetch('/api/secrets');
		installOver(403, JSON.stringify({ error: 'Only the owner of this instance can delete all data.', code: 'owner_only' }));
		await window.fetch('/api/data');
		expect(markSessionExpired).not.toHaveBeenCalled();
	});

	it('leaves a 403 whose body is not JSON to the view, without throwing', async () => {
		installOver(403, 'Forbidden');
		const res = await window.fetch('/api/secrets');
		expect(res.status).toBe(403);
		expect(markSessionExpired).not.toHaveBeenCalled();
	});

	it('ignores the code outside /api/ and on the auth handshake', async () => {
		installOver(403, REVOKED);
		await window.fetch('https://example.invalid/collect');
		await window.fetch('/api/auth/token');
		expect(markSessionExpired).not.toHaveBeenCalled();
	});

	it('still ends the session on a 401 from /api/, and not on the handshake', async () => {
		installOver(401, JSON.stringify({ error: 'Unauthorized' }));
		await window.fetch('/api/login');
		expect(markSessionExpired).not.toHaveBeenCalled();
		await window.fetch('/api/secrets');
		expect(markSessionExpired).toHaveBeenCalledTimes(1);
	});
});
