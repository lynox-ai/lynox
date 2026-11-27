import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROMPT_EMITTED_TAGS } from '../utils/prompt-markdown.js';

/**
 * A question without a consent kind renders as markup in a box that scrolls downwards, and the
 * box counts the lines left below its edge. Nothing counted what lay to the RIGHT: a code block
 * scrolled sideways on its own, and so did a wide table, so a long line in either ran on past the
 * edge. With overlay scrollbars (phones, macOS) nothing showed that text was there, and the owner
 * could answer yes to a question whose end they had not seen.
 *
 * The box now wraps instead: a code block keeps its line breaks and wraps long lines, a table
 * takes the box's width and wraps inside its cells, and every word may break. So everything the
 * question holds lies below, where the count sees it.
 *
 * There is no layout engine in this package's tests, so the measurement lives in the shots (390
 * and 1372 wide, a long code line and a wide table). This pins the rules in the template, the
 * instrument `prompt-card-low-height.test.ts` uses on this file for the same reason.
 */
const CHATVIEW = readFileSync(fileURLToPath(new URL('./ChatView.svelte', import.meta.url)), 'utf-8');

/** The classes of the question box: the one opening tag that carries `data-prompt-markdown`. */
function boxClasses(): string[] {
	const tags = [...CHATVIEW.matchAll(/<div\b[^>]*>/g)].map((m) => m[0]).filter((tag) => tag.includes('data-prompt-markdown'));
	expect(tags, 'exactly one tag carries data-prompt-markdown').toHaveLength(1);
	const cls = /\bclass="([^"]*)"/.exec(tags[0]!);
	expect(cls, 'the box has a class attribute').not.toBeNull();
	return cls![1]!.split(/\s+/).filter(Boolean);
}

/**
 * Tags whose content wraps at the box's width without a rule of their own: they inherit the box's
 * `overflow-wrap: anywhere`, and none keeps its white-space. `pre` keeps it, and a table in its
 * automatic layout is at least as wide as its widest cell, so those two need the box's rules.
 */
const WRAPS_UNAIDED = ['p', 'br', 'strong', 'em', 'del', 'code', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'hr', 'thead', 'tbody', 'tr', 'th', 'td'];

describe('a question in the question card hides nothing sideways', () => {
	it('every word in the box may break', () => {
		expect(boxClasses()).toContain('[overflow-wrap:anywhere]');
	});

	it('a code block keeps its line breaks and wraps its long lines', () => {
		const cls = boxClasses();
		expect(cls).toContain('[&_pre]:whitespace-pre-wrap');
		expect(cls).toContain('[&_pre]:max-w-full');
	});

	it('a table takes the box\'s width and wraps inside its cells', () => {
		const cls = boxClasses();
		expect(cls).toContain('[&_table]:w-full');
		expect(cls).toContain('[&_table]:table-fixed');
	});

	it('a cell breaks a word only where the word does not fit its column', () => {
		const cls = boxClasses();
		for (const cell of ['th', 'td']) expect(cls, cell).toContain(`[&_${cell}]:[overflow-wrap:break-word]`);
	});

	it('nothing in the box scrolls sideways or keeps a line from wrapping', () => {
		const sideways = boxClasses().filter((c) => /overflow-x-(auto|scroll)|overflow-(auto|scroll)$|whitespace-(nowrap|pre)$|_table\]:block|table-auto|w-max|min-w-max/.test(c));
		expect(sideways).toEqual([]);
	});

	it('every tag the question can carry either wraps unaided or has its rule in the box', () => {
		const ruled = ['pre', 'table'];
		const unknown = PROMPT_EMITTED_TAGS.filter((t) => !WRAPS_UNAIDED.includes(t) && !ruled.includes(t));
		expect(unknown, 'a new tag: decide whether it wraps, and add its rule to the box if not').toEqual([]);
		for (const t of ruled) expect(PROMPT_EMITTED_TAGS, t).toContain(t);
	});
});
