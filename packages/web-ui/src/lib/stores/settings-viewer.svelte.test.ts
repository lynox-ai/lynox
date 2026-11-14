import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dismissProviderReset, isOwnerSession, isMandateSession, isViewerUnavailable, loadSettingsViewer, noteSettingsViewer, providerResetNotice, refreshProviderReset, resetSettingsViewer, viewerNote } from './settings-viewer.svelte.js';

// Whose session the pages serve is asked once, when a page mounts. The owner's actions wait for the
// answer, so a missing answer is asked again, a few times, and an answer without `viewer` is not.

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** `GET /api/config` answers these in turn, the last one from then on. */
function serve(...answers: Array<Response | Error>): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(async () => {
		const next = answers.length > 1 ? answers.shift()! : answers[0]!;
		if (next instanceof Error) throw next;
		return next.clone();
	});
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

beforeEach(() => {
	vi.useFakeTimers();
	resetSettingsViewer();
});

afterEach(() => {
	resetSettingsViewer();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('loadSettingsViewer', () => {
	it('asks again after a failed request, and the owner is known without a reload', async () => {
		const fetchMock = serve(new TypeError('network'), json({ viewer: 'owner' }));
		await loadSettingsViewer();
		expect(isOwnerSession()).toBe(false);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(isOwnerSession()).toBe(true);
	});

	it('asks again after a server error', async () => {
		const fetchMock = serve(json({ error: 'down' }, 503), json({ viewer: 'mandate' }));
		await loadSettingsViewer();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(isMandateSession()).toBe(true);
	});

	it('gives up after three more tries, and only then says the answer is unavailable', async () => {
		const fetchMock = serve(new TypeError('network'));
		await loadSettingsViewer();
		await vi.advanceTimersByTimeAsync(1_000 + 3_000);
		// Still trying: not yet unavailable.
		expect(isViewerUnavailable()).toBe(false);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(isOwnerSession()).toBe(false);
		expect(isViewerUnavailable()).toBe(true);
		resetSettingsViewer();
		expect(isViewerUnavailable(), 'a reset forgets it').toBe(false);
	});

	it('is no longer unavailable once a later page gets an answer', async () => {
		serve(new TypeError('network'));
		await loadSettingsViewer();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(isViewerUnavailable(), 'positive control: it gave up').toBe(true);
		serve(json({ viewer: 'owner' }));
		await loadSettingsViewer();
		expect(isOwnerSession()).toBe(true);
		expect(isViewerUnavailable()).toBe(false);
	});

	it('is not unavailable while the last retry still waits, though another page\'s request failed', async () => {
		const fetchMock = serve(new TypeError('network'));
		await loadSettingsViewer();
		await vi.advanceTimersByTimeAsync(1_000 + 3_000);
		// The last retry is scheduled; a second page asks and fails meanwhile.
		await loadSettingsViewer();
		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(isViewerUnavailable()).toBe(false);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(fetchMock).toHaveBeenCalledTimes(5);
		expect(isViewerUnavailable(), 'twin: once the last retry failed too').toBe(true);
	});

	it('is no longer unavailable once an older engine answers without a viewer', async () => {
		serve(new TypeError('network'));
		await loadSettingsViewer();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(isViewerUnavailable(), 'positive control: it gave up').toBe(true);
		serve(json({ managed: 'self-host' }));
		await loadSettingsViewer();
		expect(isViewerUnavailable()).toBe(false);
	});

	it('is never unavailable when a retry is answered', async () => {
		serve(json({ error: 'down' }, 503), json({ viewer: 'owner' }));
		await loadSettingsViewer();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(isOwnerSession()).toBe(true);
		expect(isViewerUnavailable()).toBe(false);
	});

	it('asks once: a later read takes the answer it has', async () => {
		const fetchMock = serve(json({ viewer: 'owner' }));
		await loadSettingsViewer();
		await loadSettingsViewer();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(isOwnerSession()).toBe(true);
	});

	it('does not ask again when the answer has no viewer', async () => {
		const fetchMock = serve(json({ managed: 'self-host' }));
		await loadSettingsViewer();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('does not take an answer asked for before a reset', async () => {
		let answer!: (r: Response) => void;
		vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => { answer = r; })));
		const before = loadSettingsViewer();
		resetSettingsViewer();
		answer(json({ viewer: 'owner' }));
		await before;
		expect(isOwnerSession()).toBe(false);
		// Twin: the same answer, asked for after the reset, is taken.
		serve(json({ viewer: 'owner' }));
		await loadSettingsViewer();
		expect(isOwnerSession()).toBe(true);
	});

	it('forgets a pending retry and what was read on reset', async () => {
		const fetchMock = serve(new TypeError('network'), json({ viewer: 'owner' }));
		await loadSettingsViewer();
		resetSettingsViewer();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		// Twin: a read after the reset asks the server again and takes its answer.
		serve(json({ viewer: 'mandate' }));
		await loadSettingsViewer();
		expect(isMandateSession()).toBe(true);
	});
});

describe('viewerNote, for a page that reads /config itself', () => {
	it('does not take a body asked for before a reset', () => {
		const note = viewerNote();
		resetSettingsViewer();
		note({ viewer: 'owner' });
		expect(isOwnerSession()).toBe(false);
		expect(isMandateSession()).toBe(false);
	});

	it('takes the same body when no reset came between', () => {
		const note = viewerNote();
		note({ viewer: 'owner' });
		expect(isOwnerSession()).toBe(true);
	});

	it('takes a body asked for after the reset', () => {
		resetSettingsViewer();
		const note = viewerNote();
		note({ viewer: 'mandate' });
		expect(isMandateSession()).toBe(true);
	});
});

// The engine put the provider back on Anthropic while the Shopify exchange is on. The chat
// and the LLM settings show a line until the owner clicks "Got it" or picks a provider.
describe('the line about the provider the engine changed', () => {
	it('is read from the body, and anything but a named provider reads as none', () => {
		noteSettingsViewer({ viewer: 'owner', locks: {}, provider_reset: { from: 'Mistral' } });
		expect(providerResetNotice()).toBe('Mistral');
		for (const reset of [null, undefined, {}, { from: '' }, { from: 3 }, 'Mistral']) {
			noteSettingsViewer({ viewer: 'owner', locks: {}, provider_reset: reset });
			expect(providerResetNotice(), JSON.stringify(reset)).toBeNull();
		}
	});

	it('"Got it" asks the server, and the line goes only when it said yes', async () => {
		noteSettingsViewer({ viewer: 'owner', locks: {}, provider_reset: { from: 'Mistral' } });
		const refused = serve(json({ error: 'Only the owner of this instance can dismiss this notice.' }, 403));
		expect(await dismissProviderReset()).toBe(false);
		expect(providerResetNotice()).toBe('Mistral');
		expect(refused).toHaveBeenCalledWith(expect.stringMatching(/\/config\/provider-reset\/dismiss$/), { method: 'POST' });

		serve(new TypeError('network'));
		expect(await dismissProviderReset()).toBe(false);
		expect(providerResetNotice()).toBe('Mistral');

		serve(json({ ok: true }));
		expect(await dismissProviderReset()).toBe(true);
		expect(providerResetNotice()).toBeNull();
	});

	it('goes with a new sign-in', () => {
		noteSettingsViewer({ viewer: 'owner', locks: {}, provider_reset: { from: 'Mistral' } });
		resetSettingsViewer();
		expect(providerResetNotice()).toBeNull();
	});

	it('is read again on request: an engine that changed the provider at its start is seen without a reload', async () => {
		serve(json({ viewer: 'owner', locks: {}, provider_reset: null }));
		await loadSettingsViewer();
		expect(providerResetNotice()).toBeNull();
		const again = serve(json({ viewer: 'owner', locks: {}, provider_reset: { from: 'Mistral' } }));
		await loadSettingsViewer();
		expect(again, 'the page load asks once').not.toHaveBeenCalled();
		await refreshProviderReset();
		expect(providerResetNotice()).toBe('Mistral');
	});

	it('keeps what it read when the second answer fails, and does not take an answer from before a sign-in', async () => {
		noteSettingsViewer({ viewer: 'owner', locks: {}, provider_reset: { from: 'Mistral' } });
		// A refused answer is not read, even one shaped like a config body.
		serve(json({ viewer: 'owner', locks: {}, provider_reset: null }, 503));
		await refreshProviderReset();
		expect(providerResetNotice()).toBe('Mistral');
		serve(new TypeError('network'));
		await refreshProviderReset();
		expect(providerResetNotice()).toBe('Mistral');

		let release: (r: Response) => void = () => {};
		vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => { release = r; })));
		const late = refreshProviderReset();
		resetSettingsViewer();
		release(json({ viewer: 'owner', locks: {}, provider_reset: { from: 'Mistral' } }));
		await late;
		expect(providerResetNotice()).toBeNull();
	});

	it('does not bring the line back with an answer asked for before "Got it"', async () => {
		noteSettingsViewer({ viewer: 'owner', locks: {}, provider_reset: { from: 'Mistral' } });
		let release: (r: Response) => void = () => {};
		vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('/dismiss')
			? Promise.resolve(json({ ok: true }))
			: new Promise<Response>((r) => { release = r; })));
		const early = refreshProviderReset();
		expect(await dismissProviderReset()).toBe(true);
		release(json({ viewer: 'owner', locks: {}, provider_reset: { from: 'Mistral' } }));
		await early;
		expect(providerResetNotice()).toBeNull();
	});

	it('does not bring the line back with a page\'s own body asked for before "Got it", and still takes the rest of it', async () => {
		noteSettingsViewer({ viewer: 'owner', locks: {}, provider_reset: { from: 'Mistral' } });
		const note = viewerNote();
		serve(json({ ok: true }));
		expect(await dismissProviderReset()).toBe(true);
		expect(note({ viewer: 'mandate', locks: {}, provider_reset: { from: 'Mistral' } })).toBe(true);
		expect(providerResetNotice()).toBeNull();
		expect(isMandateSession(), 'the rest of the body is still read').toBe(true);
		// A body asked for after it is read in full.
		viewerNote()({ viewer: 'owner', locks: {}, provider_reset: { from: 'Mistral' } });
		expect(providerResetNotice()).toBe('Mistral');
	});

	it('does not bring the line back with a page\'s own body asked for before a provider save', async () => {
		noteSettingsViewer({ viewer: 'owner', locks: {}, provider_reset: { from: 'Mistral' } });
		const note = viewerNote();
		serve(json({ viewer: 'owner', locks: {}, provider_reset: null }));
		await refreshProviderReset(true);
		expect(providerResetNotice()).toBeNull();
		note({ viewer: 'owner', locks: {}, provider_reset: { from: 'Mistral' } });
		expect(providerResetNotice()).toBeNull();
	});

	it('does not bring the line back with the page-load answer asked for before "Got it"', async () => {
		let release: (r: Response) => void = () => {};
		vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('/dismiss')
			? Promise.resolve(json({ ok: true }))
			: new Promise<Response>((r) => { release = r; })));
		const load = loadSettingsViewer();
		noteSettingsViewer({ viewer: 'owner', locks: {}, provider_reset: { from: 'Mistral' } });
		expect(await dismissProviderReset()).toBe(true);
		release(json({ viewer: 'owner', locks: {}, provider_reset: { from: 'Mistral' } }));
		await load;
		expect(providerResetNotice()).toBeNull();
	});

	it('asks anew after a provider save instead of sharing a request from before it', async () => {
		noteSettingsViewer({ viewer: 'owner', locks: {}, provider_reset: { from: 'Mistral' } });
		const releases: Array<(r: Response) => void> = [];
		const fetchMock = vi.fn(() => new Promise<Response>((r) => { releases.push(r); }));
		vi.stubGlobal('fetch', fetchMock);
		const before = refreshProviderReset();
		expect(refreshProviderReset(), 'two lines share a request').toBe(before);
		const after = refreshProviderReset(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		// The answer from before the save comes last and still names Mistral; the one after it is read.
		releases[1]!(json({ viewer: 'owner', locks: {}, provider_reset: null }));
		await after;
		expect(providerResetNotice()).toBeNull();
		releases[0]!(json({ viewer: 'owner', locks: {}, provider_reset: { from: 'Mistral' } }));
		await before;
		expect(providerResetNotice()).toBeNull();
	});
});
