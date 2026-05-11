import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createInboxRule,
	deleteInboxRule,
	listInboxRules,
	type CreateRuleBody,
} from './inbox-rules.js';

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

const SAMPLE_RULE = {
	id: 'r1',
	tenantId: 'default',
	accountId: 'acct-1',
	matcherKind: 'from' as const,
	matcherValue: 'noreply@',
	bucket: 'auto_handled' as const,
	action: 'archive' as const,
	source: 'on_demand' as const,
	createdAt: '2026-05-11T00:00:00Z',
};

const CREATE_BODY: CreateRuleBody = {
	accountId: 'acct-1',
	matcherKind: 'from',
	matcherValue: 'noreply@',
	bucket: 'auto_handled',
	action: 'archive',
	source: 'on_demand',
};

beforeEach(() => {
	vi.unstubAllGlobals();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('listInboxRules', () => {
	it('returns the rules array on a 200 response', async () => {
		installFetch(async () => jsonResponse({ rules: [SAMPLE_RULE] }));
		const result = await listInboxRules('/api', 'acct-1');
		expect(result).toEqual([SAMPLE_RULE]);
	});

	it('passes accountId via URLSearchParams + adds tenantId when provided', async () => {
		installFetch(async () => jsonResponse({ rules: [] }));
		await listInboxRules('/api', 'a c c t', 'tenant-7');
		const calledWith = fetchMock.mock.calls[0]?.[0] as string;
		expect(calledWith).toBe('/api/inbox/rules?accountId=a+c+c+t&tenantId=tenant-7');
	});

	it('returns null on a non-ok response so callers can toast', async () => {
		installFetch(async () => new Response('', { status: 500 }));
		expect(await listInboxRules('/api', 'acct-1')).toBeNull();
	});

	it('returns [] when the server omits the rules field', async () => {
		installFetch(async () => jsonResponse({}));
		expect(await listInboxRules('/api', 'acct-1')).toEqual([]);
	});

	it('returns [] when rules is not an array (malformed payload)', async () => {
		installFetch(async () => jsonResponse({ rules: null }));
		expect(await listInboxRules('/api', 'acct-1')).toEqual([]);
	});

	it('returns null when fetch throws', async () => {
		installFetch(async () => {
			throw new TypeError('network');
		});
		expect(await listInboxRules('/api', 'acct-1')).toBeNull();
	});
});

describe('createInboxRule', () => {
	it('POSTs the body and returns the new id on 201', async () => {
		installFetch(async () => jsonResponse({ id: 'r-new' }, 201));
		const result = await createInboxRule('/api', CREATE_BODY);
		expect(result).toEqual({ id: 'r-new' });
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(init.method).toBe('POST');
		expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
		expect(JSON.parse(init.body as string)).toEqual(CREATE_BODY);
	});

	it('returns null when the server rejects with 400', async () => {
		installFetch(async () => jsonResponse({ error: 'bad' }, 400));
		expect(await createInboxRule('/api', CREATE_BODY)).toBeNull();
	});

	it('returns null when the server omits the id field', async () => {
		installFetch(async () => jsonResponse({}, 201));
		expect(await createInboxRule('/api', CREATE_BODY)).toBeNull();
	});

	it('returns null when fetch throws', async () => {
		installFetch(async () => {
			throw new Error('network');
		});
		expect(await createInboxRule('/api', CREATE_BODY)).toBeNull();
	});
});

describe('deleteInboxRule', () => {
	it('returns true on 200 OK', async () => {
		installFetch(async () => new Response('', { status: 200 }));
		expect(await deleteInboxRule('/api', 'r1')).toBe(true);
	});

	it('returns true on 204 No Content (Empty body, no res.ok)', async () => {
		installFetch(async () => new Response(null, { status: 204 }));
		expect(await deleteInboxRule('/api', 'r1')).toBe(true);
	});

	it('encodeURIComponent-wraps the id so reserved chars do not corrupt the URL', async () => {
		installFetch(async () => new Response('', { status: 204 }));
		await deleteInboxRule('/api', 'r/with slash');
		expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/inbox/rules/r%2Fwith%20slash');
	});

	it('returns false on 404', async () => {
		installFetch(async () => new Response('', { status: 404 }));
		expect(await deleteInboxRule('/api', 'r1')).toBe(false);
	});

	it('returns false when fetch throws', async () => {
		installFetch(async () => {
			throw new Error('network');
		});
		expect(await deleteInboxRule('/api', 'r1')).toBe(false);
	});
});
