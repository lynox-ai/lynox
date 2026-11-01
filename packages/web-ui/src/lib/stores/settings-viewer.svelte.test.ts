import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isOwnerSession, isMandateSession, isViewerUnavailable, loadSettingsViewer, resetSettingsViewer } from './settings-viewer.svelte.js';

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
