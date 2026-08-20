import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMailAccountPayload, listMailAccounts } from './mail-accounts.js';

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
	displayName: 'Alice',
	address: 'alice@example.com',
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

describe('buildMailAccountPayload', () => {
	const FIELDS = {
		id: 'acct-1',
		displayName: 'Roland',
		address: 'roland@example.com',
		preset: 'custom',
		type: 'business',
		password: 'pw',
		personaPrompt: '',
		custom: { imap: { host: 'imap.x', port: 993, secure: true } },
	};

	it('THE POINT: carries the chosen account type', () => {
		// The save path used to omit it. The server defaults a missing type to
		// 'personal', so an account created as Business came back Personal —
		// with a different send policy and persona than the one chosen.
		expect(buildMailAccountPayload(FIELDS)['type']).toBe('business');
	});

	it('carries personaPrompt when set, and omits it when blank', () => {
		expect(buildMailAccountPayload({ ...FIELDS, personaPrompt: '  Be brief.  ' })['personaPrompt']).toBe('Be brief.');
		expect('personaPrompt' in buildMailAccountPayload(FIELDS)).toBe(false);
	});

	it('includes custom host config only for the custom preset', () => {
		expect(buildMailAccountPayload(FIELDS)['custom']).toEqual(FIELDS.custom);
		expect('custom' in buildMailAccountPayload({ ...FIELDS, preset: 'gmail' })).toBe(false);
	});

	it('puts the address in credentials.user', () => {
		expect(buildMailAccountPayload(FIELDS)['credentials']).toEqual({ user: 'roland@example.com', pass: 'pw' });
	});

	it('forwards skipTest, which is the only way past a failed SMTP check', () => {
		// The pre-save test now covers the send path, and the server refuses the
		// save when it fails. Without this flag reaching the wire, a mailbox that
		// reads perfectly but cannot verify SMTP — an alias with no send rights, a
		// smarthost wanting different credentials, a provider throttling AUTH —
		// cannot be added at all, and the read half of the product goes with it.
		expect(buildMailAccountPayload({ ...FIELDS, skipTest: true })['skipTest']).toBe(true);
	});

	it('omits skipTest unless it was asked for, so the test stays on by default', () => {
		for (const f of [FIELDS, { ...FIELDS, skipTest: false }, { ...FIELDS, skipTest: undefined }]) {
			expect('skipTest' in buildMailAccountPayload(f)).toBe(false);
		}
	});
});
