import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROMPT_EMITTED_TAGS, renderPromptSegments } from '../utils/prompt-markdown.js';

/** A class that keeps a line from wrapping, scrolls sideways, or sets a width the box cannot hold. */
const HOLDS_SIDEWAYS = /overflow-x-(auto|scroll|hidden)|overflow-(auto|scroll|hidden)!?$|\[overflow(-x)?:|whitespace-(nowrap|pre)!?$|text-nowrap|\[white-space:(pre|nowrap)\]|truncate|break-(keep|normal)|wrap-(normal|break-word)|overflow-wrap:normal|\[word-break:|_table\]:block|table-auto|\[table-layout:auto\]|(^|:)!?(min-)?w-(max|screen|[1-9]|\[)/;

/** Classes the check must refuse, so a regex that never matches cannot pass the tests below. */
const REFUSED = ['[&_pre]:overflow-x-auto', 'overflow-x-hidden', '[&_pre]:whitespace-pre', 'whitespace-nowrap!', 'text-nowrap', '[&_pre]:[white-space:nowrap]', 'truncate', '[&_td]:break-keep', '[&_td]:wrap-normal', '[&_td]:wrap-break-word', '[word-break:keep-all]', '[&_table]:block', '[&_table]:table-auto', '[table-layout:auto]', 'w-96', 'w-screen', 'min-w-max', 'w-[600px]', '[overflow-x:auto]'];

/** Classes it must let through: the box's own, and widths that cannot push it sideways. */
const ALLOWED = ['min-w-0', 'max-w-full', '[&_pre]:max-w-full', 'w-full', 'overflow-y-auto', '[overflow-wrap:anywhere]', '[&_pre]:[white-space:break-spaces]'];

/**
 * A question without a consent kind renders as markup in a box that scrolls downwards, and the
 * box counts the lines left below its edge. Nothing counted what lay to the RIGHT: a code block
 * scrolled sideways on its own, and so did a wide table, so a long line in either ran on past the
 * edge. With overlay scrollbars (phones, macOS) nothing showed that text was there, and the owner
 * could answer yes to a question whose end they had not seen.
 *
 * The box now wraps instead: a code block keeps its line breaks and wraps long lines, a table
 * takes the box's width and wraps inside its cells, and every word may break. So everything the
 * question holds lies below, where the count sees it. A code block wraps with `break-spaces`, not
 * `pre-wrap`: under `pre-wrap` a long run of spaces hangs invisibly at the line's end; under
 * `break-spaces` the spaces take room and wrap like any other character, so what a run of them
 * does to the lines can be seen.
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
 * `overflow-wrap: anywhere` and keep no white-space of their own. `pre` keeps it, and a table in
 * its automatic layout is at least as wide as its widest cell, so those two need the box's rules;
 * the parts of a table (`thead` … `td`) are laid out by that rule.
 */
const WRAPS_UNAIDED = ['p', 'br', 'strong', 'em', 'del', 'code', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'hr'];
const TABLE_PARTS = ['thead', 'tbody', 'tr', 'th', 'td'];

describe('a question in the question card hides nothing sideways', () => {
	it('every word in the box may break', () => {
		expect(boxClasses()).toContain('[overflow-wrap:anywhere]');
	});

	it('a code block keeps its line breaks and wraps its long lines, runs of spaces included', () => {
		const cls = boxClasses();
		expect(cls).toContain('[&_pre]:[white-space:break-spaces]');
		expect(cls).toContain('[&_pre]:max-w-full');
	});

	it('a table takes the box\'s width and wraps inside its cells', () => {
		const cls = boxClasses();
		expect(cls).toContain('[&_table]:w-full');
		expect(cls).toContain('[&_table]:table-fixed');
	});

	it('a cell keeps the box\'s word breaking, so a long word cannot widen its column', () => {
		const cells = boxClasses().filter((c) => /^\[&_(th|td|tr|thead|tbody|table)\]:/.test(c));
		expect(cells.filter((c) => /overflow-wrap|word-break|break-|wrap-/.test(c))).toEqual([]);
	});

	it('the check below refuses every class that holds a line sideways and lets the box\'s own through', () => {
		expect(REFUSED.filter((c) => !HOLDS_SIDEWAYS.test(c))).toEqual([]);
		expect(ALLOWED.filter((c) => HOLDS_SIDEWAYS.test(c))).toEqual([]);
	});

	it('nothing in the box scrolls sideways or keeps a line from wrapping', () => {
		const sideways = boxClasses().filter((c) => HOLDS_SIDEWAYS.test(c));
		expect(sideways).toEqual([]);
	});

	it('the box a value of outside text is shown in wraps like the text around it', () => {
		const html = renderPromptSegments([{ kind: 'frame', text: 'Send to ' }, { kind: 'value', text: 'a long value' }, { kind: 'frame', text: '?' }], { box: true });
		const boxes = [...html.matchAll(/<bdi\b[^>]*\bdata-foreign-value\b[^>]*>/g)].map((m) => m[0]);
		expect(boxes, 'the value is rendered in its box').toHaveLength(1);
		const cls = (/\bclass="([^"]*)"/.exec(boxes[0]!)?.[1] ?? '').split(/\s+/).filter(Boolean);
		expect(cls.length, 'the box has classes').toBeGreaterThan(0);
		expect(cls.filter((c) => HOLDS_SIDEWAYS.test(c) || /^(block|inline-block|flex|inline-flex|grid|inline-grid|table|inline-table|contents)$/.test(c))).toEqual([]);
	});

	it('every tag the question can carry either wraps unaided or has its rule in the box', () => {
		const ruled = ['pre', 'table'];
		const unknown = PROMPT_EMITTED_TAGS.filter((t) => !WRAPS_UNAIDED.includes(t) && !TABLE_PARTS.includes(t) && !ruled.includes(t));
		expect(unknown, 'a new tag: decide whether it wraps, and add its rule to the box if not').toEqual([]);
		for (const t of ruled) expect(PROMPT_EMITTED_TAGS, t).toContain(t);
	});
});
