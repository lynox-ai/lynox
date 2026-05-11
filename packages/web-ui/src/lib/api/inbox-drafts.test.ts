import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createDraft,
	getDraft,
	getItemDraft,
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
});

describe('createDraft', () => {
	it('POSTs the body and returns the draft on 201', async () => {
		installFetch(async () => jsonResponse({ draft: SAMPLE }, 201));
		const result = await createDraft('/api', 'inb_1', CREATE_BODY);
		expect(result).toEqual(SAMPLE);
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
