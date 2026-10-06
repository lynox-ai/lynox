import { describe, it, expect } from 'vitest';
import { DOMParser as LinkedomDOMParser, parseHTML } from 'linkedom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
	isViewportDeck, deckFrameHeight, computeFitZoom, injectArtifactPreview,
	injectIntoArtifactFrame, ARTIFACT_FIT_SCRIPT, ARTIFACT_FIT_CODE, clearArtifactFitStyles,
} from './artifact-frame.js';
import type { ArtifactFitStyle } from './artifact-frame.js';

/**
 * ⚠ `injectIntoArtifactFrame` parses with the platform's `DOMParser`. Node has
 * none, so linkedom's stands in — and ONLY for the DOCUMENT case, which is
 * where the two agree.
 *
 * Measured, because this is the trap: on `<div>frag</div>` linkedom makes the
 * DIV the `documentElement` and nests a synthesised head and body INSIDE it,
 * dropping the fragment's own content; a browser always yields html/head/body
 * for `text/html`. A test built on that would have shown mangled output for a
 * shape the browser handles, and the repair would have gone into the production
 * code. The fragment path deliberately does not parse, so the divergence never
 * reaches this suite.
 */
globalThis.DOMParser = LinkedomDOMParser as unknown as typeof globalThis.DOMParser;

const CSP = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'">';

/** The shape this change removed, kept verbatim so each payload can be proven live. */
function injectAsPatternMatch(html: string, headExtra: string, script: string): string {
	const viewport = /name=["\']viewport["\']/i.test(html)
		? '' : '<meta name="viewport" content="width=device-width,initial-scale=1">';
	const head = `${headExtra}${viewport}`;
	let out = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, `$&${head}`) : `${head}${html}`;
	out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, `${script}</body>`) : `${out}${script}`;
	return out;
}

/** Parse a built srcdoc and inspect it as a DOCUMENT, not as a string. */
const asDoc = (html: string) => parseHTML(html).document;

describe('injectIntoArtifactFrame — the breakout it used to allow', () => {
	// The artifact author controls this markup completely. `/<head[^>]*>/` does
	// not fail to match here — it matches TRUNCATED, up to the raw `>` inside the
	// attribute value, so the insertion lands INSIDE the attribute.
	const HEAD_PAYLOAD = '<html><head data-x="a>b"><title>T</title></head><body>hi</body></html>';

	it('⭐ puts the CSP meta in the document instead of into a head ATTRIBUTE', () => {
		// Positive control for the payload: the shape this replaced produces NO
		// meta element on it. If that ever stops being true the payload has gone
		// stale and this test says so, instead of passing for nothing.
		const foil = asDoc(injectAsPatternMatch(HEAD_PAYLOAD, CSP, ARTIFACT_FIT_SCRIPT));
		expect(
			foil.querySelectorAll('meta[http-equiv]').length,
			'the payload no longer suppresses the meta, so this test proves nothing',
		).toBe(0);

		const out = asDoc(injectIntoArtifactFrame(HEAD_PAYLOAD, CSP, ARTIFACT_FIT_CODE));
		expect(out.querySelectorAll('meta[http-equiv]').length).toBe(1);
		// …and FIRST in head, because a policy applies to what follows it.
		expect(out.head.firstElementChild?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
	});

	it('⭐ keeps the artifact\'s own head attribute intact', () => {
		// The second symptom: the old shape ate the attribute it landed in.
		// Absence of the attack is not the same as presence of the content.
		const out = asDoc(injectIntoArtifactFrame(HEAD_PAYLOAD, CSP, ARTIFACT_FIT_CODE));
		expect(out.head.getAttribute('data-x')).toBe('a>b');
		expect(out.querySelector('title')?.textContent).toBe('T');
		expect(out.body.textContent).toContain('hi');
	});

	// A `</body>` inside an attribute, earlier than the real one. A string
	// `.replace` takes the FIRST occurrence, so the script went in there.
	const BODY_PAYLOAD = '<html><head></head><body><p title="</body>">x</p></body></html>';

	it('⭐ appends the script as an element, not into an attribute', () => {
		// Positive control: the old shape mangles the attribute it lands in.
		const foil = asDoc(injectAsPatternMatch(BODY_PAYLOAD, CSP, ARTIFACT_FIT_SCRIPT));
		expect(
			foil.querySelector('p')?.getAttribute('title'),
			'the payload no longer breaks the old replace, so this test proves nothing',
		).not.toBe('</body>');

		const out = asDoc(injectIntoArtifactFrame(BODY_PAYLOAD, CSP, ARTIFACT_FIT_CODE));
		expect(out.querySelector('p')?.getAttribute('title')).toBe('</body>');
		expect(out.body.lastElementChild?.tagName).toBe('SCRIPT');
		expect(out.body.lastElementChild?.textContent).toBe(ARTIFACT_FIT_CODE);
	});
});

describe('injectArtifactPreview', () => {
	it('injects head extras + a default viewport + the fit script into a full doc', () => {
		const out = asDoc(injectArtifactPreview('<html><head><title>T</title></head><body>hi</body></html>', CSP));
		// Element-level: the extras are IN head, the script is LAST in body.
		expect(out.head.querySelectorAll('meta[http-equiv]').length).toBe(1);
		expect(out.head.querySelector('meta[name="viewport"]')?.getAttribute('content')).toContain('width=device-width');
		expect(out.body.lastElementChild?.tagName).toBe('SCRIPT');
		expect(out.body.lastElementChild?.textContent).toBe(ARTIFACT_FIT_CODE);
		// The artifact's own head content survives.
		expect(out.querySelector('title')?.textContent).toBe('T');
	});

	it('does NOT add a second viewport when the artifact already declares one', () => {
		const out = asDoc(injectArtifactPreview('<html><head><meta name="viewport" content="width=600"></head><body>x</body></html>', CSP));
		expect(out.querySelectorAll('meta[name="viewport"]').length).toBe(1);
		expect(out.querySelector('meta[name="viewport"]')?.getAttribute('content')).toBe('width=600');
	});

	it('handles a bare fragment (no html/head/body) without parsing it', () => {
		// ⚠ This path is deliberately NOT parsed — see the note at the top of this
		// file for the measured reason. It is asserted as a string here because
		// linkedom cannot be trusted to re-parse a fragment-derived document.
		const out = injectArtifactPreview('<div>frag</div>', CSP);
		expect(out).toContain(CSP);
		expect(out).toContain('width=device-width');
		expect(out).toContain('<div>frag</div>');
		expect(out).toContain(ARTIFACT_FIT_CODE);
		// The fragment lands in the body, the extras in the head.
		expect(out.indexOf(CSP)).toBeLessThan(out.indexOf('<div>frag</div>'));
	});

	it('the fit script sets viewport width to the content width (fit-to-width), not device-width', () => {
		// It must set width=<cw> + initial-scale=dev/cw so a wide doc fits the phone
		// natively with pinch-zoom — never reset to device-width (would re-clip).
		expect(ARTIFACT_FIT_SCRIPT).toContain('width="+cw+"');
		expect(ARTIFACT_FIT_SCRIPT).toContain('initial-scale="+s');
		expect(ARTIFACT_FIT_SCRIPT).toContain('cw>dev+4');
	});

	it('⭐ the tag string is DERIVED from the code, so the two cannot drift', () => {
		// Both forms ship: the code goes into a script element, the tag string into
		// markup. A test that wrote the value itself could not see them diverge.
		expect(ARTIFACT_FIT_SCRIPT).toContain(ARTIFACT_FIT_CODE);
		expect(ARTIFACT_FIT_SCRIPT.startsWith('<scr')).toBe(true);
		expect(ARTIFACT_FIT_CODE.includes('<script')).toBe(false);
	});
});

describe('both frame paths route through it', () => {
	/**
	 * The one thing a run cannot show here: that the two call sites still use it.
	 * There is no component renderer in this package's tests, so this is a source
	 * assertion — bounded to "is the symbol called", which is not a spelling
	 * anyone has to guess. What it does NOT cover: a second, inline injection
	 * added beside the call.
	 */
	it('⭐ the inline bubble and the fullscreen preview both call it', () => {
		const renderer = readFileSync(
			fileURLToPath(new URL('../components/MarkdownRenderer.svelte', import.meta.url)),
			'utf-8',
		);
		expect(
			renderer,
			'MarkdownRenderer no longer calls injectIntoArtifactFrame — a pattern match is back',
		).toContain('injectIntoArtifactFrame(');
		// ⚠ The gallery check searched for `injectArtifactPreview` and a mutation
		// round walked straight through it: ArtifactsView DEFINES a local wrapper
		// of that very name, so the string is present whether or not it delegates.
		// A proxy the subject satisfies by itself. It imports the helper under an
		// alias, so the alias CALL is the bounded thing to pin.
		const gallery = readFileSync(
			fileURLToPath(new URL('../components/ArtifactsView.svelte', import.meta.url)),
			'utf-8',
		);
		expect(
			gallery,
			'ArtifactsView no longer imports the shared injector',
		).toContain("from '../utils/artifact-frame.js'");
		expect(
			gallery,
			'ArtifactsView no longer calls the shared injector — a pattern match is back',
		).toContain('injectArtifactFit(');
	});
});

describe('computeFitZoom', () => {
	it('scales a wide A4 doc down to the phone frame width', () => {
		// 794px A4 content in a 390px frame → ~0.49 zoom.
		const z = computeFitZoom(794, 390);
		expect(z).toBeCloseTo(390 / 794, 5);
	});

	it('returns null when the content already fits', () => {
		expect(computeFitZoom(380, 390)).toBeNull();
		expect(computeFitZoom(390, 390)).toBeNull();
	});

	it('ignores sub-pixel overflow (4px slack)', () => {
		expect(computeFitZoom(393, 390)).toBeNull();
		expect(computeFitZoom(395, 390)).not.toBeNull();
	});

	it('returns null for degenerate dimensions', () => {
		expect(computeFitZoom(0, 390)).toBeNull();
		expect(computeFitZoom(794, 0)).toBeNull();
		expect(computeFitZoom(-1, 390)).toBeNull();
	});
});

describe('isViewportDeck', () => {
	it('flags a 100vh deck whose scrollHeight collapsed to the viewport', () => {
		expect(isViewportDeck('.slide{height:100vh}', 150, 150)).toBe(true);
	});

	it('accepts dvh/svh/lvh viewport units too', () => {
		expect(isViewportDeck('body{height:100dvh}', 400, 400)).toBe(true);
		expect(isViewportDeck('body{min-height:100svh}', 400, 400)).toBe(true);
		expect(isViewportDeck('body{height:100lvh}', 400, 400)).toBe(true);
	});

	it('does NOT flag a long min-height:100vh page that flows tall', () => {
		// scrollHeight far exceeds the viewport → real content, measure normally.
		expect(isViewportDeck('body{min-height:100vh}', 2400, 400)).toBe(false);
	});

	it('does NOT flag content with no viewport-height unit', () => {
		expect(isViewportDeck('body{padding:1rem}', 120, 400)).toBe(false);
	});

	it('returns false when the viewport height is unknown (0)', () => {
		expect(isViewportDeck('.s{height:100vh}', 0, 0)).toBe(false);
	});

	it('pins the +8 collapse tolerance at its boundary', () => {
		expect(isViewportDeck('.s{height:100vh}', 408, 400)).toBe(true); // == vh+8
		expect(isViewportDeck('.s{height:100vh}', 409, 400)).toBe(false); // just over
	});

	it('does NOT match a longer number ending in 100vh (anchored regex)', () => {
		// `1100vh` / `2100dvh` contain the substring `100vh` but must not flag.
		expect(isViewportDeck('.s{height:1100vh}', 150, 150)).toBe(false);
		expect(isViewportDeck('.s{width:2100dvh}', 150, 150)).toBe(false);
	});
});

describe('deckFrameHeight', () => {
	it('sizes a deck at the 16:9 ratio of its width', () => {
		// 1280 * 9/16 = 720, within the ceiling for a tall viewport.
		expect(deckFrameHeight(1280, 1200)).toBe(720);
	});

	it('floors very narrow frames to a usable slide height', () => {
		// 320 * 9/16 = 180 → floored to 360.
		expect(deckFrameHeight(320, 1200)).toBe(360);
	});

	it('caps the height at 85% of the viewport', () => {
		// 1280*9/16=720 but viewport is short → ceil = 0.85*600 = 510.
		expect(deckFrameHeight(1280, 600)).toBe(510);
	});

	it('falls back to sane defaults for non-positive inputs', () => {
		// width→640 ⇒ 360 (after floor); viewport→800 ⇒ ceil 680. 360 ≤ 680.
		expect(deckFrameHeight(0, 0)).toBe(360);
	});

	it('takes the ceiling when aspect exactly equals it', () => {
		// 960*9/16 = 540; ceil = 0.85*round? 0.85*635.3→ pick vh so ceil==540:
		// 540 / 0.85 = 635.29 → round(635*0.85)=540. aspect==ceil → 540.
		expect(deckFrameHeight(960, 635)).toBe(540);
	});
});

describe('clearArtifactFitStyles', () => {
	// A plain object stands in for an iframe's CSSStyleDeclaration (node, no DOM).
	function makeStyle(): ArtifactFitStyle & { height: string } {
		return {
			width: '986px',
			height: '1265px',
			transform: 'scale(0.8)',
			transformOrigin: 'top left',
			marginRight: '-100px',
			marginBottom: '-200px',
		};
	}

	it('clears every fit-to-width style it owns', () => {
		const style = makeStyle();
		clearArtifactFitStyles(style);
		expect(style.width).toBe('');
		expect(style.transform).toBe('');
		expect(style.transformOrigin).toBe('');
		expect(style.marginRight).toBe('');
		expect(style.marginBottom).toBe('');
	});

	it('NEVER clears height — the resize-handler-owned content height must survive', () => {
		// Regression: clearing height collapsed the fullscreen frame to the 150px
		// iframe default, so a doc that fits the fullscreen width rendered as a thin
		// clipped strip instead of the full page.
		const style = makeStyle();
		clearArtifactFitStyles(style);
		expect(style.height).toBe('1265px');
	});

	it('is idempotent (a second call leaves an already-cleared style untouched)', () => {
		const style = makeStyle();
		clearArtifactFitStyles(style);
		clearArtifactFitStyles(style);
		expect(style.width).toBe('');
		expect(style.marginBottom).toBe('');
		expect(style.height).toBe('1265px');
	});
});
