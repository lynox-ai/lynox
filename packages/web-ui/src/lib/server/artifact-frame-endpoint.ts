import { ARTIFACT_POLICY } from '../utils/artifact-frame.js';
import { FRAME_PRINT_PARAM, FRAME_READY, FRAME_RENDER, FRAME_VERSION_PARAM } from '../utils/artifact-frame-protocol.js';

/**
 * The response of `/_artifact-frame`: one fixed bootstrap document under a policy that
 * sandboxes it.
 *
 * ## Why the sandbox is in the header
 *
 * An embedder's `sandbox` attribute is a request the embedder makes, and any markup that
 * reaches the app could embed this URL without one. The `sandbox` directive in the response's
 * own policy is applied by the browser to the document itself, so it has an opaque origin
 * however it is framed or opened: it cannot read the app's storage, cookies or DOM.
 *
 * ## Why nothing from the request reaches the body
 *
 * The URL is same-origin and public. Anything reflected into the body would be markup on the
 * app's origin that an outside page could choose. The body is a constant; the query only picks
 * the policy (print or frame) and the caching.
 */

/**
 * The bootstrap, as code. It runs inside the sandbox and is written against `window`,
 * `location` and `document` only, so a test can run it against stand-ins for all three.
 *
 * - Top level without an opener (someone opened the URL directly): it does nothing.
 * - It says `ready` to its parent (a frame) or opener (the print window), addressed to the
 *   app's origin, so a foreign opener never hears it.
 * - It takes exactly one `render`, and only from that window AND from the app's origin.
 *   `location.origin` is the URL's origin even inside the sandbox, and the source check alone
 *   does not cover a foreign page that opened this URL: it IS the opener.
 * - `document.open()` drops this script's listener with the rest of the document, so a second
 *   `render` finds nobody listening. The response's policy stays with the new document.
 */
export const ARTIFACT_FRAME_BOOTSTRAP =
	'(function(){'
	+ 'var t=window.parent!==window?window.parent:window.opener;'
	+ 'if(!t)return;'
	+ 'var done=false;'
	+ 'function on(e){'
	+ 'if(done||e.source!==t||e.origin!==location.origin)return;'
	+ 'var d=e.data;'
	+ `if(!d||d.type!==${JSON.stringify(FRAME_RENDER)}||typeof d.html!=="string")return;`
	+ 'done=true;'
	+ 'window.removeEventListener("message",on);'
	+ 'document.open();document.write(d.html);document.close();'
	+ '}'
	+ 'window.addEventListener("message",on);'
	+ `t.postMessage({type:${JSON.stringify(FRAME_READY)}},location.origin);`
	+ '})()';

const BODY = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>'
	+ `<script>${ARTIFACT_FRAME_BOOTSTRAP}</script></body></html>`;

/**
 * The endpoint's policy. `allow-modals` only for the print window, which has to open the print
 * dialog; a frame in a chat gets no dialogs. `frame-ancestors 'self'`: only the app may frame it.
 */
export function artifactFramePolicy(print: boolean): string {
	const sandbox = print ? 'sandbox allow-scripts allow-modals' : 'sandbox allow-scripts';
	return `${sandbox}; ${ARTIFACT_POLICY}; frame-ancestors 'self'`;
}

/**
 * Build the response for `url`. `buildSha` is this server's build: a request that carries it
 * as `v` may be cached for good, because the next build asks for a different URL, so a cached
 * bootstrap never meets a parent of another build. Without a build (local builds) or with
 * another value, it is not cached at all.
 */
export function artifactFrameResponse(url: URL, buildSha: string): Response {
	const print = url.searchParams.has(FRAME_PRINT_PARAM);
	const v = url.searchParams.get(FRAME_VERSION_PARAM);
	const cacheable = buildSha !== '' && v === buildSha;
	return new Response(BODY, {
		status: 200,
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Content-Security-Policy': artifactFramePolicy(print),
			'Cache-Control': cacheable ? 'public, max-age=31536000, immutable' : 'no-store',
		},
	});
}
