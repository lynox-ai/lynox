import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readable } from 'svelte/store';
import { answerFrameReady } from '../utils/artifact-frame-host.js';

// The gallery's preview frame: on the sandboxed frame endpoint, its document sent from memory to
// its own window only, and a new frame for a new version (the frame takes one document).

const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

vi.mock('$app/stores', () => ({ page: readable({ url: new URL('http://localhost/app/artifacts') }) }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
const shared: Blob[] = [];
const sharedNames: string[] = [];
vi.mock('../utils/save-blob.js', () => ({ saveOrShareBlob: vi.fn(async (blob: Blob, name: string) => { shared.push(blob); sharedNames.push(name); }) }));
vi.mock('./MarkdownRenderer.svelte', () => ({
	default: (anchor: Comment) => { anchor.before(document.createElement('div')); },
}));

const META = {
	id: 'cccccccc',
	title: 'Deck',
	description: '',
	createdAt: '2026-10-09T19:34:00.000Z',
	updatedAt: '2026-10-09T19:34:00.000Z',
	threadId: 't',
};

let version = 1;
let artifactType = 'html';
let artifactContent: string | null = null;
let target: HTMLElement;
let component: Record<string, unknown> | undefined;

beforeEach(() => {
	version = 1;
	artifactType = 'html';
	artifactContent = null;
	vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockImplementation(function (this: HTMLIFrameElement) {
		return windowOf(this);
	});
	target = document.createElement('div');
	document.body.appendChild(target);
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const u = String(url);
		const body = u.endsWith('/artifacts')
			? { artifacts: [{ ...META, type: artifactType, version }] }
			: { ...META, type: artifactType, version, content: artifactContent ?? `<p>version-${version}</p>` };
		return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
	}));
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

function previewFrame(): HTMLIFrameElement {
	const f = document.querySelector<HTMLIFrameElement>('[role="dialog"] iframe');
	if (!f) throw new Error('no preview frame');
	return f;
}

// Each frame gets one stand-in window for its whole life, as a browser's WindowProxy stays the
// same while the frame navigates (jsdom swaps the window when `src` loads). It records what it
// is sent.
const sentTo = new WeakMap<object, unknown[]>();
const windows = new WeakMap<HTMLIFrameElement, Window>();
function windowOf(f: HTMLIFrameElement): Window {
	let w = windows.get(f);
	if (!w) {
		const sent: unknown[] = [];
		w = { postMessage: (m: unknown) => { sent.push(m); } } as unknown as Window;
		sentTo.set(w, sent);
		windows.set(f, w);
	}
	return w;
}

/** The key the app put in the fragment of the frame's URL. */
function keyOf(f: HTMLIFrameElement): string {
	return (f.getAttribute('src') ?? '').split('#')[1] ?? '';
}

/**
 * What the frame's window is sent when `source` says ready from an opaque origin, naming `key`
 * (by default the frame's own, as the endpoint the app loaded there does; null sends no key).
 */
function documentSentTo(f: HTMLIFrameElement, source: Window = windowOf(f), key: string | null = keyOf(f)): unknown[] {
	const data: Record<string, unknown> = { type: 'lynox-frame-ready' };
	if (key !== null) data['key'] = key;
	answerFrameReady({ data, origin: 'null', source });
	return sentTo.get(windowOf(f)) ?? [];
}

async function openDeck(): Promise<void> {
	const { default: ArtifactsView } = await import('./ArtifactsView.svelte');
	component = mount(ArtifactsView, { target });
	await settle();
	const card = [...target.querySelectorAll('h3')].find((el) => el.textContent === 'Deck')?.closest('[role="button"]');
	(card as HTMLElement).click();
	await settle();
}

describe('the gallery preview frame', () => {
	it('exports an html artifact with the artifact policy in the file', async () => {
		shared.length = 0;
		await openDeck();
		const share = [...target.querySelectorAll('button')].find((b) => /share|teilen/i.test(b.textContent ?? ''));
		expect(share, 'no share button').toBeDefined();
		share!.click();
		await settle();
		expect(shared).toHaveLength(1);
		const file = await shared[0]!.text();
		expect(file).toContain('<p>version-1</p>');
		expect(file).toMatch(/<meta http-equiv="Content-Security-Policy" content="[^"]*img-src data: blob:/);
	});

	it('exports an svg artifact as an svg file without its remote image and keeps the drawing', async () => {
		shared.length = 0;
		sharedNames.length = 0;
		artifactType = 'svg';
		artifactContent = '<svg xmlns="http://www.w3.org/2000/svg"><circle id="dot" r="4"/><image href="https://elsewhere.example/x.png" width="9" height="9"/></svg>';
		await openDeck();
		const share = [...target.querySelectorAll('button')].find((b) => /share|teilen/i.test(b.textContent ?? ''));
		share!.click();
		await settle();
		expect(shared).toHaveLength(1);
		expect(shared[0]!.type).toBe('image/svg+xml');
		expect(sharedNames).toEqual(['deck.svg']);
		const file = await shared[0]!.text();
		expect(file).toContain('<circle id="dot" r="4"/>');
		expect(file).not.toContain('elsewhere.example');
	});

	it('exports an svg artifact that is not well-formed as a well-formed svg file without its remote image', async () => {
		shared.length = 0;
		sharedNames.length = 0;
		artifactType = 'svg';
		artifactContent = '<svg viewBox="0 0 9 9"><circle r="2"><image href="https://elsewhere.example/x.png"/><g></svg>';
		await openDeck();
		const share = [...target.querySelectorAll('button')].find((b) => /share|teilen/i.test(b.textContent ?? ''));
		share!.click();
		await settle();
		expect(shared).toHaveLength(1);
		expect(shared[0]!.type).toBe('image/svg+xml');
		const file = await shared[0]!.text();
		const doc = new DOMParser().parseFromString(file, 'image/svg+xml');
		expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
		expect(doc.querySelector('circle')?.getAttribute('r')).toBe('2');
		expect(file).not.toContain('elsewhere.example');
	});

	it('exports an svg artifact with no svg in it as plain text', async () => {
		shared.length = 0;
		sharedNames.length = 0;
		artifactType = 'svg';
		artifactContent = '<p>no drawing</p><img src="https://elsewhere.example/x.png">';
		await openDeck();
		const share = [...target.querySelectorAll('button')].find((b) => /share|teilen/i.test(b.textContent ?? ''));
		share!.click();
		await settle();
		expect(shared).toHaveLength(1);
		expect(shared[0]!.type).toBe('text/plain');
		expect(sharedNames).toEqual(['deck.txt']);
		expect(await shared[0]!.text()).toBe(artifactContent);
	});

	it('loads the endpoint with no srcdoc and is sent the artifact when its own window is ready', async () => {
		await openDeck();
		const f = previewFrame();
		expect(f.getAttribute('src')).toMatch(/^\/_artifact-frame#[0-9a-f]{32}$/);
		expect(f.hasAttribute('srcdoc')).toBe(false);
		expect(f.getAttribute('sandbox')).toBe('allow-scripts');
		const sent = documentSentTo(f) as { type: string; html: string }[];
		expect(sent).toHaveLength(1);
		expect(sent[0]!.type).toBe('lynox-frame-render');
		expect(sent[0]!.html).toContain('<p>version-1</p>');
	});

	it('sends nothing for a ready from its own window that does not name its key', async () => {
		await openDeck();
		const f = previewFrame();
		expect(documentSentTo(f, windowOf(f), null)).toEqual([]);
		expect(documentSentTo(f, windowOf(f), '0'.repeat(32))).toEqual([]);
		// Control: the same window with its key.
		expect(documentSentTo(f)).toHaveLength(1);
	});

	it('sends nothing for a ready that comes from another window', async () => {
		await openDeck();
		const f = previewFrame();
		const stranger = document.createElement('iframe');
		document.body.appendChild(stranger);
		expect(documentSentTo(f, windowOf(stranger))).toEqual([]);
		expect(sentTo.get(windowOf(stranger)) ?? []).toEqual([]);
		stranger.remove();
	});

	it('builds a new frame for a new version, and the new frame gets the new version', async () => {
		await openDeck();
		const first = previewFrame();
		version = 2;
		const { loadArtifacts } = await import('../stores/artifacts.svelte.js');
		await loadArtifacts();
		await settle();
		const second = previewFrame();
		expect(second).not.toBe(first);
		const sent = documentSentTo(second) as { html: string }[];
		expect(sent).toHaveLength(1);
		expect(sent[0]!.html).toContain('<p>version-2</p>');
	});
});
