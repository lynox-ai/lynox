import { describe, expect, it } from 'vitest';
import { computeScrollFadeMask } from './scroll-fade.js';

// The pure mask logic behind the scrollFade action: which edge gets a fade
// given a scroll position. The DOM wrapper (the action) is untested glue,
// matching the repo convention for Svelte actions (see click-outside.ts).
describe('computeScrollFadeMask', () => {
	it('returns null when the content fully fits (nothing to scroll)', () => {
		expect(computeScrollFadeMask(0, 100, 100)).toBeNull();
		expect(computeScrollFadeMask(0, 80, 100)).toBeNull();
	});

	it('fades the RIGHT edge at the start of a scrollable row', () => {
		const mask = computeScrollFadeMask(0, 300, 100);
		expect(mask).not.toBeNull();
		expect(mask!.startsWith('linear-gradient(to right, black 0')).toBe(true);
		expect(mask!.endsWith('transparent 100%)')).toBe(true);
	});

	it('fades the LEFT edge when fully scrolled to the end', () => {
		// scrollLeft 200 == maxScroll (300 - 100)
		const mask = computeScrollFadeMask(200, 300, 100);
		expect(mask).not.toBeNull();
		expect(mask!.startsWith('linear-gradient(to right, transparent 0')).toBe(true);
		expect(mask!.endsWith('black 100%)')).toBe(true);
	});

	it('fades BOTH edges in the middle of a scrollable row', () => {
		const mask = computeScrollFadeMask(100, 300, 100);
		expect(mask).not.toBeNull();
		expect(mask!.startsWith('linear-gradient(to right, transparent 0')).toBe(true);
		expect(mask!.endsWith('transparent 100%)')).toBe(true);
	});

	it('absorbs sub-pixel slack so a near-end position does not keep a phantom fade', () => {
		// 0.5px from each bound counts as fully at that edge.
		expect(computeScrollFadeMask(0.5, 300, 100)).not.toBeNull(); // still room to the right
		const atEnd = computeScrollFadeMask(199.5, 300, 100);
		expect(atEnd!.endsWith('black 100%)')).toBe(true); // right edge solid (no phantom right fade)
	});
});
