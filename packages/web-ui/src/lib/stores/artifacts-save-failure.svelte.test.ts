import { describe, it, expect, vi, afterEach } from 'vitest';

// `saveArtifact`, exported for other consumers, reports a failure as `null`: it must resolve null
// rather than reject or resolve something else.
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

// The route refuses a short body that carries the assistant's placeholder instead of a document
// (422, code `artifact_placeholder`); the markdown view says so in the person's language instead of its
// general failure. Every other failure keeps that general text: the server's own wording is
// English and not written for the person.
describe('trySaveArtifact', () => {
	afterEach(() => { vi.unstubAllGlobals(); });
	const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
	const opts = { title: 'Pitch', content: '[evicted after successful save]' };

	it('names the placeholder refusal', async () => {
		const { trySaveArtifact } = await import('./artifacts.svelte.js');
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(422, { error: 'Nothing was saved.', code: 'artifact_placeholder' })));
		await expect(trySaveArtifact(opts)).resolves.toEqual({ artifact: null, refusal: 'placeholder' });
	});

	it('names nothing for any other failure', async () => {
		const { trySaveArtifact } = await import('./artifacts.svelte.js');
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(422, { error: 'Nothing was saved.' })));
		await expect(trySaveArtifact(opts)).resolves.toEqual({ artifact: null, refusal: null });
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(403, { error: 'Only the owner of this instance can save an artifact.', code: 'artifact_placeholder' })));
		await expect(trySaveArtifact(opts)).resolves.toEqual({ artifact: null, refusal: null });
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>', { status: 422 })));
		await expect(trySaveArtifact(opts)).resolves.toEqual({ artifact: null, refusal: null });
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
		await expect(trySaveArtifact(opts)).resolves.toEqual({ artifact: null, refusal: null });
	});

	it('returns the saved artifact, and saveArtifact returns it too', async () => {
		const { trySaveArtifact, saveArtifact } = await import('./artifacts.svelte.js');
		const saved = { id: 'a1', title: 'Pitch', content: '<h1>Pitch</h1>' };
		vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init?: RequestInit) =>
			init?.method === 'POST' ? json(201, saved) : json(200, { artifacts: [] })));
		await expect(trySaveArtifact(opts)).resolves.toEqual({ artifact: saved });
		await expect(saveArtifact(opts)).resolves.toEqual(saved);
	});
});

describe('saveFailureText', () => {
	it('says the placeholder refusal in its own words and everything else as the fallback', async () => {
		const { saveFailureText } = await import('./artifacts.svelte.js');
		const { t } = await import('../i18n.svelte.js');
		expect(saveFailureText({ refusal: 'placeholder' }, 'fallback')).toBe(t('artifacts.placeholder_refused'));
		expect(t('artifacts.placeholder_refused')).not.toBe('artifacts.placeholder_refused');
		expect(saveFailureText({ refusal: null }, 'fallback')).toBe('fallback');
	});
});
