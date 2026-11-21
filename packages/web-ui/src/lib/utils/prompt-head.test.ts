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
			head: '⚠ Command: delete files (cannot be undone) — "',
			lines: ['rm -rf ./release/build-1/artifacts', 'rm -rf ./release/build-2/artifacts', 'rm -rf ./release/build-3/artifacts"'],
		});
	});

	it('keeps a long one-line value apart too', () => {
		const value = `/srv/${'d/'.repeat(100)}file`;
		const segments = [{ kind: 'frame' as const, text: '⚠ File access: "' }, { kind: 'value' as const, text: value }, { kind: 'frame' as const, text: '"' }];
		expect(splitPromptHead(`⚠ File access: "${value}"`, segments).head).toBe('⚠ File access: "');
	});

	it('leaves a short one-line value on the head\'s line', () => {
		const segments = [{ kind: 'frame' as const, text: '⚠ Command: git push — "' }, { kind: 'value' as const, text: 'git push origin main' }, { kind: 'frame' as const, text: '"' }];
		expect(splitPromptHead('⚠ Command: git push — "git push origin main"', segments)).toEqual({ head: '', lines: ['⚠ Command: git push — "git push origin main"'] });
	});

	it('has no head without segments, or without a value', () => {
		expect(splitPromptHead('a\nb', undefined)).toEqual({ head: '', lines: ['a', 'b'] });
		expect(splitPromptHead('only system text', [{ kind: 'frame', text: 'only system text' }])).toEqual({ head: '', lines: ['only system text'] });
		expect(splitPromptHead('v\nw', [{ kind: 'value', text: 'v\nw' }])).toEqual({ head: '', lines: ['v', 'w'] });
	});
});

describe('linesBelow', () => {
	it('counts every line whose bottom lies below the edge, a half-cut one included', () => {
		expect(linesBelow([23, 46, 69, 92, 115], 100)).toBe(1);
		expect(linesBelow([23, 46, 69, 92], 100)).toBe(0);
		expect(linesBelow([23, 46, 100.4], 100)).toBe(0);
	});
});

describe('promptFieldTooLow', () => {
	it('is low when the field overflows and has room for fewer than four lines', () => {
		expect(promptFieldTooLow({ clientHeight: 47, scrollHeight: 319 }, 0, 23)).toBe(true);
		expect(promptFieldTooLow({ clientHeight: 256, scrollHeight: 319 }, 200, 23)).toBe(true);
	});
	it('is not low while four lines fit, or when nothing overflows', () => {
		expect(promptFieldTooLow({ clientHeight: 92, scrollHeight: 319 }, 0, 23)).toBe(false);
		expect(promptFieldTooLow({ clientHeight: 23, scrollHeight: 23 }, 0, 23)).toBe(false);
	});
});
