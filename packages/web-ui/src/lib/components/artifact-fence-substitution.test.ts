import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';

/**
 * `processBlocks` substitutes each rendered fence back into the message by
 * `result.replace(original, replacement)`, where both arguments are strings.
 *
 * With a STRING replacement, `replace` reads `$` sequences in it as a template:
 * `$&` is the match, `` $` `` and `$'` the text around it, `$1` a capture group.
 * The replacement is built from the fence BODY, i.e. from content — so a `$`
 * sequence an author wrote was read as an instruction, and what it pasted in was
 * the surrounding markup. A replacer FUNCTION is inserted verbatim.
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

	it('⭐ the production line uses the function form', () => {
		// Ties the mechanism above to the code that runs. A string replacement here
		// is the defect; the regex allows any whitespace but not a bare identifier.
		expect(RENDERER).toMatch(/result\.replace\(original,\s*\(\)\s*=>\s*replacement\)/);
		expect(RENDERER).not.toMatch(/result\.replace\(original,\s*replacement\)/);
		// Positive control for both directions of that pair.
		expect('result.replace(original, replacement)').not.toMatch(/result\.replace\(original,\s*\(\)\s*=>\s*replacement\)/);
		expect('result.replace(original, () => replacement)').not.toMatch(/result\.replace\(original,\s*replacement\)/);
	});
});
