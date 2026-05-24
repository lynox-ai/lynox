import { describe, expect, it } from 'vitest';
import { fixMarkdownPreprocessing, repairCodeFences } from './markdown-preprocess.js';

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

	// Pre-launch regression-pin 2026-05-24: terse numeric-period replies
	// like "4." (Mistral's compact answer for "What is 2+2?") were being
	// interpreted by marked as an empty <ol start="4"><li></li></ol>,
	// rendering as a giant blank list.
	describe('bare numeric-period escape (ol-start guard)', () => {
		it('escapes a lone "4." so it renders as prose, not ol-start', () => {
			expect(fixMarkdownPreprocessing('4.')).toBe('4\\.');
		});

		it('escapes multi-digit "42."', () => {
			expect(fixMarkdownPreprocessing('42.')).toBe('42\\.');
		});

		it('preserves surrounding whitespace', () => {
			expect(fixMarkdownPreprocessing('  4.  ')).toBe('  4\\.  ');
		});

		it('does NOT escape "The answer is 4." (period at end of prose)', () => {
			expect(fixMarkdownPreprocessing('The answer is 4.')).toBe('The answer is 4.');
		});

		it('does NOT escape multi-line lists ("1.\\n2.\\n3.")', () => {
			const input = '1.\n2.\n3.';
			expect(fixMarkdownPreprocessing(input)).toBe(input);
		});

		it('does NOT escape "4" without a period', () => {
			expect(fixMarkdownPreprocessing('4')).toBe('4');
		});
	});
});

describe('repairCodeFences', () => {
	it('leaves balanced fences untouched', () => {
		const input = '```ts\nconst x = 1;\n```';
		expect(repairCodeFences(input)).toBe(input);
	});

	it('leaves text without any fence untouched', () => {
		expect(repairCodeFences('Hello\n\nworld')).toBe('Hello\n\nworld');
	});

	it('appends closing fence when content after the unclosed fence looks like real code', () => {
		const input = '```ts\nconst x = 1;\nconst y = 2;';
		expect(repairCodeFences(input)).toBe(input + '\n```');
	});

	it('strips opening fence when content inside looks like markdown (heading + bold)', () => {
		const input = '```markdown\n## Overview\n\n**Budget:** CHF 10/day';
		const out = repairCodeFences(input);
		expect(out).not.toMatch(/^```/);
		expect(out).toContain('## Overview');
		expect(out).toContain('**Budget:**');
	});

	it('strips opening fence when content inside is a markdown table', () => {
		const input = '```\n| Page | Keyword |\n|---|---|\n| Home | foo |\n\n**Note:** see above';
		const out = repairCodeFences(input);
		expect(out).not.toMatch(/^```/);
		expect(out).toContain('| Page | Keyword |');
	});

	it('preserves content before the unclosed fence', () => {
		const input = 'Intro paragraph.\n\n```\n## A\n\n**b** list\n- one\n- two';
		const out = repairCodeFences(input);
		expect(out.startsWith('Intro paragraph.')).toBe(true);
		expect(out).not.toContain('```');
	});

	it('still appends closing fence when there is just one weak markdown signal', () => {
		const input = '```\n# Just a comment\n  let x = 1;\n  let y = 2;';
		// Only one heading-ish line + 4-space indented code → not enough markdown signal
		expect(repairCodeFences(input)).toBe(input + '\n```');
	});

	it('does not strip the opening fence when the content is short and codey', () => {
		const input = '```\nconst x = 1;\nconst y = 2;';
		expect(repairCodeFences(input)).toBe(input + '\n```');
	});

	it('handles a single trailing fence (closing without opening) by appending another', () => {
		// Treat as odd-count: one fence on its own. The "after" content is empty,
		// so it doesn't look markdown → append a second fence.
		const input = '```';
		const out = repairCodeFences(input);
		expect(out).toBe(input + '\n```');
	});
});
