/**
 * The app's side of the artifact frame protocol (see `artifact-frame-protocol.ts`).
 *
 * ## The content comes from memory, never from the DOM
 *
 * Every frame or print window the app opens is registered here with the document it should
 * show, keyed by its `Window`. When a `ready` arrives, the document is looked up by the
 * message's `source` and nothing else. Markup in a message (a mail, a chat reply) can create
 * elements that look like ours, with any class or `data-*` attribute, but it cannot create an
 * entry in this map, so it can never get a frame to render anything.
 *
 * A `WeakMap` keyed by the window: a frame's `WindowProxy` stays the same while it navigates
 * from `about:blank` to the endpoint, and a frame that is removed drops out with its window.
 *
 * ## Only to an opaque window
 *
 * The endpoint's own policy sandboxes it, so its `ready` arrives with origin `'null'`. A
 * `ready` from any other origin means the window is not the sandboxed endpoint (an older
 * server, a proxy that stripped the policy) and gets nothing.
 */
import {
	ARTIFACT_FRAME_PATH,
	FRAME_PRINT_PARAM,
	FRAME_READY,
	FRAME_RENDER,
	FRAME_VERSION_PARAM,
} from './artifact-frame-protocol.js';

interface FrameEntry {
	readonly html: string;
	/** The frame element, or null for the print window. */
	readonly iframe: HTMLIFrameElement | null;
	/** The print window gets its document once; a frame gets it again if it reloads. */
	readonly once: boolean;
}

const entries = new WeakMap<object, FrameEntry>();
let listening = false;

/** The build this bundle belongs to: the endpoint is cacheable per build under it. */
const BUILT_SHA: string = typeof __LYNOX_BUILD_SHA__ === 'string' ? __LYNOX_BUILD_SHA__ : '';

/** The endpoint URL, with the build as its cache key when there is one. */
export function artifactFrameUrl(print = false, buildSha: string = BUILT_SHA): string {
	const params: string[] = [];
	if (print) params.push(FRAME_PRINT_PARAM);
	if (buildSha) params.push(`${FRAME_VERSION_PARAM}=${encodeURIComponent(buildSha)}`);
	return params.length > 0 ? `${ARTIFACT_FRAME_PATH}?${params.join('&')}` : ARTIFACT_FRAME_PATH;
}

/**
 * Answer one `ready`: the registered document for its source, sent only to a sandboxed window.
 * Returns whether something was sent (for tests).
 */
export function answerFrameReady(e: Pick<MessageEvent, 'data' | 'origin' | 'source'>): boolean {
	const data: unknown = e.data;
	if (typeof data !== 'object' || data === null || (data as { type?: unknown }).type !== FRAME_READY) return false;
	const source = e.source;
	if (!source) return false;
	const entry = entries.get(source);
	if (!entry) return false;
	if (e.origin !== 'null') return false;
	if (entry.once) entries.delete(source);
	// '*' because an opaque origin cannot be named as a target; the window was checked above.
	(source as Window).postMessage({ type: FRAME_RENDER, html: entry.html }, '*');
	return true;
}

function listen(): void {
	if (listening) return;
	listening = true;
	window.addEventListener('message', (e) => { answerFrameReady(e); });
}

/**
 * Register a frame that is already in the document, then point it at the endpoint. The order
 * matters: registered first, so its `ready` can never arrive before its entry exists.
 */
export function attachArtifactFrame(iframe: HTMLIFrameElement, html: string): void {
	const win = iframe.contentWindow;
	if (!win) return;
	entries.set(win, { html, iframe, once: false });
	listen();
	// A frame moved into a new place already reloads its `src` on insertion; setting the same
	// value again would load it twice.
	const src = artifactFrameUrl();
	if (iframe.getAttribute('src') !== src) iframe.setAttribute('src', src);
}

/** The frame element whose window sent a message, if the app registered it. */
export function artifactFrameFor(source: MessageEventSource | null): HTMLIFrameElement | null {
	if (!source) return null;
	return entries.get(source)?.iframe ?? null;
}

/** How long the print window has to say `ready` before its entry is dropped. */
const PRINT_READY_MS = 60_000;

/**
 * Open the print window: a fresh `_blank` window on the endpoint (never a named one, which an
 * existing window could already hold), which gets `html` once it says `ready`. Not `noopener`:
 * the window needs its opener to say `ready` to. False when the popup was blocked.
 */
export function openArtifactPrintWindow(html: string): boolean {
	const win = window.open(artifactFrameUrl(true), '_blank');
	if (!win) return false;
	entries.set(win, { html, iframe: null, once: true });
	listen();
	// run-group-starter: a one-off cleanup in the browser, not engine code inside a run.
	setTimeout(() => { entries.delete(win); }, PRINT_READY_MS);
	return true;
}
