// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	answerFrameReady,
	artifactFrameFor,
	artifactFrameUrl,
	attachArtifactFrame,
	openArtifactPrintWindow,
} from './artifact-frame-host.js';
import { FRAME_KEY_FIELD, FRAME_READY, FRAME_RENDER } from './artifact-frame-protocol.js';

afterEach(() => {
	vi.restoreAllMocks();
	document.body.replaceChildren();
});

/** A `ready` that names `key`. */
const ready = (key: string): Record<string, unknown> => ({ type: FRAME_READY, [FRAME_KEY_FIELD]: key });

/** The key the app put in the fragment of a frame or print window URL. */
function keyIn(url: string | null): string {
	const hash = (url ?? '').split('#')[1];
	if (hash === undefined) throw new Error(`no key in ${String(url)}`);
	return hash;
}
const keyOf = (iframe: HTMLIFrameElement): string => keyIn(iframe.getAttribute('src'));

/**
 * A frame in the document whose window records what it is sent. The window is a stand-in that
 * stays the same object for the frame's life: that is what a browser's WindowProxy does while
 * the frame navigates, where jsdom swaps the window when `src` loads.
 */
function frame(): { iframe: HTMLIFrameElement; sent: unknown[] } {
	const iframe = document.createElement('iframe');
	const sent: unknown[] = [];
	const win = { postMessage: (m: unknown) => { sent.push(m); } } as unknown as Window;
	Object.defineProperty(iframe, 'contentWindow', { get: () => win });
	document.body.appendChild(iframe);
	return { iframe, sent };
}

describe('the frame endpoint URL', () => {
	it('carries the build as its cache key and the print flag for the print window', () => {
		expect(artifactFrameUrl(false, '')).toBe('/_artifact-frame');
		expect(artifactFrameUrl(false, 'abc')).toBe('/_artifact-frame?v=abc');
		expect(artifactFrameUrl(true, 'abc')).toBe('/_artifact-frame?print&v=abc');
	});
});

describe('a registered frame', () => {
	it('points at the endpoint and gets its document when its own window says ready from the sandbox', () => {
		const { iframe, sent } = frame();
		attachArtifactFrame(iframe, '<p>doc</p>');
		expect(iframe.getAttribute('src')).toMatch(/^\/_artifact-frame#[0-9a-f]{32}$/);
		expect(iframe.hasAttribute('srcdoc')).toBe(false);
		expect(answerFrameReady({ data: ready(keyOf(iframe)), origin: 'null', source: iframe.contentWindow })).toBe(true);
		expect(sent).toEqual([{ type: FRAME_RENDER, html: '<p>doc</p>' }]);
	});

	it('gets nothing for a ready from its own window without the key, with a wrong key or with another frame\'s key', () => {
		const { iframe, sent } = frame();
		const other = frame();
		attachArtifactFrame(iframe, '<p>doc</p>');
		attachArtifactFrame(other.iframe, '<p>other</p>');
		const source = iframe.contentWindow;
		expect(keyOf(iframe)).not.toBe(keyOf(other.iframe));
		expect(answerFrameReady({ data: { type: FRAME_READY }, origin: 'null', source })).toBe(false);
		expect(answerFrameReady({ data: ready(''), origin: 'null', source })).toBe(false);
		expect(answerFrameReady({ data: ready('0'.repeat(32)), origin: 'null', source })).toBe(false);
		expect(answerFrameReady({ data: { type: FRAME_READY, [FRAME_KEY_FIELD]: [keyOf(iframe)] }, origin: 'null', source })).toBe(false);
		expect(answerFrameReady({ data: ready(keyOf(other.iframe)), origin: 'null', source })).toBe(false);
		expect(sent).toEqual([]);
		expect(other.sent).toEqual([]);
		// Control: the same window with its own key.
		expect(answerFrameReady({ data: ready(keyOf(iframe)), origin: 'null', source })).toBe(true);
		expect(sent).toEqual([{ type: FRAME_RENDER, html: '<p>doc</p>' }]);
	});

	it('keeps its src and key when it is attached again with the same document, and gets a new key for a new one', () => {
		const { iframe } = frame();
		attachArtifactFrame(iframe, '<p>doc</p>');
		const src = iframe.getAttribute('src');
		const set = vi.spyOn(iframe, 'setAttribute');
		attachArtifactFrame(iframe, '<p>doc</p>');
		expect(iframe.getAttribute('src')).toBe(src);
		expect(set).not.toHaveBeenCalled();
		attachArtifactFrame(iframe, '<p>new</p>');
		expect(iframe.getAttribute('src')).not.toBe(src);
		expect(keyOf(iframe)).not.toBe(keyIn(src));
	});

	it('keeps its key when it is moved and gets a new window, and only the new window is answered with it', () => {
		const iframe = document.createElement('iframe');
		const sentA: unknown[] = [];
		const sentB: unknown[] = [];
		const a = { postMessage: (m: unknown) => { sentA.push(m); } } as unknown as Window;
		const b = { postMessage: (m: unknown) => { sentB.push(m); } } as unknown as Window;
		let win = a;
		Object.defineProperty(iframe, 'contentWindow', { get: () => win });
		document.body.appendChild(iframe);
		attachArtifactFrame(iframe, '<p>doc</p>');
		const src = iframe.getAttribute('src');
		win = b;
		attachArtifactFrame(iframe, '<p>doc</p>');
		expect(iframe.getAttribute('src')).toBe(src);
		expect(answerFrameReady({ data: ready(keyOf(iframe)), origin: 'null', source: b })).toBe(true);
		expect(sentB).toEqual([{ type: FRAME_RENDER, html: '<p>doc</p>' }]);
		expect(sentA).toEqual([]);
	});

	it('gets nothing when its ready does not come from an opaque origin', () => {
		const { iframe, sent } = frame();
		attachArtifactFrame(iframe, '<p>doc</p>');
		expect(answerFrameReady({ data: ready(keyOf(iframe)), origin: 'http://localhost:3000', source: iframe.contentWindow })).toBe(false);
		expect(sent).toEqual([]);
	});

	it('is found by its window, and a frame nobody registered is not found and gets nothing', () => {
		const a = frame();
		const b = frame();
		attachArtifactFrame(a.iframe, '<p>a</p>');
		expect(artifactFrameFor(a.iframe.contentWindow)).toBe(a.iframe);
		expect(artifactFrameFor(b.iframe.contentWindow)).toBeNull();
		expect(answerFrameReady({ data: ready(keyOf(a.iframe)), origin: 'null', source: b.iframe.contentWindow })).toBe(false);
		expect(b.sent).toEqual([]);
	});

	it('sends nothing to an unregistered frame inside markup that carries a document in data-html', () => {
		// The shape message markup can take: a card-like container with a `data-html` payload and
		// a frame on the endpoint. Only the registry decides what a frame gets, never the DOM.
		const card = document.createElement('div');
		card.className = 'artifact-container';
		card.dataset['html'] = btoa('<p>forged</p>');
		document.body.appendChild(card);
		const iframe = document.createElement('iframe');
		const sent: unknown[] = [];
		const win = { postMessage: (m: unknown) => { sent.push(m); } } as unknown as Window;
		Object.defineProperty(iframe, 'contentWindow', { get: () => win });
		iframe.className = 'artifact-frame';
		iframe.setAttribute('src', '/_artifact-frame#forged');
		card.appendChild(iframe);
		expect(answerFrameReady({ data: ready('forged'), origin: 'null', source: win })).toBe(false);
		expect(sent).toEqual([]);
	});

	it('keeps its document out of the DOM: no attribute of the frame carries it', () => {
		const { iframe } = frame();
		attachArtifactFrame(iframe, '<p>secret-doc</p>');
		expect(iframe.outerHTML).not.toContain('secret-doc');
	});

	it('gets its document again when the endpoint reloads at the same URL and says ready with the same key', () => {
		const { iframe, sent } = frame();
		attachArtifactFrame(iframe, '<p>doc</p>');
		const key = keyOf(iframe);
		expect(answerFrameReady({ data: ready(key), origin: 'null', source: iframe.contentWindow })).toBe(true);
		expect(answerFrameReady({ data: ready(key), origin: 'null', source: iframe.contentWindow })).toBe(true);
		expect(sent).toEqual([{ type: FRAME_RENDER, html: '<p>doc</p>' }, { type: FRAME_RENDER, html: '<p>doc</p>' }]);
	});
});

describe('the print window', () => {
	it('opens the endpoint in print mode in a fresh _blank window and gets its document once', () => {
		const sent: unknown[] = [];
		const popup = { postMessage: (m: unknown) => { sent.push(m); } } as unknown as Window;
		const open = vi.spyOn(window, 'open').mockReturnValue(popup);
		expect(openArtifactPrintWindow('<p>print</p>')).toBe(true);
		expect(open).toHaveBeenCalledWith(expect.stringMatching(/^\/_artifact-frame\?print#[0-9a-f]{32}$/), '_blank');
		const key = keyIn(open.mock.calls[0]![0] as string);
		expect(answerFrameReady({ data: ready(key), origin: 'null', source: popup })).toBe(true);
		expect(answerFrameReady({ data: ready(key), origin: 'null', source: popup })).toBe(false);
		expect(sent).toEqual([{ type: FRAME_RENDER, html: '<p>print</p>' }]);
	});

	it('gets nothing for a ready without its key, and a wrong key does not use up its one answer', () => {
		const sent: unknown[] = [];
		const popup = { postMessage: (m: unknown) => { sent.push(m); } } as unknown as Window;
		const open = vi.spyOn(window, 'open').mockReturnValue(popup);
		openArtifactPrintWindow('<p>print</p>');
		const key = keyIn(open.mock.calls[0]![0] as string);
		expect(answerFrameReady({ data: { type: FRAME_READY }, origin: 'null', source: popup })).toBe(false);
		expect(answerFrameReady({ data: ready('f'.repeat(32)), origin: 'null', source: popup })).toBe(false);
		expect(sent).toEqual([]);
		expect(answerFrameReady({ data: ready(key), origin: 'null', source: popup })).toBe(true);
		expect(sent).toEqual([{ type: FRAME_RENDER, html: '<p>print</p>' }]);
	});

	it('gets a fresh key every time it opens', () => {
		const popup = { postMessage: () => {} } as unknown as Window;
		const open = vi.spyOn(window, 'open').mockReturnValue(popup);
		openArtifactPrintWindow('<p>a</p>');
		openArtifactPrintWindow('<p>b</p>');
		expect(keyIn(open.mock.calls[0]![0] as string)).not.toBe(keyIn(open.mock.calls[1]![0] as string));
	});

	it('reports a blocked popup', () => {
		vi.spyOn(window, 'open').mockReturnValue(null);
		expect(openArtifactPrintWindow('<p>print</p>')).toBe(false);
	});

	it('drops its document if the window never says ready', () => {
		vi.useFakeTimers();
		try {
			const sent: unknown[] = [];
			const popup = { postMessage: (m: unknown) => { sent.push(m); } } as unknown as Window;
			const open = vi.spyOn(window, 'open').mockReturnValue(popup);
			openArtifactPrintWindow('<p>print</p>');
			vi.advanceTimersByTime(60_001);
			expect(answerFrameReady({ data: ready(keyIn(open.mock.calls[0]![0] as string)), origin: 'null', source: popup })).toBe(false);
			expect(sent).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});
});
