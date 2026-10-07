import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const added: Array<{ message: string; type: string }> = [];
vi.mock('../stores/toast.svelte.js', () => ({
	addToast: (message: string, type: string) => { added.push({ message, type }); return 1; },
}));

describe('copyWithToast', () => {
	beforeEach(() => { added.length = 0; });
	afterEach(() => { vi.unstubAllGlobals(); });

	it('reports a failed copy as an error, and resolves false rather than rejecting', async () => {
		vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('NotAllowedError')) } });
		const { copyWithToast } = await import('./clipboard.js');
		await expect(copyWithToast('x')).resolves.toBe(false);
		expect(added).toHaveLength(1);
		expect(added[0]?.type).toBe('error');
	});

	it('reports a copy that worked as a success, and only that', async () => {
		vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
		const { copyWithToast } = await import('./clipboard.js');
		await expect(copyWithToast('x')).resolves.toBe(true);
		expect(added).toEqual([expect.objectContaining({ type: 'success' })]);
	});
});
