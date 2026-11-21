// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	answerFrameReady,
	artifactFrameFor,
	artifactFrameUrl,
	attachArtifactFrame,
	openArtifactPrintWindow,
} from './artifact-frame-host.js';
import { FRAME_READY, FRAME_RENDER } from './artifact-frame-protocol.js';

afterEach(() => {
	vi.restoreAllMocks();
	document.body.replaceChildren();
});

const READY = { type: FRAME_READY };

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
		expect(iframe.getAttribute('src')).toBe('/_artifact-frame');
		expect(iframe.hasAttribute('srcdoc')).toBe(false);
		expect(answerFrameReady({ data: READY, origin: 'null', source: iframe.contentWindow })).toBe(true);
		expect(sent).toEqual([{ type: FRAME_RENDER, html: '<p>doc</p>' }]);
	});

	it('gets nothing when its ready does not come from an opaque origin', () => {
		const { iframe, sent } = frame();
		attachArtifactFrame(iframe, '<p>doc</p>');
		expect(answerFrameReady({ data: READY, origin: 'http://localhost:3000', source: iframe.contentWindow })).toBe(false);
		expect(sent).toEqual([]);
	});

	it('is found by its window, and a frame nobody registered is not found and gets nothing', () => {
		const a = frame();
		const b = frame();
		attachArtifactFrame(a.iframe, '<p>a</p>');
		expect(artifactFrameFor(a.iframe.contentWindow)).toBe(a.iframe);
		expect(artifactFrameFor(b.iframe.contentWindow)).toBeNull();
		expect(answerFrameReady({ data: READY, origin: 'null', source: b.iframe.contentWindow })).toBe(false);
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
		iframe.setAttribute('src', '/_artifact-frame');
		card.appendChild(iframe);
		expect(answerFrameReady({ data: READY, origin: 'null', source: win })).toBe(false);
		expect(sent).toEqual([]);
	});

	it('keeps its document out of the DOM: no attribute of the frame carries it', () => {
		const { iframe } = frame();
		attachArtifactFrame(iframe, '<p>secret-doc</p>');
		expect(iframe.outerHTML).not.toContain('secret-doc');
	});

	it('gets its document again when it reloads and says ready again', () => {
		const { iframe, sent } = frame();
		attachArtifactFrame(iframe, '<p>doc</p>');
		answerFrameReady({ data: READY, origin: 'null', source: iframe.contentWindow });
		answerFrameReady({ data: READY, origin: 'null', source: iframe.contentWindow });
		expect(sent).toHaveLength(2);
	});
});

describe('the print window', () => {
	it('opens the endpoint in print mode in a fresh _blank window and gets its document once', () => {
		const sent: unknown[] = [];
		const popup = { postMessage: (m: unknown) => { sent.push(m); } } as unknown as Window;
		const open = vi.spyOn(window, 'open').mockReturnValue(popup);
		expect(openArtifactPrintWindow('<p>print</p>')).toBe(true);
		expect(open).toHaveBeenCalledWith('/_artifact-frame?print', '_blank');
		expect(answerFrameReady({ data: READY, origin: 'null', source: popup })).toBe(true);
		expect(answerFrameReady({ data: READY, origin: 'null', source: popup })).toBe(false);
		expect(sent).toEqual([{ type: FRAME_RENDER, html: '<p>print</p>' }]);
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
			vi.spyOn(window, 'open').mockReturnValue(popup);
			openArtifactPrintWindow('<p>print</p>');
			vi.advanceTimersByTime(60_001);
			expect(answerFrameReady({ data: READY, origin: 'null', source: popup })).toBe(false);
			expect(sent).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});
});
