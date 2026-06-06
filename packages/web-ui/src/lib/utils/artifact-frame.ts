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
 * Script (string) injected into a fullscreen artifact preview iframe so a wide
 * fixed-width document (A4 contract ~794px, a 16:9 deck) fits the phone width
 * NATIVELY instead of clipping. It measures the content width and sets the
 * iframe's OWN viewport to `width=<cw>` + `initial-scale=dev/cw`, so mobile
 * Safari/Chrome lay it out fit-to-width with native pinch-zoom from there — no
 * parent transforms (paint-only, fragile on iOS). One-way (only widens, against
 * the stable device width) so it can't oscillate. The `</scr`+`ipt>` split keeps
 * the surrounding markup from terminating early.
 */
export const ARTIFACT_FIT_SCRIPT =
	'<scr' + 'ipt>(function(){var applied=0;function fit(){' +
	'var cw=Math.max(document.documentElement.scrollWidth,document.body?document.body.scrollWidth:0);' +
	'var dev=(window.screen&&window.screen.width)?window.screen.width:(window.innerWidth||390);' +
	'if(cw>dev+4&&cw!==applied){var m=document.querySelector("meta[name=viewport]");' +
	'if(!m){m=document.createElement("meta");m.setAttribute("name","viewport");(document.head||document.documentElement).appendChild(m);}' +
	'var s=dev/cw;m.setAttribute("content","width="+cw+",initial-scale="+s+",minimum-scale="+s);applied=cw;}}' +
	'window.addEventListener("load",function(){fit();setTimeout(fit,300);setTimeout(fit,1200);});fit();})()</scr' + 'ipt>';

/**
 * Build the srcdoc for a fullscreen artifact preview: inject `headExtra` (CSP +
 * a default viewport when the artifact lacks one) into <head>, and the
 * fit-to-width script before </body>. Pure string transform — DOM-free so it is
 * unit-testable. Handles a full document or a bare fragment.
 */
export function injectArtifactPreview(html: string, headExtra: string): string {
	const viewport = /name=["']viewport["']/i.test(html)
		? '' : '<meta name="viewport" content="width=device-width,initial-scale=1">';
	const head = `${headExtra}${viewport}`;
	let out = /<head[^>]*>/i.test(html)
		? html.replace(/<head[^>]*>/i, `$&${head}`)
		: `${head}${html}`;
	out = /<\/body>/i.test(out)
		? out.replace(/<\/body>/i, `${ARTIFACT_FIT_SCRIPT}</body>`)
		: `${out}${ARTIFACT_FIT_SCRIPT}`;
	return out;
}
