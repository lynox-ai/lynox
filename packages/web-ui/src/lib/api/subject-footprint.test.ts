import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	listSubjects,
	fetchSubjectFootprint,
	type SubjectFootprint,
} from './subject-footprint.js';

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

const FOOTPRINT: SubjectFootprint = {
	subject: { id: 's1', kind: 'organization', name: 'Acme GmbH' },
	timeline: [
		{ type: 'record', occurredAt: '2026-03-15', occurredAtIsEventTime: true, collection: 'invoices', matchedColumns: ['client'], row: { amount: 200 } },
		{ type: 'thread', occurredAt: '2026-06-01', thread: { id: 't1', title: 'Kickoff', updated_at: '2026-06-01' } },
	],
	memories: [{ id: 'm1', text: 'prefers email', createdAt: '2026-02-01', confidence: 0.9 }],
	tasks: [{ id: 'k1', title: 'Follow up', status: 'open', priority: 'high', due_date: '2026-07-10' }],
	truncated: { records: false, threads: false, memories: false, tasks: false },
};

beforeEach(() => { vi.unstubAllGlobals(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('listSubjects', () => {
	it('returns {subjects, total} on a 200 response', async () => {
		installFetch(async () => jsonResponse({ subjects: [{ id: 's1', kind: 'person', name: 'A' }], total: 1 }));
		expect(await listSubjects('/api')).toEqual({ subjects: [{ id: 's1', kind: 'person', name: 'A' }], total: 1 });
	});

	it('builds q/limit/offset query params', async () => {
		installFetch(async () => jsonResponse({ subjects: [], total: 0 }));
		await listSubjects('/api', { q: 'a c', limit: 25, offset: 50 });
		expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/subjects?q=a+c&limit=25&offset=50');
	});

	it('omits the query string entirely when no opts are given', async () => {
		installFetch(async () => jsonResponse({ subjects: [], total: 0 }));
		await listSubjects('/api');
		expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/subjects');
	});

	it('returns null on a non-ok response (e.g. 503 flag off)', async () => {
		installFetch(async () => new Response('', { status: 503 }));
		expect(await listSubjects('/api')).toBeNull();
	});

	it('defaults to empty subjects/0 total when the payload is malformed', async () => {
		installFetch(async () => jsonResponse({ subjects: null }));
		expect(await listSubjects('/api')).toEqual({ subjects: [], total: 0 });
	});

	it('returns null when fetch throws', async () => {
		installFetch(async () => { throw new TypeError('network'); });
		expect(await listSubjects('/api')).toBeNull();
	});
});

describe('fetchSubjectFootprint', () => {
	it('returns the footprint payload on 200', async () => {
		installFetch(async () => jsonResponse(FOOTPRINT));
		expect(await fetchSubjectFootprint('/api', 's1')).toEqual(FOOTPRINT);
	});

	it('encodeURIComponent-wraps the id and passes the limit', async () => {
		installFetch(async () => jsonResponse(FOOTPRINT));
		await fetchSubjectFootprint('/api', 's/1', { limit: 10 });
		expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/subjects/s%2F1/footprint?limit=10');
	});

	it('returns null on a 404 (unknown/stale subject)', async () => {
		installFetch(async () => new Response('', { status: 404 }));
		expect(await fetchSubjectFootprint('/api', 'ghost')).toBeNull();
	});

	it('returns null when fetch throws', async () => {
		installFetch(async () => { throw new Error('network'); });
		expect(await fetchSubjectFootprint('/api', 's1')).toBeNull();
	});
});
