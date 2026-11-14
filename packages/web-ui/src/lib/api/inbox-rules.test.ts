import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	confirmInboxRule,
	createInboxRule,
	deleteInboxRule,
	isRulePending,
	listInboxRules,
	type CreateRuleBody,
	type InboxRule,
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
		expect(result).toEqual({ ok: true, id: 'r-new' });
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(init.method).toBe('POST');
		expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
		expect(JSON.parse(init.body as string)).toEqual(CREATE_BODY);
	});

	it('sends the name and a description rule as given', async () => {
		installFetch(async () => jsonResponse({ id: 'r-new' }, 201));
		const body: CreateRuleBody = { ...CREATE_BODY, matcherKind: 'matches_description', matcherValue: 'Mahnungen', name: 'Mahnungen' };
		await createInboxRule('/api', body);
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(JSON.parse(init.body as string)).toEqual(body);
	});

	it('reports a refusal of a rule label such as R1 apart from any other refusal', async () => {
		installFetch(async () => jsonResponse({ error: 'name must not name a rule label such as R1' }, 400));
		expect(await createInboxRule('/api', CREATE_BODY)).toEqual({ ok: false, refusal: 'rule_label' });
		installFetch(async () => jsonResponse({ error: 'description must not name a rule label such as R1' }, 400));
		expect(await createInboxRule('/api', CREATE_BODY)).toEqual({ ok: false, refusal: 'rule_label' });
	});

	// Each refusal the form names, by the server's words (`inbox/api.ts`, `inbox/rule-text.ts`).
	it.each([
		['matcherValue must be one sender address', 'not_one_address'],
		['matcherValue holds characters a reader does not see', 'hidden_chars'],
		['description holds characters a reader does not see', 'hidden_chars'],
		['matcherValue must be one line', 'hidden_chars'],
		['description must be one line', 'hidden_chars'],
		['subject phrase must be at least 3 characters', 'subject_short'],
		['matcherValue exceeds 200 characters', 'too_long'],
		['list_id rules do not apply yet', 'list_id'],
	] as const)('reports "%s" as %s', async (error, refusal) => {
		installFetch(async () => jsonResponse({ error }, 400));
		expect(await createInboxRule('/api', CREATE_BODY)).toEqual({ ok: false, refusal });
	});

	it('names no refusal the form cannot act on', async () => {
		for (const error of ['description must be 3 to 300 characters', 'x matcherValue must be one line', 'invalid matcherKind']) {
			installFetch(async () => jsonResponse({ error }, 400));
			expect(await createInboxRule('/api', CREATE_BODY)).toEqual({ ok: false, refusal: null });
		}
	});

	it('names no refusal when the server rejects with another 400', async () => {
		installFetch(async () => jsonResponse({ error: 'bad' }, 400));
		expect(await createInboxRule('/api', CREATE_BODY)).toEqual({ ok: false, refusal: null });
	});

	it('names no refusal when a refusal has no JSON body', async () => {
		installFetch(async () => new Response('nope', { status: 400 }));
		expect(await createInboxRule('/api', CREATE_BODY)).toEqual({ ok: false, refusal: null });
	});

	it('fails when the server omits the id field', async () => {
		installFetch(async () => jsonResponse({}, 201));
		expect(await createInboxRule('/api', CREATE_BODY)).toEqual({ ok: false, refusal: null });
	});

	it('fails when fetch throws', async () => {
		installFetch(async () => {
			throw new Error('network');
		});
		expect(await createInboxRule('/api', CREATE_BODY)).toEqual({ ok: false, refusal: null });
	});
});

describe('confirmInboxRule', () => {
	it('POSTs to the confirm route of the encoded id and is true when the server names it', async () => {
		installFetch(async () => jsonResponse({ id: 'rul_a/b' }));
		expect(await confirmInboxRule('/api', 'rul_a/b')).toBe(true);
		expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/inbox/rules/rul_a%2Fb/confirm');
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(init.method).toBe('POST');
	});

	it('is false when the owner-only route refuses (403) or the rule is gone (404)', async () => {
		installFetch(async () => jsonResponse({ error: 'owner only' }, 403));
		expect(await confirmInboxRule('/api', 'rul_x')).toBe(false);
		installFetch(async () => jsonResponse({ error: 'rule not found' }, 404));
		expect(await confirmInboxRule('/api', 'rul_x')).toBe(false);
	});

	it('is false when the answer names another rule', async () => {
		installFetch(async () => jsonResponse({ id: 'rul_other' }));
		expect(await confirmInboxRule('/api', 'rul_x')).toBe(false);
	});

	it('is false when fetch throws', async () => {
		installFetch(async () => {
			throw new Error('network');
		});
		expect(await confirmInboxRule('/api', 'rul_x')).toBe(false);
	});
});

describe('isRulePending', () => {
	it('is true without confirmedAt and false with it', () => {
		const rule: InboxRule = { ...SAMPLE_RULE, source: 'agent' };
		expect(isRulePending(rule)).toBe(true);
		expect(isRulePending({ ...rule, confirmedAt: null })).toBe(true);
		expect(isRulePending({ ...rule, confirmedAt: '2026-11-05T00:00:00Z' })).toBe(false);
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
