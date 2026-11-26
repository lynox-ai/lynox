import { describe, it, expect } from 'vitest';
import { contentLeftBelow, linesBelow, linesLeftBelow, promptFieldTooLow, readOnStep, splitPromptHead } from './prompt-head.js';

const many = Array.from({ length: 3 }, (_, i) => `rm -rf ./release/build-${i + 1}/artifacts`).join('\n');

describe('splitPromptHead', () => {
	it('keeps the frame before the first value apart, and splits the rest into its lines', () => {
		const segments = [
			{ kind: 'frame' as const, text: '⚠ Command: delete files (cannot be undone) — "' },
			{ kind: 'value' as const, text: many },
			{ kind: 'frame' as const, text: '"' },
		];
		expect(splitPromptHead(segments.map((s) => s.text).join(''), segments)).toEqual({
			head: [{ kind: 'frame', text: '⚠ Command: delete files (cannot be undone) — "' }],
			lines: ['rm -rf ./release/build-1/artifacts', 'rm -rf ./release/build-2/artifacts', 'rm -rf ./release/build-3/artifacts"'],
		});
	});

	it('keeps a long one-line value apart too', () => {
		const value = `/srv/${'d/'.repeat(100)}file`;
		const segments = [{ kind: 'frame' as const, text: '⚠ File access: "' }, { kind: 'value' as const, text: value }, { kind: 'frame' as const, text: '"' }];
		expect(splitPromptHead(`⚠ File access: "${value}"`, segments).head).toEqual([{ kind: 'frame', text: '⚠ File access: "' }]);
	});

	it('leaves a short one-line value on the head\'s line', () => {
		const segments = [{ kind: 'frame' as const, text: '⚠ Command: git push — "' }, { kind: 'value' as const, text: 'git push origin main' }, { kind: 'frame' as const, text: '"' }];
		expect(splitPromptHead('⚠ Command: git push — "git push origin main"', segments)).toEqual({ head: [], lines: ['⚠ Command: git push — "git push origin main"'] });
	});

	it('keeps an external tool\'s short name in the head, so the action it names stays in view', () => {
		const segments = [
			{ kind: 'frame' as const, text: '⚠ External tool "' },
			{ kind: 'value' as const, text: 'Merge' },
			{ kind: 'frame' as const, text: '": delete files (cannot be undone) — "' },
			{ kind: 'value' as const, text: many },
			{ kind: 'frame' as const, text: '"' },
		];
		// The name stays a value in the head, never merged into the frame's text.
		expect(splitPromptHead(segments.map((s) => s.text).join(''), segments).head).toEqual([
			{ kind: 'frame', text: '⚠ External tool "' },
			{ kind: 'value', text: 'Merge' },
			{ kind: 'frame', text: '": delete files (cannot be undone) — "' },
		]);
	});

	it('has no head without segments, or without a value', () => {
		expect(splitPromptHead('a\nb', undefined)).toEqual({ head: [], lines: ['a', 'b'] });
		expect(splitPromptHead('only system text', [{ kind: 'frame', text: 'only system text' }])).toEqual({ head: [], lines: ['only system text'] });
		expect(splitPromptHead('v\nw', [{ kind: 'value', text: 'v\nw' }])).toEqual({ head: [], lines: ['v', 'w'] });
	});
});

const box = (top: number, bottom: number) => ({ top, bottom });
describe('linesBelow', () => {
	it('counts every line whose bottom lies below the edge, a half-cut one included', () => {
		expect(linesBelow([box(0, 23), box(23, 46), box(46, 69), box(69, 92), box(92, 115)], 100, 23)).toBe(1);
		expect(linesBelow([box(0, 23), box(23, 46), box(46, 69), box(69, 92)], 100, 23)).toBe(0);
		expect(linesBelow([box(0, 23), box(23, 46), box(77.4, 100.4)], 100, 23)).toBe(0);
	});
	it('counts a long line with every screen line it still hides', () => {
		// One value line wrapped over 12 screen lines; the field shows 4 of them.
		expect(linesBelow([box(0, 276)], 92, 23)).toBe(8);
	});
	it('adds up a long cut line and the short lines below it', () => {
		expect(linesBelow([box(0, 138), box(138, 161), box(161, 184), box(184, 207)], 92, 23)).toBe(2 + 3);
	});
});

describe('contentLeftBelow', () => {
	const box = (scrollHeight: number, scrollTop = 0) => ({ scrollHeight, clientHeight: 256, scrollTop, bottom: 400 });

	it('measures from where the content ends, so a trailing margin is not counted', () => {
		// 4 px of margin under the last paragraph: 30 px left to scroll, 26 px of it text.
		expect(contentLeftBelow(box(286), 426)).toBe(26);
		// A list ends without a margin: everything left to scroll is text.
		expect(contentLeftBelow(box(286), 430)).toBe(30);
	});

	it('never says more than is left to scroll, and counts down as the box is scrolled', () => {
		expect(contentLeftBelow(box(286), 440)).toBe(30);
		expect(contentLeftBelow(box(286, 20), 406)).toBe(6);
	});

	it('takes what is left to scroll when the content does not end in an element', () => {
		expect(contentLeftBelow(box(286), null)).toBe(30);
		expect(contentLeftBelow(box(286, 30), null)).toBe(0);
	});
});

describe('linesLeftBelow', () => {
	it('counts what is left in lines, a cut line as a whole one', () => {
		expect(linesLeftBelow(302, 22)).toBe(14);
		expect(linesLeftBelow(44, 22)).toBe(2);
		expect(linesLeftBelow(12, 22)).toBe(1);
	});

	it('counts an exact number of lines as that many, and one pixel more as one more', () => {
		expect(linesLeftBelow(22, 22)).toBe(1);
		expect(linesLeftBelow(23, 22)).toBe(2);
		expect(linesLeftBelow(45, 22)).toBe(3);
		expect(linesLeftBelow(68.25, 22.75)).toBe(3);
		// A line height floats cannot hold exactly: two of them are two lines, not three.
		expect(linesLeftBelow(2 * 22.4, 22.4)).toBe(2);
		expect(linesLeftBelow(3 * 22.1, 22.1)).toBe(3);
	});

	it('is 0 below one pixel, the rounding left at the very end by fractional zoom', () => {
		expect(linesLeftBelow(0, 22)).toBe(0);
		expect(linesLeftBelow(0.8, 22)).toBe(0);
		expect(linesLeftBelow(-3, 22)).toBe(0);
	});

	it('counts a line of which only a pixel or a few are hidden', () => {
		expect(linesLeftBelow(1, 22)).toBe(1);
		expect(linesLeftBelow(1.5, 22)).toBe(1);
		expect(linesLeftBelow(11, 22.75)).toBe(1);
	});
});

describe('readOnStep', () => {
	it('scrolls by the whole lines seen above the fade, never more than that', () => {
		// 224 px seen above the fade: 10 lines of 22 px, 9 of 22.75 px.
		expect(readOnStep(256, 22, 32)).toBe(220);
		expect(readOnStep(256, 22.75, 32)).toBe(9 * 22.75);
		// 219 px seen: 9 whole lines, the tenth is partly under the fade and comes after.
		expect(readOnStep(251, 22, 32)).toBe(198);
		expect(readOnStep(252, 22, 32)).toBe(220);
	});

	it('at least one line, even in a box hardly taller than its fade', () => {
		expect(readOnStep(40, 22, 32)).toBe(22);
	});
});

describe('promptFieldTooLow', () => {
	it('is low when the field overflows and has room for fewer than four lines', () => {
		expect(promptFieldTooLow({ clientHeight: 47, scrollHeight: 319 }, 0, 23, false)).toBe(true);
		expect(promptFieldTooLow({ clientHeight: 256, scrollHeight: 319 }, 200, 23, true)).toBe(true);
	});
	it('is not low while four lines fit, or when nothing overflows', () => {
		expect(promptFieldTooLow({ clientHeight: 92, scrollHeight: 319 }, 0, 23, false)).toBe(false);
		expect(promptFieldTooLow({ clientHeight: 23, scrollHeight: 23 }, 0, 23, true)).toBe(false);
	});
	it('changes state only a margin past four lines, so one window height never flips it back and forth', () => {
		// four lines = 92 px; within 4 px either side the state stays as it was.
		for (const room of [89, 91, 93, 95]) {
			expect(promptFieldTooLow({ clientHeight: room, scrollHeight: 319 }, 0, 23, false), `shrunk, ${room}`).toBe(false);
			expect(promptFieldTooLow({ clientHeight: room, scrollHeight: 319 }, 0, 23, true), `too low, ${room}`).toBe(true);
		}
		expect(promptFieldTooLow({ clientHeight: 87, scrollHeight: 319 }, 0, 23, false)).toBe(true);
		expect(promptFieldTooLow({ clientHeight: 96, scrollHeight: 319 }, 0, 23, true)).toBe(false);
	});
});
