import { describe, it, expect, vi, afterEach } from 'vitest';

// The diagram save in the markdown view reports a failure on `null`: that only works if a failed
// save resolves null rather than rejecting or resolving something else.
describe('saveArtifact', () => {
	afterEach(() => { vi.unstubAllGlobals(); });

	it('resolves null when the request fails or is refused', async () => {
		const { saveArtifact } = await import('./artifacts.svelte.js');
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
		await expect(saveArtifact({ title: 'd', content: 'graph TD; a-->b', type: 'mermaid' })).resolves.toBeNull();
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 500 })));
		await expect(saveArtifact({ title: 'd', content: 'graph TD; a-->b', type: 'mermaid' })).resolves.toBeNull();
	});
});
