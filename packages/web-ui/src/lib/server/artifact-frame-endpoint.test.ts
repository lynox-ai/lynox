import { describe, it, expect } from 'vitest';
import { ARTIFACT_FRAME_BOOTSTRAP, artifactFramePolicy, artifactFrameResponse } from './artifact-frame-endpoint.js';
import { FRAME_KEY_FIELD, FRAME_READY, FRAME_RENDER } from '../utils/artifact-frame-protocol.js';
import { ARTIFACT_POLICY } from '../utils/artifact-frame.js';

const ORIGIN = 'https://app.example.test';
const BUILD = 'abc123';

function get(query: string, build = BUILD): Response {
	return artifactFrameResponse(new URL(`${ORIGIN}/_artifact-frame${query}`), build);
}

describe('the frame endpoint response', () => {
	it('sandboxes a frame with scripts only and keeps the artifact policy and same-origin framing', () => {
		const csp = get('').headers.get('Content-Security-Policy') ?? '';
		expect(csp.startsWith('sandbox allow-scripts;')).toBe(true);
		expect(csp).not.toContain('allow-modals');
		expect(csp).not.toContain('allow-same-origin');
		expect(csp).toContain(ARTIFACT_POLICY);
		expect(csp).toContain("connect-src 'none'");
		expect(csp.endsWith("frame-ancestors 'self'")).toBe(true);
	});

	it('allows images only from data: and blob:, never from another host, and no base or form target', () => {
		for (const print of [false, true]) {
			const csp = artifactFramePolicy(print);
			const directives = csp.split(';').map((d) => d.trim());
			const img = directives.filter((d) => d.startsWith('img-src'));
			expect(img).toEqual(['img-src data: blob:']);
			expect(csp).not.toMatch(/img-src[^;]*\*/);
			expect(csp).not.toMatch(/img-src[^;]*(https?:|'self')/);
			expect(directives).toContain("base-uri 'none'");
			expect(directives).toContain("form-action 'none'");
			// No directive that falls back to default-src opens images another way.
			expect(directives.find((d) => d.startsWith('default-src'))).toBe("default-src 'none'");
		}
		// The meta that travels with the document says the same.
		expect(ARTIFACT_POLICY).toContain('img-src data: blob:;');
		expect(ARTIFACT_POLICY).not.toContain('img-src *');
	});

	it('allows the print dialog only for the print window', () => {
		expect(get('?print').headers.get('Content-Security-Policy')).toBe(artifactFramePolicy(true));
		expect(artifactFramePolicy(true).startsWith('sandbox allow-scripts allow-modals;')).toBe(true);
		expect(artifactFramePolicy(false).startsWith('sandbox allow-scripts;')).toBe(true);
	});

	it('is cached for good under its own build and not cached otherwise', () => {
		expect(get(`?v=${BUILD}`).headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
		expect(get('?v=other').headers.get('Cache-Control')).toBe('no-store');
		expect(get('').headers.get('Cache-Control')).toBe('no-store');
		// A local build has no build id: even a matching empty value is not cached.
		expect(get('?v=', '').headers.get('Cache-Control')).toBe('no-store');
	});

	it('serves the same body whatever the query carries', async () => {
		const plain = await get('').text();
		const probe = '<img src=x onerror=alert(1)>';
		const withQuery = await get(`?print&v=${encodeURIComponent(probe)}&x=${encodeURIComponent(probe)}`).text();
		expect(withQuery).toBe(plain);
		expect(withQuery).not.toContain('onerror');
		expect(plain).toContain(ARTIFACT_FRAME_BOOTSTRAP);
		expect(get('').headers.get('Content-Type')).toBe('text/html; charset=utf-8');
	});
});

// ── The bootstrap, run against stand-ins for window, location and document ──

interface Posted { target: string; message: unknown; targetOrigin: string }

interface Harness {
	readonly posted: Posted[];
	readonly written: string[];
	readonly calls: string[];
	/** Deliver a message to the bootstrap's listener, if it has one. */
	deliver(e: { source: unknown; origin: string; data: unknown }): void;
	readonly listeners: () => number;
	readonly parent: object;
	readonly opener: object | null;
}

const KEY = 'a'.repeat(32);

function runBootstrap(shape: 'framed' | 'opened' | 'top', hash = `#${KEY}`): Harness {
	const posted: Posted[] = [];
	const written: string[] = [];
	const calls: string[] = [];
	let handlers: ((e: unknown) => void)[] = [];
	const other = (name: string): object => ({
		postMessage: (message: unknown, targetOrigin: string) => { posted.push({ target: name, message, targetOrigin }); },
	});
	const win: Record<string, unknown> = {
		addEventListener: (type: string, fn: (e: unknown) => void) => { if (type === 'message') handlers.push(fn); },
		removeEventListener: (type: string, fn: (e: unknown) => void) => { if (type === 'message') handlers = handlers.filter((h) => h !== fn); },
	};
	win['parent'] = shape === 'framed' ? other('parent') : win;
	win['opener'] = shape === 'opened' ? other('opener') : null;
	const doc = {
		open: () => { calls.push('open'); },
		write: (html: string) => { calls.push('write'); written.push(html); },
		close: () => { calls.push('close'); },
	};
	new Function('window', 'location', 'document', ARTIFACT_FRAME_BOOTSTRAP)(win, { origin: ORIGIN, hash }, doc);
	return {
		posted, written, calls,
		deliver: (e) => { for (const h of [...handlers]) h(e); },
		listeners: () => handlers.length,
		parent: win['parent'] as object,
		opener: win['opener'] as object | null,
	};
}

const render = (html: string): unknown => ({ type: FRAME_RENDER, html });

describe('the frame bootstrap', () => {
	it('does nothing when opened top-level without an opener', () => {
		let h: Harness | undefined;
		expect(() => { h = runBootstrap('top'); }).not.toThrow();
		if (h === undefined) throw new Error('the bootstrap did not run');
		expect(h.posted).toEqual([]);
		expect(h.listeners()).toBe(0);
	});

	it('says ready to its parent, addressed to the app origin, with the key from its URL fragment', () => {
		const h = runBootstrap('framed');
		expect(h.posted).toEqual([{ target: 'parent', message: { type: FRAME_READY, [FRAME_KEY_FIELD]: KEY }, targetOrigin: ORIGIN }]);
	});

	it('says ready to its opener when it is a top-level window someone opened, with the key', () => {
		const h = runBootstrap('opened');
		expect(h.posted).toEqual([{ target: 'opener', message: { type: FRAME_READY, [FRAME_KEY_FIELD]: KEY }, targetOrigin: ORIGIN }]);
	});

	it('sends an empty key when its URL has no fragment', () => {
		const h = runBootstrap('framed', '');
		expect(h.posted).toEqual([{ target: 'parent', message: { type: FRAME_READY, [FRAME_KEY_FIELD]: '' }, targetOrigin: ORIGIN }]);
	});

	it('reads the key once, so a later change of the fragment does not reach its ready', () => {
		// A location whose hash changes after its first read: the ready carries the first value.
		let reads = 0;
		const loc = { origin: ORIGIN, get hash(): string { reads++; return reads === 1 ? `#${KEY}` : '#changed'; } };
		const posted: unknown[] = [];
		const parent = { postMessage: (m: unknown) => { posted.push(m); } };
		const win = { parent, opener: null, addEventListener: () => {}, removeEventListener: () => {} };
		new Function('window', 'location', 'document', ARTIFACT_FRAME_BOOTSTRAP)(win, loc, {});
		expect(reads).toBe(1);
		expect(posted).toEqual([{ type: FRAME_READY, [FRAME_KEY_FIELD]: KEY }]);
	});

	it('writes the first render from its parent as the whole document and ignores a second one', () => {
		const h = runBootstrap('framed');
		h.deliver({ source: h.parent, origin: ORIGIN, data: render('<p>one</p>') });
		h.deliver({ source: h.parent, origin: ORIGIN, data: render('<p>two</p>') });
		expect(h.calls).toEqual(['open', 'write', 'close']);
		expect(h.written).toEqual(['<p>one</p>']);
		expect(h.listeners()).toBe(0);
	});

	it('ignores a render from a window that is not its parent', () => {
		const h = runBootstrap('framed');
		h.deliver({ source: {}, origin: ORIGIN, data: render('<p>x</p>') });
		expect(h.written).toEqual([]);
		expect(h.listeners()).toBe(1);
	});

	it('ignores a render from its opener when the opener is on another origin', () => {
		const h = runBootstrap('opened');
		h.deliver({ source: h.opener, origin: 'https://elsewhere.example', data: render('<p>x</p>') });
		expect(h.written).toEqual([]);
		h.deliver({ source: h.opener, origin: ORIGIN, data: render('<p>y</p>') });
		expect(h.written).toEqual(['<p>y</p>']);
	});

	it('ignores foreign messages from its parent and still takes the render after them', () => {
		const h = runBootstrap('framed');
		h.deliver({ source: h.parent, origin: ORIGIN, data: 'lynox-measure' });
		h.deliver({ source: h.parent, origin: ORIGIN, data: { type: FRAME_RENDER, html: 42 } });
		expect(h.written).toEqual([]);
		h.deliver({ source: h.parent, origin: ORIGIN, data: render('<p>z</p>') });
		expect(h.written).toEqual(['<p>z</p>']);
	});
});
