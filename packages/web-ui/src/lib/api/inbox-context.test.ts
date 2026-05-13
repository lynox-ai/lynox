import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getItemContext } from './inbox-context.js';

let fetchMock: ReturnType<typeof vi.fn>;

function installFetch(impl: (...args: Parameters<typeof fetch>) => Promise<Response>): void {
	fetchMock = vi.fn(impl);
	vi.stubGlobal('fetch', fetchMock);
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

beforeEach(() => {
	vi.unstubAllGlobals();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('getItemContext', () => {
	it('returns the parsed envelope on 200', async () => {
		installFetch(async () =>
			jsonResponse({
				sender: { address: 's@x.example', name: 'S' },
				recentThreads: [{ id: 'a', subject: 'old', mailDate: '2026-05-01T10:00:00Z', classifiedAt: '2026-05-01T11:00:00Z', bucket: 'requires_user' }],
				openFollowups: [],
				outboundHistory: [],
				reminders: [],
			}),
		);
		const res = await getItemContext('/api', 'inb_1');
		expect(res?.sender.address).toBe('s@x.example');
		expect(res?.sender.name).toBe('S');
		expect(res?.recentThreads).toHaveLength(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/inbox/items/inb_1/context');
	});

	it('encodes the itemId path segment', async () => {
		installFetch(async () =>
			jsonResponse({ sender: { address: '', name: null }, recentThreads: [], openFollowups: [], outboundHistory: [], reminders: [] }),
		);
		await getItemContext('/api', 'inb 1/x');
		expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/inbox/items/inb%201%2Fx/context');
	});

	it('returns null on 404', async () => {
		installFetch(async () => new Response('', { status: 404 }));
		expect(await getItemContext('/api', 'missing')).toBeNull();
	});

	it('returns null on 500', async () => {
		installFetch(async () => new Response('', { status: 500 }));
		expect(await getItemContext('/api', 'inb_1')).toBeNull();
	});

	it('returns null when fetch throws', async () => {
		installFetch(async () => {
			throw new TypeError('network');
		});
		expect(await getItemContext('/api', 'inb_1')).toBeNull();
	});

	it('defaults missing array fields to [] (defensive against partial backend rollouts)', async () => {
		installFetch(async () =>
			jsonResponse({ sender: { address: 's@x', name: null } }),
		);
		const res = await getItemContext('/api', 'inb_1');
		expect(res?.recentThreads).toEqual([]);
		expect(res?.openFollowups).toEqual([]);
		expect(res?.outboundHistory).toEqual([]);
		expect(res?.reminders).toEqual([]);
	});

	it('returns null when sender envelope is missing (malformed payload)', async () => {
		installFetch(async () => jsonResponse({ recentThreads: [] }));
		expect(await getItemContext('/api', 'inb_1')).toBeNull();
	});
});
