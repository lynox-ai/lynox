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

const VIEWPORT_HEIGHT_UNIT = /100(?:vh|dvh|svh|lvh)/i;

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
