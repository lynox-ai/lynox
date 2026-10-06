/**
 * Sizing helpers for HTML artifact iframes.
 *
 * A 100vh/dvh slide-deck artifact pins its content to the viewport (absolute /
 * overflow-hidden), so `document.documentElement.scrollHeight` collapses and the
 * old `Math.max(h, 200)` clamped the frame to a 200px sliver. We detect that case
 * and size the frame by the standard 16:9 deck ratio instead.
 *
 * `isViewportDeck` is the spec mirrored (inlined, sandbox-isolated) by the
 * RESIZE_SCRIPT injected into the iframe in MarkdownRenderer.svelte — keep the
 * regex + the `scrollHeight <= viewport` guard in sync with that string.
 */

// Anchored so a longer number ending in `100vh` (e.g. `1100vh`) doesn't match —
// the leading `[^\d.]` rejects a preceding digit/decimal, `\b` the trailing unit.
// Mirror of the inline regex in MarkdownRenderer.svelte's RESIZE_SCRIPT.
const VIEWPORT_HEIGHT_UNIT = /(?:^|[^\d.])100(?:vh|dvh|svh|lvh)\b/i;

/**
 * True when the iframe content is a viewport-pinned deck: it declares a
 * viewport-height unit AND its scrollHeight stays within the current viewport.
 * A long `min-height:100vh` page that actually flows tall reports a large
 * scrollHeight → not a deck → the caller keeps measured-height sizing.
 */
export function isViewportDeck(
	styleText: string,
	scrollHeight: number,
	viewportHeight: number,
): boolean {
	if (!VIEWPORT_HEIGHT_UNIT.test(styleText)) return false;
	if (viewportHeight <= 0) return false;
	return scrollHeight <= viewportHeight + 8;
}

/**
 * Height (px) for a detected deck frame: the 16:9 ratio of its rendered width,
 * floored so it stays a usable slide and capped at 85% of the viewport so it
 * never overflows the chat pane.
 */
export function deckFrameHeight(width: number, viewportHeight: number): number {
	const w = width > 0 ? width : 640;
	const aspect = Math.round((w * 9) / 16);
	const ceil = Math.round((viewportHeight > 0 ? viewportHeight : 800) * 0.85);
	return Math.min(Math.max(aspect, 360), ceil);
}

/**
 * CSS `zoom` factor to fit a wide artifact document to the fullscreen frame
 * width, or `null` when it already fits (no scaling needed). Used so an
 * A4-print HTML artifact (fixed ~794px wide) scales down to be fully visible on
 * a narrow phone instead of being clipped off-screen. A 4px slack avoids
 * zooming for sub-pixel overflow.
 */
export function computeFitZoom(contentWidth: number, frameWidth: number): number | null {
	if (!(contentWidth > 0) || !(frameWidth > 0)) return null;
	if (contentWidth <= frameWidth + 4) return null;
	return frameWidth / contentWidth;
}

/**
 * The inline-style fields the fit-to-width transform OWNS on a fullscreen frame.
 * Deliberately excludes `height`: the frame's height is the measured content
 * height set by the resize-message handler (the scrolling fullscreen container
 * needs an explicit frame height, `flex:none`). A plain object satisfies this so
 * the reset is unit-testable without a DOM.
 */
export interface ArtifactFitStyle {
	width: string;
	transform: string;
	transformOrigin: string;
	marginRight: string;
	marginBottom: string;
}

/**
 * Revert ONLY the fit-to-width styles applyFullscreenFit may have set (width
 * override + transform + the negative margins that pull back the scaled box).
 * It must NOT touch `height`: clearing the resize-handler-owned height collapsed
 * the frame to the iframe default (150px), so a "content already fits the
 * fullscreen width" doc rendered as a thin clipped strip instead of the full
 * page. Idempotent — safe on collapse, on ESC, and on the no-fit branch.
 */
export function clearArtifactFitStyles(style: ArtifactFitStyle): void {
	style.width = '';
	style.transform = '';
	style.transformOrigin = '';
	style.marginRight = '';
	style.marginBottom = '';
}

/**
 * Script (string) injected into a fullscreen artifact preview iframe so a wide
 * fixed-width document (A4 contract ~794px, a 16:9 deck) fits the phone width
 * NATIVELY instead of clipping. It measures the content width and sets the
 * iframe's OWN viewport to `width=<cw>` + `initial-scale=dev/cw`, so mobile
 * Safari/Chrome lay it out fit-to-width with native pinch-zoom from there — no
 * parent transforms (paint-only, fragile on iOS). One-way (only widens, against
 * the stable device width) so it can't oscillate. The `</scr`+`ipt>` split keeps
 * the surrounding markup from terminating early.
 */
export const ARTIFACT_FIT_CODE =
	'(function(){var applied=0;function fit(){' +
	'var cw=Math.max(document.documentElement.scrollWidth,document.body?document.body.scrollWidth:0);' +
	'var dev=(window.screen&&window.screen.width)?window.screen.width:(window.innerWidth||390);' +
	'if(cw>dev+4&&cw!==applied){var m=document.querySelector("meta[name=viewport]");' +
	'if(!m){m=document.createElement("meta");m.setAttribute("name","viewport");(document.head||document.documentElement).appendChild(m);}' +
	'var s=dev/cw;m.setAttribute("content","width="+cw+",initial-scale="+s+",minimum-scale="+s);applied=cw;}}' +
	'window.addEventListener("load",function(){fit();setTimeout(fit,300);setTimeout(fit,1200);});fit();})()';

/**
 * The same script as a markup string, for the one caller that still needs a
 * tag. ⚠ ONE OWNER: the code lives in `ARTIFACT_FIT_CODE` and this is derived
 * from it, because the two had to stay in sync by hand otherwise and a test
 * that writes a value itself cannot see the two sides diverge.
 */
export const ARTIFACT_FIT_SCRIPT = '<scr' + 'ipt>' + ARTIFACT_FIT_CODE + '</scr' + 'ipt>';

/**
 * Put the frame's own additions into an artifact document: `headHtml` FIRST in
 * `<head>`, `scriptCode` LAST in `<body>`.
 *
 * ## Why this parses instead of pattern-matching
 *
 * Both halves used to be regex replacements over the artifact's own markup, and
 * the artifact author controls that markup completely. `/<head[^>]*>/` does not
 * fail to match on `<head data-x="a>b">` — it matches TRUNCATED, up to the raw
 * `>` inside the attribute value. The insertion then lands INSIDE the attribute.
 *
 * Measured in Chrome through a real `srcdoc` iframe: with that payload the CSP
 * meta is not an element at all (`document.querySelectorAll('meta[http-equiv]')`
 * → 0) and `document.head.getAttributeNames()` returns
 * `data-x | content-security-policy" | content` — the policy became ATTRIBUTES
 * ON THE HEAD TAG. The same measurement with the meta intact gives 1 element and
 * the policy enforced: a `fetch` from inside the frame never reaches the server
 * (`connect-src 'none'`, confirmed in the server's own request log), where
 * without it the request arrives.
 *
 * ⚠ The in-page error is NOT the instrument for that. `fetch` reports a
 * TypeError either way — with the policy because it is blocked, without it
 * because CORS refuses the RESPONSE while the request has already gone out.
 * Exfiltration does not need the response. The server log is the property.
 *
 * The `</body>` half had the same shape: a string `.replace` takes the FIRST
 * occurrence, so a `</body>` inside an attribute won.
 *
 * ## Why a FRAGMENT does not go through the parser
 *
 * Because the two parsers disagree exactly there, and in the dangerous
 * direction for a test. `DOMParser` in a browser always yields html/head/body
 * for `text/html`; `linkedom`, which is what this package's tests have,
 * measured on `<div>frag</div>`, makes the DIV the `documentElement` and then
 * nests a synthesised head and body INSIDE it, dropping the fragment's own
 * content. A test written on that would have shown mangled output for a shape
 * the browser handles correctly — and the repair would have gone into the
 * production code. A fragment has no tag to match into anyway, so it is wrapped
 * without a parse and both engines agree.
 *
 * The predicate's errors are both safe, which is why it may be a regex: a false
 * positive (the text `<head ` inside an attribute) only means we parse, and a
 * false negative means there was no document tag to insert into.
 */
export function injectIntoArtifactFrame(html: string, headHtml: string, scriptCode: string): string {
	if (!HAS_DOCUMENT_TAG.test(html)) {
		// ⚠ `headHtml` and `scriptCode` are interpolated as markup here, so both
		// MUST be frame-owned constants — never artifact content. The parsed
		// branch below is immune to that; this one is not.
		return `<!DOCTYPE html><html><head>${headHtml}</head><body>${html}<scr` + `ipt>${scriptCode}</scr` + `ipt></body></html>`;
	}
	const doc = new DOMParser().parseFromString(html, 'text/html');
	// A template so `headHtml` can carry several elements and still arrive as
	// NODES rather than as text.
	//
	// ⚠ This used to copy the child list first (`...[...childNodes]`) with a
	// comment saying the live list would shift during the move. A mutation round
	// removed the copy and nothing failed, over a `headHtml` carrying two
	// elements — because a spread argument list is built COMPLETELY before the
	// call runs, so `prepend` never sees the list change. The comment was wrong
	// and the copy was redundant; both are gone rather than pinned by a test.
	const holder = doc.createElement('template');
	holder.innerHTML = headHtml;
	doc.head.prepend(...holder.content.childNodes);
	const script = doc.createElement('script');
	script.textContent = scriptCode;
	doc.body.appendChild(script);
	return `<!DOCTYPE html>${doc.documentElement.outerHTML}`;
}

/** Does this markup bring a document tag we would have to insert INTO? */
const HAS_DOCUMENT_TAG = /<(?:html|head|body)[\s>]/i;

/**
 * Build the srcdoc for a fullscreen artifact preview: `headExtra` (CSP + a
 * default viewport when the artifact lacks one) first in `<head>`, and the
 * fit-to-width script last in `<body>`.
 *
 * ⚠ This docstring used to say "Pure string transform — DOM-free so it is
 * unit-testable", and that sentence was the reason it was a string transform.
 * It is also how the defect above survived: a justification for the cheap shape,
 * stated once and never measured against what it cost.
 */
export function injectArtifactPreview(html: string, headExtra: string): string {
	const viewport = /name=["']viewport["']/i.test(html)
		? '' : '<meta name="viewport" content="width=device-width,initial-scale=1">';
	return injectIntoArtifactFrame(html, `${headExtra}${viewport}`, ARTIFACT_FIT_CODE);
}
