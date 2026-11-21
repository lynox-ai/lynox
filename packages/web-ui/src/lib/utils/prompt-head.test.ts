import { describe, it, expect } from 'vitest';
import { linesBelow, promptFieldTooLow, splitPromptHead } from './prompt-head.js';

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
