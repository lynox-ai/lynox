import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';

/**
 * `processBlocks` substitutes each rendered fence back into the message. It USED
 * to do that with a string replacement — the past tense matters, because the same
 * commit removes it and a reader who greps for the old expression should find it
 * only here.
 *
 * With a STRING replacement, `replace` reads `$` sequences in it as a template.
 * Live at that call site, measured: `$&` is the match, `` $` `` and `$'` the text
 * around it, `$$` collapses to one `$`. `$1` and `$<name>` are inert, because the
 * pattern is a string and there are no capture groups. The replacement is built
 * from the fence BODY, i.e. from content — so a `$` sequence an author wrote was
 * read as an instruction. A replacer FUNCTION is inserted verbatim.
 *
 * ## Why this file has two halves
 *
 * The loop lives inside a `.svelte` component, and this package has no component
 * renderer in its tests — the same constraint `markdown-link-affordance.test.ts`
 * and `secret-prompt-frame.test.ts` work under. So one half asserts that the
 * production line uses the function form, and the other measures what that form
 * changes. Neither is sufficient alone: the mechanism test on its own is a mirror
 * of code nobody loads, and the source assertion on its own says nothing about
 * why the form matters.
 *
 * The effect is measured as an ELEMENT, not as a substring. That is the lesson
 * from the sibling change: an assertion that the literal text is "present" can
 * hold while the document that text belongs to is broken.
 */
const RENDERER = readFileSync(
	fileURLToPath(new URL('./MarkdownRenderer.svelte', import.meta.url)),
	'utf-8',
);

/** The two forms, side by side, over the same inputs. */
function substituteWithString(html: string, original: string, replacement: string): string {
	return html.replace(original, replacement);
}
function substituteWithFunction(html: string, original: string, replacement: string): string {
	return html.replace(original, () => replacement);
}

describe('fence substitution', () => {
	// A rendered fence (the match) and the block that replaces it. The `$&` sits
	// where fence CONTENT ends up — it is text an author typed, not a pattern.
	const MATCH = '<pre id="m">x</pre>';
	const HTML = `<p>before</p>${MATCH}<p>after</p>`;
	const REPLACEMENT = '<div id="rep">$&</div>';

	const rep = (out: string) => parseHTML(`<html><body>${out}</body></html>`).document;

	it('⭐ inserts the replacement verbatim, so content cannot pull markup in', () => {
		// Positive control for the fixture: the string form DOES pull the match in,
		// or the assertion below would hold for a reason unrelated to the change.
		const asString = rep(substituteWithString(HTML, MATCH, REPLACEMENT));
		expect(
			asString.querySelector('#rep #m'),
			'the string form no longer expands, so this fixture proves nothing',
		).not.toBeNull();

		// The function form: no element from the match appears inside the
		// replacement, and the `$&` stays as the text it was.
		const asFunction = rep(substituteWithFunction(HTML, MATCH, REPLACEMENT));
		expect(asFunction.querySelector('#rep #m')).toBeNull();
		expect(asFunction.querySelector('#rep')?.textContent).toBe('$&');
		// Measured as elements: exactly one `#rep`, and no `#m` anywhere.
		expect(asFunction.querySelectorAll('#rep').length).toBe(1);
		expect(asFunction.querySelectorAll('#m').length).toBe(0);
	});

	it('leaves the other template sequences alone too', () => {
		// ⚠ `$1` is in this list as a GUARD, not as a discriminator: at this call
		// site the pattern is a string, so the old form left `$1` verbatim as well.
		// It would pass against the defect. The other four do discriminate, which
		// is what keeps the block from being vacuous — and `$1` earns its place
		// only if someone later passes a RegExp pattern here, where it would stop
		// being inert.
		for (const seq of ['$&', '$`', "$'", '$1', '$$']) {
			const out = substituteWithFunction(HTML, MATCH, `<div id="rep">${seq}</div>`);
			expect(rep(out).querySelector('#rep')?.textContent, `sequence ${seq} was expanded`).toBe(seq);
		}
	});

	it('still substitutes — the replacement does land where the match was', () => {
		const d = rep(substituteWithFunction(HTML, MATCH, '<div id="rep">ok</div>'));
		expect(d.querySelector('#rep')).not.toBeNull();
		expect(d.querySelectorAll('#m').length).toBe(0);
		// And in the right place: between the two paragraphs.
		expect(d.body.children[1]?.id).toBe('rep');
	});

	/**
	 * ⚠ SCOPED TO THE LOOP BODY, COMMENT-STRIPPED, WHITESPACE-NORMALISED — and
	 * stated as a NEGATIVE on the defect rather than a positive on one spelling.
	 * The first version was a whole-file regex for `result.replace(original, () =>
	 * replacement)`, and a review measured both of its failure directions:
	 *
	 *   · FALSE GREEN. The live line reverted to the string form with one extra
	 *     space (`original , replacement`), while the correct form still appeared
	 *     in a comment — the positive regex found the comment, the negative one
	 *     missed the defect, and the suite went green on reintroduced-defect code.
	 *   · FALSE RED, five ways. `function keep() {…}`, an anonymous `function`,
	 *     `(_m) => replacement`, `() => { return replacement; }` and the same call
	 *     split across lines are all correct and all failed. So did keeping the
	 *     correct line while quoting the old one in a comment — i.e. it reddened
	 *     the next person to document this change.
	 *
	 * Pinning one spelling is the wrong shape: the property is "the second
	 * argument is not the bare string". So the check slices the loop body (the
	 * property's domain), drops `//` comments (a comment about the defect is not
	 * the defect — the same distinction a sibling tripwire got wrong), collapses
	 * whitespace, and then refuses the one spelling that IS the defect. Every
	 * correct refactor passes; `original , replacement` does not.
	 */
	it('⭐ the production line does not pass the replacement as a string', () => {
		const loop = RENDERER.match(/for \(const \{ original, result: replacement \} of results\) \{[\s\S]*?\n\t\t\}/)?.[0] ?? '';
		expect(loop, 'the substitution loop is gone or reshaped — this test cannot see it').not.toBe('');
		const code = loop.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '');

		// The defect, and the only thing refused.
		expect(code, 'the replacement is passed as a string, so `$` sequences in it expand').not.toContain('replace(original,replacement)');
		// It must still substitute at all — deleting the call is not a pass.
		expect(code).toContain('replace(original,');

		// Positive controls for both halves, over the shapes the review measured.
		const norm = (t: string) => t.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '');
		expect(norm('result.replace(original , replacement);')).toContain('replace(original,replacement)');
		expect(norm('result.replace(original,\n\treplacement);')).toContain('replace(original,replacement)');
		for (const correct of [
			'result.replace(original, () => replacement);',
			'result.replace(original, function keep() { return replacement; });',
			'result.replace(original, (_m) => replacement);',
			'result.replace(original, () => { return replacement; });',
			'result.replace(original,\n\t() => replacement);',
			'result.replace(original, () => replacement); // was: result.replace(original, replacement)',
		]) {
			expect(norm(correct), `a correct form was refused: ${correct}`).not.toContain('replace(original,replacement)');
		}
	});
});
