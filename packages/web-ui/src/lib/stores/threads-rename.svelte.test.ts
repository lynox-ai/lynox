import { describe, it, expect, vi, afterEach } from 'vitest';

const added: Array<{ message: string; type: string }> = [];
vi.mock('./toast.svelte.js', () => ({
	addToast: (message: string, type: string) => { added.push({ message, type }); return 1; },
}));

describe('renameThread', () => {
	afterEach(() => { vi.unstubAllGlobals(); added.length = 0; });

	it('takes the title back and tells the user when the request never gets an answer', async () => {
		const store = await import('./threads.svelte.js');
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
			threads: [{ id: 't1', title: 'Old', message_count: 3 }],
		}), { status: 200 })));
		await store.loadThreads();
		expect(store.getThreads().find((t) => t.id === 't1')?.title).toBe('Old');

		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
		await expect(store.renameThread('t1', 'New')).resolves.toBeUndefined();
		expect(store.getThreads().find((t) => t.id === 't1')?.title).toBe('Old');
		expect(added).toEqual([expect.objectContaining({ type: 'error' })]);
	});
});
