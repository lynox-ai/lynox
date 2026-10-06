import { describe, it, expect } from 'vitest';
import { DOMParser as LinkedomDOMParser, parseHTML } from 'linkedom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
	isViewportDeck, deckFrameHeight, computeFitZoom, injectArtifactPreview,
	injectIntoArtifactFrame, hasOwnDocument, ARTIFACT_CSP, ARTIFACT_FIT_CODE,
	clearArtifactFitStyles,
} from './artifact-frame.js';
import type { ArtifactFitStyle } from './artifact-frame.js';

/**
 * ⚠ `injectIntoArtifactFrame` parses with the platform's `DOMParser`. Node has
 * none, so linkedom's stands in — and the two DIVERGE on shapes this suite
 * touches, which is why every assertion below is written against structure the
 * two agree on.
 *
 * Measured, linkedom 0.18.12 vs Chrome:
 *
 *   `<div>frag</div>`            DIV as documentElement (content kept, head and
 *                                body lazily created INSIDE it) vs html/head/body
 *   `<body>x</body>`             BODY as documentElement vs HTML
 *   `<head><title>t</title></head>`  HEAD as documentElement vs HTML
 *
 * An earlier version of this note said the content was "dropped" and that the
 * engines "agree on the document case". Both were wrong: the content survives,
 * and the disagreement reaches `<body>`-only and `<head>`-only inputs, which the
 * production predicate routes into the PARSE branch. So a future test on one of
 * those gets a wrong answer here — and, by this file's own warning, the repair
 * would go into the production code.
 */
globalThis.DOMParser = LinkedomDOMParser as unknown as typeof globalThis.DOMParser;

/**
 * The shape this change removed — `injectArtifactPreview`'s, reproduced for its
 * foil.
 *
 * ⚠ NOT "verbatim", and the distinction matters for an uppercase payload: TWO
 * shapes were removed, and `MarkdownRenderer`'s used `/<head[^>]*>/` with **no
 * `i` flag** plus a case-sensitive `.replace('</body>', …)`. This foil models the
 * `i`-flagged one. Both payloads below are lowercase, so the controls hold for
 * either — an uppercase-tag payload would not.
 */
function injectAsPatternMatch(html: string, headExtra: string, script: string): string {
	const viewport = /name=["']viewport["']/i.test(html)
		? '' : '<meta name="viewport" content="width=device-width,initial-scale=1">';
	const head = `${headExtra}${viewport}`;
	let out = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, `$&${head}`) : `${head}${html}`;
	out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, `${script}</body>`) : `${out}${script}`;
	return out;
}

/** Parse a built srcdoc and inspect it as a DOCUMENT, not as a string. */
const asDoc = (html: string) => parseHTML(html).document;

describe('hasOwnDocument', () => {
	// ⭐ ONE predicate decides parse-vs-wrap AND which head content an artifact
	// gets. It used to be two that disagreed, so this is tested directly rather
	// than through its two consumers.
	it('⭐ accepts a document tag and rejects a look-alike', () => {
		for (const yes of [
			'<html><head></head><body>x</body></html>',
			'<HTML><BODY>x</BODY></HTML>',
			'<html\n lang="de"><body>x</body></html>',
			'<head><title>t</title></head>',
			'<body>x</body>',
		]) {
			expect(hasOwnDocument(yes), `should be a document: ${yes}`).toBe(true);
		}
		for (const no of [
			'<div>frag</div>',
			'<p>text</p>',
			// ⚠ These are why the character class is `[\s>]` and not nothing: a
			// custom element or a longer tag name must NOT read as a document.
			'<htmlx>x</htmlx>',
			'<header>x</header>',
			'<bodyguard>x</bodyguard>',
			'<svg viewBox="0 0 1 1"></svg>',
		]) {
			expect(hasOwnDocument(no), `should NOT be a document: ${no}`).toBe(false);
		}
	});
});

describe('injectIntoArtifactFrame — the policy is not a parameter', () => {
	/**
	 * ⭐ THE POINT, and it is structural rather than asserted.
	 *
	 * The policy used to arrive through the caller's `headHtml`. A mutation round
	 * then passed `''` from either call site — the inline bubble losing its CSP,
	 * the gallery losing its entire CSP — and the whole suite stayed green,
	 * because the only coverage was a source-text search for the call. These
	 * tests exist so that the property has a witness at all; the function owning
	 * the policy is what makes the mutant impossible rather than merely caught.
	 */
	it('⭐ a caller that passes NO extra head still gets the policy', () => {
		for (const html of ['<html><head></head><body>x</body></html>', '<div>frag</div>']) {
			const out = injectIntoArtifactFrame(html, '', 'void 0;');
			const doc = asDoc(out);
			const meta = doc.querySelector('meta[http-equiv="Content-Security-Policy"]');
			expect(meta, `no policy for ${html}`).not.toBeNull();
			expect(meta?.getAttribute('content')).toContain("default-src 'none'");
			expect(meta?.getAttribute('content')).toContain("connect-src 'none'");
		}
	});

	it('⭐ the policy is the FIRST head element, because it governs what follows', () => {
		const out = injectIntoArtifactFrame('<html><head><title>T</title></head><body>x</body></html>', '', 'void 0;');
		expect(asDoc(out).head.firstElementChild?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
	});

	it('refuses a script body that would break out of its own element', () => {
		// `script` is a RAW TEXT element: its children serialise unescaped, so a
		// `</script` closes it and the rest becomes live markup. Both shipped
		// callers pass module constants; this guard is for the next one.
		expect(() => injectIntoArtifactFrame(
			'<html><head></head><body>x</body></html>', '', 'a</script><img src=/nope>',
		)).toThrow(/script/i);
		// …and the same body is refused on the wrap branch, which interpolates it.
		expect(() => injectIntoArtifactFrame('<div>f</div>', '', 'a</ScRiPt >x')).toThrow(/script/i);
	});

	it('emits a doctype on both branches', () => {
		// The one thing the parse branch ADDS that the input may not have had, and
		// it is user-visible: this output is also what the artifact's download and
		// save actions hand over.
		for (const html of ['<html><head></head><body>x</body></html>', '<div>frag</div>']) {
			expect(injectIntoArtifactFrame(html, '', 'void 0;').startsWith('<!DOCTYPE html>')).toBe(true);
		}
	});
});

describe('injectIntoArtifactFrame — the breakout it used to allow', () => {
	// The artifact author controls this markup completely. `/<head[^>]*>/` does
	// not fail to match here — it matches TRUNCATED, up to the raw `>` inside the
	// attribute value, so the insertion lands INSIDE the attribute.
	const HEAD_PAYLOAD = '<html><head data-x="a>b"><title>T</title></head><body>hi</body></html>';

	it('⭐ puts the CSP meta in the document instead of into a head ATTRIBUTE', () => {
		// Positive control for the payload: the shape this replaced produces NO
		// meta element on it. If that ever stops being true the payload has gone
		// stale and this says so, instead of passing for nothing.
		const foil = asDoc(injectAsPatternMatch(HEAD_PAYLOAD, ARTIFACT_CSP, '<script>void 0;</script>'));
		expect(
			foil.querySelectorAll('meta[http-equiv]').length,
			'the payload no longer suppresses the meta, so this test proves nothing',
		).toBe(0);

		const out = asDoc(injectIntoArtifactFrame(HEAD_PAYLOAD, '', ARTIFACT_FIT_CODE));
		expect(out.querySelectorAll('meta[http-equiv]').length).toBe(1);
		expect(out.head.firstElementChild?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
	});

	it('⭐ keeps the artifact\'s own head attribute intact', () => {
		// The second symptom: the old shape ate the attribute it landed in.
		// Absence of the attack is not the same as presence of the content.
		const out = asDoc(injectIntoArtifactFrame(HEAD_PAYLOAD, '', ARTIFACT_FIT_CODE));
		expect(out.head.getAttribute('data-x')).toBe('a>b');
		expect(out.querySelector('title')?.textContent).toBe('T');
		expect(out.body.textContent).toContain('hi');
	});

	// A `</body>` inside an attribute, earlier than the real one. A string
	// `.replace` takes the FIRST occurrence, so the script went in there.
	const BODY_PAYLOAD = '<html><head></head><body><p title="</body>">x</p></body></html>';

	it('⭐ appends the script as an element, not into an attribute', () => {
		// ⚠ This asserts the BRANCH first. A mutation that widened the predicate
		// routed this payload into the WRAP branch, where the assertions below
		// hold trivially — so the witness passed without the parse branch ever
		// running on it.
		expect(hasOwnDocument(BODY_PAYLOAD), 'this payload no longer takes the parse branch').toBe(true);

		// Positive control: the old shape mangles the attribute it lands in.
		const foil = asDoc(injectAsPatternMatch(BODY_PAYLOAD, ARTIFACT_CSP, '<script>void 0;</script>'));
		expect(
			foil.querySelector('p')?.getAttribute('title'),
			'the payload no longer breaks the old replace, so this test proves nothing',
		).not.toBe('</body>');

		const out = asDoc(injectIntoArtifactFrame(BODY_PAYLOAD, '', ARTIFACT_FIT_CODE));
		expect(out.querySelector('p')?.getAttribute('title')).toBe('</body>');
		expect(out.body.lastElementChild?.tagName).toBe('SCRIPT');
		expect(out.body.lastElementChild?.textContent).toBe(ARTIFACT_FIT_CODE);
	});
});

describe('injectArtifactPreview', () => {
	it('injects the policy + a default viewport + the fit script into a full doc', () => {
		const out = asDoc(injectArtifactPreview('<html><head><title>T</title></head><body>hi</body></html>'));
		expect(out.head.querySelectorAll('meta[http-equiv]').length).toBe(1);
		expect(out.head.querySelector('meta[name="viewport"]')?.getAttribute('content')).toContain('width=device-width');
		expect(out.body.lastElementChild?.tagName).toBe('SCRIPT');
		expect(out.body.lastElementChild?.textContent).toBe(ARTIFACT_FIT_CODE);
		expect(out.querySelector('title')?.textContent).toBe('T');
	});

	it('does NOT add a second viewport when the artifact already declares one', () => {
		const out = asDoc(injectArtifactPreview('<html><head><meta name="viewport" content="width=600"></head><body>x</body></html>'));
		expect(out.querySelectorAll('meta[name="viewport"]').length).toBe(1);
		expect(out.querySelector('meta[name="viewport"]')?.getAttribute('content')).toBe('width=600');
	});

	it('⭐ still adds a viewport to an artifact that merely DOCUMENTS one', () => {
		// ⚠ The regression this pins. The condition used to be a regex over the
		// RAW MARKUP, so a tutorial artifact with `name="viewport"` inside a
		// `<code>` block counted as declaring one and got NO viewport — laying out
		// at the desktop fallback width on a phone. The condition now asks the
		// parsed document for the ELEMENT, which cannot make that mistake.
		const tutorial = '<html><head></head><body><code>&lt;meta name="viewport" content="width=device-width"&gt;</code></body></html>';
		const out = asDoc(injectArtifactPreview(tutorial));
		expect(out.head.querySelector('meta[name="viewport"]')?.getAttribute('content')).toContain('width=device-width');
	});

	it('handles a bare fragment (no html/head/body) without parsing it', () => {
		// ⚠ This path is deliberately NOT parsed — see the note at the top of this
		// file for the measured reason. It is asserted as a string here because
		// linkedom cannot be trusted to re-parse a fragment-derived document.
		const out = injectArtifactPreview('<div>frag</div>');
		expect(out).toContain(ARTIFACT_CSP);
		expect(out).toContain('width=device-width');
		expect(out).toContain('<div>frag</div>');
		expect(out).toContain(ARTIFACT_FIT_CODE);
		expect(out.indexOf(ARTIFACT_CSP)).toBeLessThan(out.indexOf('<div>frag</div>'));
	});

	it('the fit script sets viewport width to the content width (fit-to-width), not device-width', () => {
		// It must set width=<cw> + initial-scale=dev/cw so a wide doc fits the phone
		// natively with pinch-zoom — never reset to device-width (would re-clip).
		expect(ARTIFACT_FIT_CODE).toContain('width="+cw+"');
		expect(ARTIFACT_FIT_CODE).toContain('initial-scale="+s');
		expect(ARTIFACT_FIT_CODE).toContain('cw>dev+4');
		// It is CODE, not markup: it goes in as a script element's textContent.
		expect(ARTIFACT_FIT_CODE.includes('<script')).toBe(false);
	});
});

describe('both frame paths route through it', () => {
	/**
	 * ⚠ A SOURCE ASSERTION, and a weak one on purpose — it is no longer the only
	 * thing standing between the policy and a caller. The structural fix above is
	 * what makes "the policy got dropped" impossible; this only notices that a
	 * component stopped calling the injector at all, which is a loud absence.
	 *
	 * ## A KNOWN GAP, named rather than covered
	 *
	 * A mutation that computes `extraHead` in the component and then passes `''`
	 * to the injector SURVIVES this suite, measured. What it costs is styling: a
	 * wide document stops being pannable (`overflowFix`), and a fragment renders
	 * on the default white background inside a dark app (`defaultStyles`). It
	 * does NOT cost the policy or the viewport — the injector owns both, so that
	 * class is impossible rather than merely caught.
	 *
	 * It is not pinned because the only available pin is a spelling: "the second
	 * argument is the identifier `extraHead`". The set of ways to pass nothing is
	 * open — `''`, a differently-named variable, a conditional that yields empty
	 * — and this change already deleted three assertions of exactly that shape
	 * for exactly that reason. A styling regression is also immediately visible
	 * in the UI, which is the opposite failure mode from the silent one this
	 * module exists for. Closing it properly means the injector owning the whole
	 * head, parameterised by the theme it cannot know; that is a bigger cut than
	 * this change, and it is stated here so the next person does not have to
	 * rediscover why there is no test.
	 */
	it('the inline bubble and the fullscreen preview both call it', () => {
		const renderer = readFileSync(
			fileURLToPath(new URL('../components/MarkdownRenderer.svelte', import.meta.url)),
			'utf-8',
		);
		expect(renderer, 'MarkdownRenderer no longer calls injectIntoArtifactFrame').toContain('injectIntoArtifactFrame(');
		const gallery = readFileSync(
			fileURLToPath(new URL('../components/ArtifactsView.svelte', import.meta.url)),
			'utf-8',
		);
		expect(gallery, 'ArtifactsView no longer imports the shared injector').toContain("from '../utils/artifact-frame.js'");
		expect(gallery, 'ArtifactsView no longer calls the shared injector').toContain('injectArtifactFit(');
	});

	it('⭐ a document artifact keeps its own styling, a fragment gets ours', () => {
		// The distinction `hasOwnDocument` decides on the caller's side, and the
		// one nothing pinned: inverting the predicate swapped the two head arms
		// and the suite stayed green. An artifact that brought its own document
		// must NOT get our background forced onto it; a fragment must, or it
		// renders black-on-white inside a dark app.
		const renderer = readFileSync(
			fileURLToPath(new URL('../components/MarkdownRenderer.svelte', import.meta.url)),
			'utf-8',
		);
		const arm = renderer.match(/const extraHead = hasOwnDocument\(clean\)\n([\s\S]*?);\n/)?.[1] ?? '';
		expect(arm, 'the head-arm expression is gone or reshaped — this test cannot see it').not.toBe('');
		const [own, fragment] = arm.split(':');
		expect(own, 'a document artifact is being given our default styles').not.toContain('defaultStyles');
		expect(fragment, 'a fragment no longer gets our default styles').toContain('defaultStyles');
		// Both get the overflow fix — a wide document has to be pannable either way.
		expect(own).toContain('overflowFix');
		expect(fragment).toContain('overflowFix');
	});

	it('⭐ neither component keeps its own copy of the policy', () => {
		// The two `CSP_META` constants had already drifted (`default-src 'none'`
		// versus `'unsafe-inline'`). One owner, and nothing to drift from.
		for (const f of ['MarkdownRenderer.svelte', 'ArtifactsView.svelte']) {
			const src = readFileSync(fileURLToPath(new URL(`../components/${f}`, import.meta.url)), 'utf-8');
			expect(src, `${f} declares its own Content-Security-Policy again`)
				.not.toMatch(/http-equiv="Content-Security-Policy"/);
		}
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
