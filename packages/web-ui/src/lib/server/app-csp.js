// The app's page policy, in one place for its two users: `svelte.config.js` hands it to
// SvelteKit (`kit.csp`), which adds a per-response nonce to `script-src` for every page it
// renders, and `hooks.server.ts` serializes it as the fallback for HTML that SvelteKit does not
// render (a static error page, another endpoint). Plain JS with JSDoc types because
// `svelte.config.js` loads it in Node before any TypeScript is compiled.
//
// Why `script-src` is only 'self' (plus the nonce): an HTML injection that gets past the
// sanitizer must not run script. Inline script runs only with this response's nonce, which the
// injected markup cannot know. Artifacts, which do need inline script and CDNs, run in the
// sandboxed frame endpoint under that endpoint's own policy, so the app needs neither.

/** @typedef {Record<string, string[]>} CspDirectives */

/** @type {CspDirectives} */
export const APP_CSP_DIRECTIVES = {
	'default-src': ['self'],
	'script-src': ['self'],
	// Inline style attributes and Svelte's `style:` need 'unsafe-inline' here; that is a
	// separate question from script.
	'style-src': ['self', 'unsafe-inline', 'https://fonts.googleapis.com'],
	'img-src': ['self', 'data:', 'blob:'],
	'media-src': ['self', 'blob:'],
	'font-src': ['self', 'https://fonts.gstatic.com'],
	'connect-src': ['self'],
	'object-src': ['none'],
	// Only the frame endpoint is framed, and it is same-origin.
	'frame-src': ['self'],
	// No page of the app may be framed, by anyone; the frame endpoint sets its own value.
	'frame-ancestors': ['none'],
	'base-uri': ['self'],
	'form-action': ['self'],
};

/** Source keywords that a policy writes in single quotes. */
const KEYWORDS = new Set([
	'self', 'none', 'unsafe-inline', 'unsafe-eval', 'strict-dynamic', 'unsafe-hashes',
	'report-sample', 'wasm-unsafe-eval',
]);

/**
 * The directives as a header value, keywords quoted the way SvelteKit quotes them.
 * @param {CspDirectives} directives
 * @returns {string}
 */
export function serializeCsp(directives) {
	return Object.entries(directives)
		.map(([name, values]) => [name, ...values.map((v) => (KEYWORDS.has(v) || /^(nonce|sha\d{3})-/.test(v) ? `'${v}'` : v))].join(' '))
		.join('; ');
}

/** The fallback policy: the page policy without a nonce, so it allows no inline script at all. */
export const APP_FALLBACK_CSP = serializeCsp(APP_CSP_DIRECTIVES);
