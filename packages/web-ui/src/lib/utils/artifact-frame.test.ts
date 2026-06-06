import { describe, it, expect } from 'vitest';
import { isViewportDeck, deckFrameHeight, computeFitZoom, injectArtifactPreview, ARTIFACT_FIT_SCRIPT } from './artifact-frame.js';

describe('injectArtifactPreview', () => {
	it('injects head extras + a default viewport + the fit script into a full doc', () => {
		const out = injectArtifactPreview('<html><head><title>T</title></head><body>hi</body></html>', '<meta name="csp">');
		expect(out).toContain('<meta name="csp">');
		expect(out).toContain('width=device-width');
		expect(out).toContain(ARTIFACT_FIT_SCRIPT);
		// head extras go inside <head>, the script before </body>
		expect(out.indexOf('<meta name="csp">')).toBeLessThan(out.indexOf('</head>'));
		expect(out.indexOf(ARTIFACT_FIT_SCRIPT)).toBeLessThan(out.indexOf('</body>'));
	});

	it('does NOT add a second viewport when the artifact already declares one', () => {
		const out = injectArtifactPreview('<html><head><meta name="viewport" content="width=600"></head><body>x</body></html>', '<meta name="csp">');
		expect(out.match(/name=["']viewport["']/gi)?.length).toBe(1);
		expect(out).toContain('width=600');
	});

	it('handles a bare fragment (no <head>/<body>)', () => {
		const out = injectArtifactPreview('<div>frag</div>', '<meta name="csp">');
		expect(out.startsWith('<meta name="csp">')).toBe(true);
		expect(out).toContain('width=device-width');
		expect(out.endsWith(ARTIFACT_FIT_SCRIPT)).toBe(true);
	});

	it('the fit script sets viewport width to the content width (fit-to-width), not device-width', () => {
		// It must set width=<cw> + initial-scale=dev/cw so a wide doc fits the phone
		// natively with pinch-zoom — never reset to device-width (would re-clip).
		expect(ARTIFACT_FIT_SCRIPT).toContain('width="+cw+"');
		expect(ARTIFACT_FIT_SCRIPT).toContain('initial-scale="+s');
		expect(ARTIFACT_FIT_SCRIPT).toContain('cw>dev+4');
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
