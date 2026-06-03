import { describe, it, expect } from 'vitest';
import { isViewportDeck, deckFrameHeight } from './artifact-frame.js';

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
