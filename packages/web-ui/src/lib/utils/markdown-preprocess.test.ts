import { describe, expect, it } from 'vitest';
import { fixMarkdownPreprocessing } from './markdown-preprocess.js';

describe('fixMarkdownPreprocessing', () => {
	describe('heading normalisation (regression for v1.3.5)', () => {
		it('inserts a space after ### when missing ("###2." → "### 2.")', () => {
			expect(fixMarkdownPreprocessing('###2. Foo')).toBe('### 2. Foo');
			expect(fixMarkdownPreprocessing('#Foo')).toBe('# Foo');
			expect(fixMarkdownPreprocessing('######Foo')).toBe('###### Foo');
		});

		it('strips 1-3 spaces of leading indent on heading lines', () => {
			expect(fixMarkdownPreprocessing(' ### 2. Foo')).toBe('### 2. Foo');
			expect(fixMarkdownPreprocessing('   ### 2. Foo')).toBe('### 2. Foo');
		});

		it('preserves 4-space indent (real CommonMark indented code block)', () => {
			expect(fixMarkdownPreprocessing('    ### 2. Foo')).toBe('    ### 2. Foo');
			expect(fixMarkdownPreprocessing('        ### 2. Foo')).toBe('        ### 2. Foo');
		});

		it('preserves 7+ hashes (paragraph, not heading)', () => {
			expect(fixMarkdownPreprocessing('#######foo')).toBe('#######foo');
		});

		it('preserves valid headings with space', () => {
			expect(fixMarkdownPreprocessing('### 2. Foo')).toBe('### 2. Foo');
			expect(fixMarkdownPreprocessing('# Title')).toBe('# Title');
		});

		it('preserves empty headings (### with nothing after)', () => {
			expect(fixMarkdownPreprocessing('###')).toBe('###');
		});

		it('does not touch hash-text mid-line', () => {
			expect(fixMarkdownPreprocessing('see ###channel')).toBe('see ###channel');
			expect(fixMarkdownPreprocessing('count: ##2')).toBe('count: ##2');
		});

		it('does not touch headings inside fenced code blocks', () => {
			const input = '```\n###2. inside code\n```';
			expect(fixMarkdownPreprocessing(input)).toBe(input);
		});

		it('handles mixed bad headings in one document', () => {
			const input = '# Doc\n\n###1. First\n\nbody\n\n  ### 2. Second\n\nbody\n\n###3. Third';
			const expected = '# Doc\n\n### 1. First\n\nbody\n\n### 2. Second\n\nbody\n\n### 3. Third';
			expect(fixMarkdownPreprocessing(input)).toBe(expected);
		});
	});

	describe('sentence spacing', () => {
		it('splits run-on sentences with capital letter after period', () => {
			expect(fixMarkdownPreprocessing('Hello.World')).toBe('Hello.\n\nWorld');
		});

		it('preserves abbreviations (≤2-letter stem before period)', () => {
			expect(fixMarkdownPreprocessing('z.B. Tests')).toBe('z.B. Tests');
			expect(fixMarkdownPreprocessing('U.S. Customs')).toBe('U.S. Customs');
			expect(fixMarkdownPreprocessing('d.h. Hauptthema')).toBe('d.h. Hauptthema');
		});

		it('does not split table rows', () => {
			expect(fixMarkdownPreprocessing('| a.B | c |')).toBe('| a.B | c |');
		});

		it('does not split inside code fences', () => {
			const input = '```ts\nconst x = "Hello.World";\n```';
			expect(fixMarkdownPreprocessing(input)).toBe(input);
		});
	});
});
