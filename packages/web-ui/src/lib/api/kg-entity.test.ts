import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchEntityRelations } from './kg-entity.js';

describe('fetchEntityRelations', () => {
	afterEach(() => { vi.unstubAllGlobals(); });

	it('resolves null for a failed or refused read, so it cannot pass for "no relations"', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
		await expect(fetchEntityRelations('/api', 'e1')).resolves.toBeNull();
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));
		await expect(fetchEntityRelations('/api', 'e1')).resolves.toBeNull();
	});

	it('returns an empty list only when the entity really has none', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ entity: {}, relations: [] }), { status: 200 })));
		await expect(fetchEntityRelations('/api', 'e1')).resolves.toEqual([]);
	});
});
