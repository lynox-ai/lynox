import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';

import { substituteRenderedFences, type RenderedFence } from './fence-substitution.js';

/**
 * ⚠ THIS FILE REPLACES A SOURCE-TEXT ASSERTION, and the reason is the useful
 * part of the history.
 *
 * The substitution loop used to live inside `MarkdownRenderer.svelte`. Nothing
 * in this package mounts a component, so the property — "a `$` sequence in the
 * replacement arrives verbatim" — could not be run. What stood in for it was a
 * regex over the component's source asserting that the second argument to
 * `replace` was a function. Three versions of that assertion were measured, and
 * each was wrong in BOTH directions. The last one accepted
 *
 *   replace(original, replacement,)        a trailing comma from a multi-line call
 *   const r = replacement; replace(original, r)
 *   replace(original, String(replacement))
 *   replace(original, `${replacement}`)
 *   replace(original, replacement as string)
 *   replace(original, /* a block comment *\/ replacement)
 *
 * — every one of them the original defect — and REFUSED four correct forms,
 * including `replaceAll(original, () => replacement)` and keeping the correct
 * line while quoting the old one in a `/* *\/` comment.
 *
 * The lesson is not "write a better regex". It is that the set of spellings has
 * no end, because whoever writes the next edit picks the spelling. Exported, the
 * property is measured directly: every spelling above fails the first test in
 * this file, for the same reason, without being named.
 *
 * The effect is measured as an ELEMENT and not as a substring — the lesson from
 * the sibling change, where an assertion that some text was "present" held while
 * the document that text belonged to was broken.
 */

/** The shape this change removed, kept verbatim so the fixtures can be proven live. */
function substituteAsString(html: string, fences: readonly RenderedFence[]): string {
	let out = html;
	for (const { original, result } of fences) {
		if (original) out = out.replace(original, result);
	}
	return out;
}

const fence = (original: string, result: string): RenderedFence => ({ original, result });
const doc = (html: string) => parseHTML(`<html><body>${html}</body></html>`).document;

/** A rendered fence, and the block that takes its place. */
const MATCH = '<pre id="m">x</pre>';
const HTML = `<p>before</p>${MATCH}<p>after</p>`;

describe('substituteRenderedFences', () => {
	it('⭐ inserts the replacement verbatim, so fence content cannot pull markup in', () => {
		// The `$&` sits where fence CONTENT ends up: text an author typed, not a
		// pattern anyone wrote.
		const replacement = '<div id="rep">$&</div>';

		// Positive control for the fixture: the removed form DOES pull the match
		// in, or the assertions below would hold for an unrelated reason.
		const foil = doc(substituteAsString(HTML, [fence(MATCH, replacement)]));
		expect(
			foil.querySelector('#rep #m'),
			'the string form no longer expands, so this fixture proves nothing',
		).not.toBeNull();

		const out = doc(substituteRenderedFences(HTML, [fence(MATCH, replacement)]));
		expect(out.querySelector('#rep #m')).toBeNull();
		expect(out.querySelector('#rep')?.textContent).toBe('$&');
		expect(out.querySelectorAll('#rep').length).toBe(1);
		expect(out.querySelectorAll('#m').length).toBe(0);
	});

	it('leaves every template sequence as the text it was', () => {
		// ⚠ `$1` and `$<name>` are GUARDS, not discriminators: with a string
		// pattern the removed form left them verbatim too, so they pass against
		// the defect. They earn their place only if someone later hands a RegExp
		// WITH a capture group in as `original`.
		//
		// ⚠ And this block asserts on the STRING, not on a parsed element, which
		// is the opposite of the test above it. Checking `#rep`'s textContent
		// cost a false failure here: `$<name>` does arrive verbatim, but the HTML
		// parser then reads `<name>` as a TAG, so the text node is just `$`. The
		// assertion was destroying the evidence it was there to find. Verbatim
		// insertion is a property of the string, so the string is what gets
		// measured; the element-level assertion belongs one test up, where
		// "the substring is present" was the thing that wasn't enough.
		const discriminating = ['$&', '$`', "$'", '$$'];
		for (const seq of [...discriminating, '$1', '$<name>']) {
			const replacement = `<div id="rep">${seq}</div>`;
			const out = substituteRenderedFences(HTML, [fence(MATCH, replacement)]);
			expect(out, `sequence ${seq} was expanded`).toContain(replacement);
		}
		// …and the other four really do discriminate, so the loop above is not
		// four restatements of "nothing happens".
		for (const seq of discriminating) {
			const replacement = `<div id="rep">${seq}</div>`;
			expect(
				substituteAsString(HTML, [fence(MATCH, replacement)]),
				`${seq} does not discriminate between the two forms`,
			).not.toBe(substituteRenderedFences(HTML, [fence(MATCH, replacement)]));
		}
	});

	it('puts the replacement where the fence was', () => {
		const d = doc(substituteRenderedFences(HTML, [fence(MATCH, '<div id="rep">ok</div>')]));
		expect(d.querySelector('#rep')).not.toBeNull();
		expect(d.querySelectorAll('#m').length).toBe(0);
		// And between the two paragraphs, not appended.
		expect(d.body.children[1]?.id).toBe('rep');
	});

	it('substitutes every fence, not just the first', () => {
		const a = '<pre id="a">1</pre>';
		const b = '<pre id="b">2</pre>';
		const d = doc(substituteRenderedFences(`${a}${b}`, [
			fence(a, '<i id="ra">A</i>'),
			fence(b, '<i id="rb">B</i>'),
		]));
		expect(d.querySelector('#ra')).not.toBeNull();
		expect(d.querySelector('#rb')).not.toBeNull();
		expect(d.querySelectorAll('pre').length).toBe(0);
	});

	it('skips a fence with an empty `original` instead of prepending it', () => {
		// `''` matches at position 0, so without the guard an empty `original`
		// injects its replacement at the top of the message.
		const out = substituteRenderedFences('<p>only</p>', [fence('', '<b id="ghost">x</b>')]);
		expect(doc(out).querySelector('#ghost')).toBeNull();
		expect(out).toBe('<p>only</p>');
	});
});

describe('the renderer routes through it', () => {
	/**
	 * The one thing the extraction cannot prove by running: that the component
	 * still calls this function. So this is the only source-text assertion left,
	 * and it is deliberately a single bounded one — the symbol is either called
	 * or it is not, which is not a spelling anyone has to guess.
	 *
	 * What it does NOT cover, said rather than regexed at: the call could stay
	 * and a second, inline substitution be added beside it. That substitutes
	 * twice and breaks the rendering visibly — a different failure from the
	 * silent one this module exists for. And renaming the function reddens this
	 * test, which is correct: a test names the symbol it depends on.
	 */
	it('⭐ MarkdownRenderer substitutes through this module', () => {
		const src = readFileSync(
			fileURLToPath(new URL('../components/MarkdownRenderer.svelte', import.meta.url)),
			'utf-8',
		);
		expect(
			src,
			'the renderer no longer calls substituteRenderedFences — a loop is back inside the component',
		).toContain('substituteRenderedFences(');
	});
});
