import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createDraft,
	generateDraft,
	getDraft,
	getItemDraft,
	refreshItemBody,
	updateDraft,
	type CreateDraftBody,
	type InboxDraft,
} from './inbox-drafts.js';

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

const SAMPLE: InboxDraft = {
	id: 'drf_1',
	tenantId: 'default',
	itemId: 'inb_1',
	bodyMd: 'Hi Max,\n\nDanke für die Nachricht.',
	generatedAt: '2026-05-11T12:00:00.000Z',
	generatorVersion: 'gen-2026-05',
	userEditsCount: 0,
};

const CREATE_BODY: CreateDraftBody = {
	bodyMd: 'Hi Max,',
	generatorVersion: 'gen-2026-05',
};

beforeEach(() => {
	vi.unstubAllGlobals();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('getItemDraft', () => {
	it('returns the draft on 200', async () => {
		installFetch(async () => jsonResponse({ draft: SAMPLE }));
		expect(await getItemDraft('/api', 'inb_1')).toEqual(SAMPLE);
	});

	it('returns null when the server returns draft:null', async () => {
		installFetch(async () => jsonResponse({ draft: null }));
		expect(await getItemDraft('/api', 'inb_1')).toBeNull();
	});

	it('encodes the itemId path segment', async () => {
		installFetch(async () => jsonResponse({ draft: null }));
		await getItemDraft('/api', 'inb 1/x');
		const calledWith = fetchMock.mock.calls[0]?.[0] as string;
		expect(calledWith).toBe('/api/inbox/items/inb%201%2Fx/draft');
	});

	it('returns undefined on a non-ok response so callers can distinguish "no draft" from "fetch failed"', async () => {
		installFetch(async () => new Response('', { status: 404 }));
		expect(await getItemDraft('/api', 'inb_1')).toBeUndefined();
	});

	it('returns undefined when fetch throws', async () => {
		installFetch(async () => {
			throw new TypeError('network');
		});
		expect(await getItemDraft('/api', 'inb_1')).toBeUndefined();
	});
});

describe('getDraft', () => {
	it('returns the draft on 200', async () => {
		installFetch(async () => jsonResponse({ draft: SAMPLE }));
		expect(await getDraft('/api', 'drf_1')).toEqual(SAMPLE);
	});

	it('returns null on 404', async () => {
		installFetch(async () => new Response('', { status: 404 }));
		expect(await getDraft('/api', 'drf_missing')).toBeNull();
	});

	it('returns null on 500', async () => {
		installFetch(async () => new Response('', { status: 500 }));
		expect(await getDraft('/api', 'drf_1')).toBeNull();
	});

	it('returns null when fetch throws', async () => {
		installFetch(async () => {
			throw new TypeError('network');
		});
		expect(await getDraft('/api', 'drf_1')).toBeNull();
	});
});

describe('createDraft', () => {
	it('POSTs the body and returns the draft on 201', async () => {
		installFetch(async () => jsonResponse({ draft: SAMPLE }, 201));
		const result = await createDraft('/api', 'inb_1', CREATE_BODY);
		expect(result).toEqual(SAMPLE);
		const url = fetchMock.mock.calls[0]?.[0] as string;
		expect(url).toBe('/api/inbox/items/inb_1/draft');
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(init.method).toBe('POST');
		expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
		expect(JSON.parse(init.body as string)).toEqual(CREATE_BODY);
	});

	it('returns null when the server returns 400', async () => {
		installFetch(async () => jsonResponse({ error: 'bad' }, 400));
		expect(await createDraft('/api', 'inb_1', CREATE_BODY)).toBeNull();
	});

	it('returns null when fetch throws', async () => {
		installFetch(async () => {
			throw new Error('network');
		});
		expect(await createDraft('/api', 'inb_1', CREATE_BODY)).toBeNull();
	});
});

describe('updateDraft', () => {
	it('PATCHes the bodyMd and returns the updated draft', async () => {
		installFetch(async () => jsonResponse({ draft: { ...SAMPLE, bodyMd: 'edited', userEditsCount: 1 } }));
		const result = await updateDraft('/api', 'drf_1', 'edited');
		expect(result?.bodyMd).toBe('edited');
		expect(result?.userEditsCount).toBe(1);
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(init.method).toBe('PATCH');
		expect(JSON.parse(init.body as string)).toEqual({ bodyMd: 'edited' });
	});

	it('encodes the draft id path segment', async () => {
		installFetch(async () => jsonResponse({ draft: SAMPLE }));
		await updateDraft('/api', 'drf 1/x', 'x');
		const calledWith = fetchMock.mock.calls[0]?.[0] as string;
		expect(calledWith).toBe('/api/inbox/drafts/drf%201%2Fx');
	});

	it('returns null on 404', async () => {
		installFetch(async () => new Response('', { status: 404 }));
		expect(await updateDraft('/api', 'drf_missing', 'x')).toBeNull();
	});

	it('returns null on 413 (oversize body)', async () => {
		installFetch(async () => jsonResponse({ error: 'too big' }, 413));
		expect(await updateDraft('/api', 'drf_1', 'huge')).toBeNull();
	});
});

describe('generateDraft', () => {
	it('POSTs to /draft/generate and returns the parsed envelope on 200', async () => {
		installFetch(async () => jsonResponse({
			bodyMd: 'Hallo Max,\n\nMittwoch passt.',
			generatorVersion: 'haiku-2026-05',
			bodyTruncated: false,
		}));
		const result = await generateDraft('/api', 'inb_1');
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.draft.bodyMd).toBe('Hallo Max,\n\nMittwoch passt.');
			expect(result.draft.generatorVersion).toBe('haiku-2026-05');
			expect(result.draft.bodyTruncated).toBe(false);
		}
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(init.method).toBe('POST');
		const url = fetchMock.mock.calls[0]?.[0] as string;
		expect(url).toBe('/api/inbox/items/inb_1/draft/generate');
	});

	it('defaults bodyTruncated=false when the field is missing from the payload', async () => {
		installFetch(async () => jsonResponse({ bodyMd: 'x', generatorVersion: 'v' }));
		const result = await generateDraft('/api', 'inb_1');
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.draft.bodyTruncated).toBe(false);
	});

	it('treats a 200 with empty bodyMd as success (contract pin)', async () => {
		installFetch(async () => jsonResponse({ bodyMd: '', generatorVersion: 'v', bodyTruncated: false }));
		const result = await generateDraft('/api', 'inb_1');
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.draft.bodyMd).toBe('');
	});

	it('routes a malformed 200 payload (missing bodyMd) to the recoverable unavailable fallback', async () => {
		installFetch(async () => jsonResponse({ generatorVersion: 'v' }));
		const result = await generateDraft('/api', 'inb_1');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason.kind).toBe('unavailable');
	});

	it('routes a malformed 200 payload (missing generatorVersion) to the recoverable unavailable fallback', async () => {
		installFetch(async () => jsonResponse({ bodyMd: 'x' }));
		const result = await generateDraft('/api', 'inb_1');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason.kind).toBe('unavailable');
	});

	it('sends POST with no request body when no opts are passed — server-side itemId in path is the only input', async () => {
		installFetch(async () => jsonResponse({ bodyMd: 'x', generatorVersion: 'v', bodyTruncated: false }));
		await generateDraft('/api', 'inb_1');
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(init.body).toBeUndefined();
	});

	it('serializes tone + previousBodyMd into the POST body for the regenerate flow', async () => {
		installFetch(async () => jsonResponse({ bodyMd: 'tight', generatorVersion: 'v', bodyTruncated: false }));
		await generateDraft('/api', 'inb_1', { tone: 'shorter', previousBodyMd: 'longer original draft' });
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
		expect(JSON.parse(init.body as string)).toEqual({ tone: 'shorter', previousBodyMd: 'longer original draft' });
	});

	it('omits previousBodyMd from the body when only tone is set', async () => {
		installFetch(async () => jsonResponse({ bodyMd: 'x', generatorVersion: 'v', bodyTruncated: false }));
		await generateDraft('/api', 'inb_1', { tone: 'warmer' });
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(JSON.parse(init.body as string)).toEqual({ tone: 'warmer' });
	});

	it('serializes an empty string previousBodyMd verbatim — the trigger is `!== undefined`, not truthiness', async () => {
		installFetch(async () => jsonResponse({ bodyMd: 'x', generatorVersion: 'v', bodyTruncated: false }));
		await generateDraft('/api', 'inb_1', { tone: 'shorter', previousBodyMd: '' });
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(JSON.parse(init.body as string)).toEqual({ tone: 'shorter', previousBodyMd: '' });
	});

	it('maps status codes to discriminated failures', async () => {
		const cases = [
			[404, 'not_found'],
			[501, 'unsupported'],
			[422, 'no_body'],
			[503, 'unavailable'],
			[500, 'network'],
		] as const;
		for (const [status, expected] of cases) {
			installFetch(async () => new Response('', { status }));
			const result = await generateDraft('/api', 'inb_1');
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason.kind).toBe(expected);
		}
	});

	it('encodes the itemId path segment', async () => {
		installFetch(async () => jsonResponse({ bodyMd: 'x', generatorVersion: 'v', bodyTruncated: false }));
		await generateDraft('/api', 'inb 1/x');
		const url = fetchMock.mock.calls[0]?.[0] as string;
		expect(url).toBe('/api/inbox/items/inb%201%2Fx/draft/generate');
	});

	it('returns network kind when fetch throws', async () => {
		installFetch(async () => {
			throw new TypeError('network');
		});
		const result = await generateDraft('/api', 'inb_1');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason.kind).toBe('network');
	});
});

describe('refreshItemBody', () => {
	it('POSTs to /body/refresh and returns the body on 200', async () => {
		installFetch(async () => jsonResponse({ bodyMd: 'FULL body', truncated: false, bytesWritten: 9 }));
		const result = await refreshItemBody('/api', 'inb_1');
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.bodyMd).toBe('FULL body');
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(init.method).toBe('POST');
		const url = fetchMock.mock.calls[0]?.[0] as string;
		expect(url).toBe('/api/inbox/items/inb_1/body/refresh');
	});

	it('encodes the itemId path segment', async () => {
		installFetch(async () => jsonResponse({ bodyMd: 'x', truncated: false, bytesWritten: 1 }));
		await refreshItemBody('/api', 'inb 1/x');
		expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/inbox/items/inb%201%2Fx/body/refresh');
	});

	it('returns network kind when the 200 payload omits bodyMd', async () => {
		installFetch(async () => jsonResponse({ truncated: false }));
		const result = await refreshItemBody('/api', 'inb_1');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason.kind).toBe('network');
	});

	it('reads the structured reason field on 422 to discriminate empty_body vs not_registered', async () => {
		installFetch(async () => jsonResponse({ error: 'mail has no text body to refresh from', reason: 'empty_body' }, 422));
		const empty = await refreshItemBody('/api', 'inb_1');
		expect(empty.ok).toBe(false);
		if (!empty.ok) expect(empty.reason.kind).toBe('empty_body');

		installFetch(async () => jsonResponse({ error: 'mail provider not registered', reason: 'not_registered' }, 422));
		const noProv = await refreshItemBody('/api', 'inb_1');
		expect(noProv.ok).toBe(false);
		if (!noProv.ok) expect(noProv.reason.kind).toBe('not_registered');
	});

	it('defaults 422 to not_registered when the reason field is missing', async () => {
		installFetch(async () => jsonResponse({ error: 'unspecified' }, 422));
		const result = await refreshItemBody('/api', 'inb_1');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason.kind).toBe('not_registered');
	});

	it('maps status codes to discriminated failures', async () => {
		const cases = [
			[404, 'not_found'],
			[501, 'unsupported'],
			[502, 'fetch_failed'],
			[503, 'unavailable'],
			[500, 'network'],
		] as const;
		for (const [status, expected] of cases) {
			installFetch(async () => new Response('', { status }));
			const result = await refreshItemBody('/api', 'inb_1');
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason.kind).toBe(expected);
		}
	});

	it('returns network kind when fetch throws', async () => {
		installFetch(async () => {
			throw new TypeError('network');
		});
		const result = await refreshItemBody('/api', 'inb_1');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason.kind).toBe('network');
	});
});
