/**
 * Sizing helpers for HTML artifact iframes.
 *
 * A 100vh/dvh slide-deck artifact pins its content to the viewport (absolute /
 * overflow-hidden), so `document.documentElement.scrollHeight` collapses and the
 * old `Math.max(h, 200)` clamped the frame to a 200px sliver. We detect that case
 * and size the frame by the standard 16:9 deck ratio instead.
 *
 * `isViewportDeck` is the spec mirrored (inlined, sandbox-isolated) by the
 * resize script injected into the iframe (`RESIZE_CODE` in
 * MarkdownRenderer.svelte, renamed from `RESIZE_SCRIPT` when it stopped being a
 * markup string) — keep the regex + the `scrollHeight <= viewport` guard in sync
 * with it.
 */

// Anchored so a longer number ending in `100vh` (e.g. `1100vh`) doesn't match —
// the leading `[^\d.]` rejects a preceding digit/decimal, `\b` the trailing unit.
// Mirror of the inline regex in MarkdownRenderer.svelte's RESIZE_CODE.
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
 * the stable device width) so it can't oscillate.
 *
 * It is CODE, not markup: it goes in as a `script` element's `textContent`, so
 * the `</scr` + `ipt>` split this constant used to carry is gone. (That sentence
 * stayed here for one commit after the split was removed, describing a symbol
 * that no longer existed.)
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
 * The policy every artifact frame gets. ONE OWNER, and that is the point.
 *
 * It used to be a `CSP_META` constant in `MarkdownRenderer.svelte` AND another
 * in `ArtifactsView.svelte`, and the two had already drifted: the bubble's said
 * `default-src 'none'`, the gallery's `default-src 'unsafe-inline'`, everything
 * else byte-identical. Measured in Chrome via the browser's own
 * `securitypolicyviolation` events, both produced the IDENTICAL violation set
 * (`frame-src`, `media-src` ×2, `object-src`) because every fetch directive that
 * falls back to `default-src` is blocked either way and the inline-capable ones
 * are set explicitly. So unifying on `'none'` is de-duplication, not tightening
 * — which is why it is safe to do in the same change.
 *
 * `img-src *` is deliberate: artifacts legitimately show remote images — a logo,
 * a diagram, a map, a picture in a report — and narrowing it is a product
 * decision about what an artifact may display, not a change this module makes on
 * its own.
 */
/** The frame's default viewport, for the branch that cannot query a document. */
const VIEWPORT_META = '<meta name="viewport" content="width=device-width,initial-scale=1">';

export const ARTIFACT_CSP =
	'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; ' +
	'script-src \'unsafe-inline\' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com; ' +
	'style-src \'unsafe-inline\' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://fonts.googleapis.com; ' +
	'font-src https://fonts.gstatic.com; img-src * data: blob:; connect-src \'none\'">';

/**
 * Does this markup bring its own document structure?
 *
 * ONE predicate for TWO decisions that used to be made separately: whether to
 * parse or to wrap, and which head content the artifact gets. They disagreed —
 * `MarkdownRenderer` asked `clean.includes('<html')` for the head choice while
 * this module asked for a document TAG — so `<body>x</body>` got the fragment's
 * default styling inside a parsed document, and `<htmlx>x</htmlx>` got the
 * document head (no charset, no default styling) inside a wrapper we built. Two
 * predicates for one question is two answers.
 *
 * Its errors are both safe, which is why a regex is enough: a false positive
 * (the text `<head ` inside an attribute) only means we parse a document that
 * did not need parsing, and a false negative means there was no document tag to
 * insert into.
 */
export function hasOwnDocument(html: string): boolean {
	return /<(?:html|head|body)[\s>]/i.test(html);
}

/**
 * Put the frame's own additions into an artifact document: the CSP **and**
 * `extraHead` first in `<head>`, `scriptCode` last in `<body>`.
 *
 * ## The policy is not a parameter, and that is structural
 *
 * An earlier version took the policy as part of `headHtml`. A mutation round
 * then passed `''` from either call site — the inline bubble losing its CSP, the
 * gallery losing its entire CSP — and the suite stayed green, because the only
 * coverage was a source-text search for the call. The property this module
 * exists for was pinned by nothing. Owning the policy here means a caller cannot
 * drop it at all, which beats a test that notices when they do.
 *
 * ## Why this parses instead of pattern-matching
 *
 * Both halves used to be regex replacements over the artifact's own markup, and
 * the artifact author controls that markup completely. `/<head[^>]*>/` does not
 * fail to match on `<head data-x="a>b">` — it matches TRUNCATED, up to the raw
 * `>` inside the attribute value, so the insertion lands INSIDE the attribute.
 *
 * Measured in Chrome through a real `srcdoc` iframe: with that payload the CSP
 * meta is not an element at all (`meta[http-equiv]` → 0) and
 * `document.head.getAttributeNames()` returns `data-x`,
 * `content-security-policy"`, `content` — the policy became ATTRIBUTES ON THE
 * HEAD TAG. With it intact the policy is enforced, confirmed at the server's own
 * request log: a resource the artifact declares in its own `<head>` is not
 * fetched, where the same document without the policy fetches it.
 *
 * ⚠ The in-page error is NOT the instrument for that. `fetch` reports a
 * TypeError either way — with the policy because it is blocked, without it
 * because CORS refuses the RESPONSE while the request has already gone out.
 * Exfiltration does not need the response.
 *
 * The `</body>` half had the same shape: a string `.replace` takes the FIRST
 * occurrence, so a `</body>` inside an attribute won.
 *
 * ⚠ The hole was WIDER than that payload. A full document with no literal
 * `<head>` tag — `<html><body>…</body></html>`, nothing hostile — matched
 * neither pattern and got NO policy, NO viewport and NO overflow fix. Measured
 * against the v2.14.2 code. That class now gets all three, which also means it
 * now gets `width=device-width` and `overflow-x:auto` where it got neither: a
 * layout change, in the intended direction, but a change.
 *
 * ## Why a FRAGMENT does not go through the parser
 *
 * Because the two parsers disagree there. `DOMParser` in a browser always yields
 * html/head/body for `text/html`; `linkedom`, which is what this package's tests
 * have, makes the DIV the `documentElement` for `<div>frag</div>` and lazily
 * creates head and body INSIDE it when the code touches them — the content
 * survives, the STRUCTURE is mangled
 * (`<!DOCTYPE html><div><head>…</head><body>…</body>frag</div>`). A test written
 * on that would have shown mangled output for a shape the browser handles, and
 * the repair would have gone into the production code.
 *
 * ⚠ The divergence is not limited to fragments, and an earlier version of this
 * comment claimed it was ("only for the document case, which is where the two
 * agree"). Measured: `<body>x</body>` gives `documentElement` BODY under
 * linkedom and HTML under Chrome; `<head><title>t</title></head>` gives HEAD
 * versus HTML. Those shapes take the PARSE branch, so a future test on one of
 * them gets a wrong answer here. The wrap branch is still the right call for a
 * fragment; the reason is that a fragment has no tag to insert into, not that
 * the engines agree elsewhere.
 *
 * ## The one thing the round trip is not confined to
 *
 * ⚠ The result is base64'd into `data-html` and read back by the artifact's
 * DOWNLOAD and SAVE actions, so what the round trip normalises lands in the
 * user's `.html` file and in the stored gallery record — not only in the iframe.
 * Measured: a comment or an `<?xml-stylesheet?>` before `<html>` is dropped (it
 * is a child of Document, outside `documentElement`), a non-HTML5 doctype is
 * replaced by `<!DOCTYPE html>`, a missing one is added, and attribute values
 * are re-encoded. The downloaded file already carried this frame's CSP and
 * script before any of this, so it was never the artifact's pristine source —
 * but that it is normalised too is new and is stated here rather than discovered.
 */
export function injectIntoArtifactFrame(html: string, extraHead: string, scriptCode: string): string {
	// ⚠ `script` is a RAW TEXT element: its children serialise UNESCAPED, so a
	// `</script` in `scriptCode` closes the element and whatever follows becomes
	// live markup. Measured in Chrome — `textContent = 'a</script><img onerror=…>'`
	// comes back out byte for byte and the `<img>` fires. An earlier version of
	// this comment claimed the parsed branch was "immune" to markup-bearing
	// parameters; it is immune for `extraHead` (a template's "in template"
	// insertion mode contains it) and NOT for `scriptCode`. Both shipped callers
	// pass module constants, so this guard is for the next one.
	if (/<\/script/i.test(scriptCode)) {
		throw new Error('artifact frame: scriptCode may not contain `</script` — it would break out of the element');
	}
	const headHtml = `${ARTIFACT_CSP}${extraHead}`;
	if (!hasOwnDocument(html)) {
		// ⚠ `headHtml` and `scriptCode` are interpolated as markup here, so both
		// must be frame-owned — never artifact content. `scriptCode` is guarded
		// above; `headHtml` is the policy plus the caller's own constants.
		return `<!DOCTYPE html><html><head>${headHtml}${VIEWPORT_META}</head><body>${html}`
			+ `<scr` + `ipt>${scriptCode}</scr` + `ipt></body></html>`;
	}
	const doc = new DOMParser().parseFromString(html, 'text/html');
	// A template so `headHtml` can carry several elements and still arrive as
	// NODES rather than as text.
	//
	// ⚠ This used to copy the child list first (`...[...childNodes]`) with a
	// comment saying the live list would shift during the move. A spread argument
	// list is built COMPLETELY before the call runs, so `prepend` never sees the
	// list change; the copy was redundant. Re-verified in CHROME, where the
	// NodeList really is live (3 → 0 after the move) — the mutation that first
	// showed the copy unnecessary had run under linkedom, whose NodeList is not
	// live at all and could not have failed either way.
	const holder = doc.createElement('template');
	holder.innerHTML = headHtml;
	doc.head.prepend(...holder.content.childNodes);
	// The viewport default is decided on the ELEMENT, not on a regex over the raw
	// markup. ⚠ That regex was the defect: `/name=["']viewport["']/i` matches the
	// literal TEXT, so an artifact that merely DOCUMENTS a viewport meta — a
	// tutorial snippet with `&lt;meta name="viewport" …&gt;` in a `<code>` block —
	// counted as declaring one and got NO viewport, laying out at the desktop
	// fallback width. Asking the parsed document cannot make that mistake.
	if (!doc.querySelector('meta[name="viewport"]')) {
		const viewport = doc.createElement('meta');
		viewport.setAttribute('name', 'viewport');
		viewport.setAttribute('content', 'width=device-width,initial-scale=1');
		doc.head.append(viewport);
	}
	const script = doc.createElement('script');
	script.textContent = scriptCode;
	doc.body.appendChild(script);
	return `<!DOCTYPE html>${doc.documentElement.outerHTML}`;
}

/**
 * Build the srcdoc for a fullscreen artifact preview: the CSP and a default
 * viewport first in `<head>`, the fit-to-width script last in `<body>`.
 *
 * ⚠ This docstring used to say "Pure string transform — DOM-free so it is
 * unit-testable", and that sentence was the REASON it was a string transform. It
 * is also how the defect survived: a justification for the cheap shape, written
 * once and never measured against what it cost. What the string form did buy,
 * and this is the honest ledger entry: it was SSR-safe. `DOMParser` is not a
 * Node global, so a library consumer server-rendering this over a
 * document-shaped artifact now throws. Not reachable in this app (`ssr = false`
 * on the app layout), but both components are exported from the barrel.
 */
export function injectArtifactPreview(html: string): string {
	return injectIntoArtifactFrame(html, '', ARTIFACT_FIT_CODE);
}
