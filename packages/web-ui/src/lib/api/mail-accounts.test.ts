import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listMailAccounts } from './mail-accounts.js';

type FetchArgs = Parameters<typeof fetch>;
type FetchResolver = (...args: FetchArgs) => Promise<Response>;

let fetchMock: ReturnType<typeof vi.fn>;

function installFetch(impl: FetchResolver): void {
	fetchMock = vi.fn(impl);
	vi.stubGlobal('fetch', fetchMock);
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

const SAMPLE = {
	id: 'acct-1',
	displayName: 'Rafael',
	address: 'rafael@example.com',
	preset: 'custom',
	isDefault: true,
	type: 'personal',
	authType: 'imap',
};

beforeEach(() => {
	vi.unstubAllGlobals();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('listMailAccounts', () => {
	it('returns the accounts array on a 200', async () => {
		installFetch(async () => jsonResponse({ accounts: [SAMPLE] }));
		expect(await listMailAccounts('/api')).toEqual([SAMPLE]);
	});

	it('returns [] when the server omits the field', async () => {
		installFetch(async () => jsonResponse({}));
		expect(await listMailAccounts('/api')).toEqual([]);
	});

	it('returns [] when accounts is not an array (malformed payload)', async () => {
		installFetch(async () => jsonResponse({ accounts: 'broken' }));
		expect(await listMailAccounts('/api')).toEqual([]);
	});

	it('returns null on a 500 response', async () => {
		installFetch(async () => new Response('', { status: 500 }));
		expect(await listMailAccounts('/api')).toBeNull();
	});

	it('returns null when fetch throws', async () => {
		installFetch(async () => {
			throw new TypeError('network');
		});
		expect(await listMailAccounts('/api')).toBeNull();
	});

	it('honours the apiBase argument for proxy deployments', async () => {
		installFetch(async () => jsonResponse({ accounts: [] }));
		await listMailAccounts('/api/proxy');
		expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/proxy/mail/accounts');
	});
});
