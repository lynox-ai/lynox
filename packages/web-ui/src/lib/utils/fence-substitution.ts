/**
 * Substituting rendered code fences back into a message.
 *
 * This lives in its own module for ONE reason, and it is not tidiness: the
 * property that matters here is a RUNTIME property, and while the loop sat
 * inside `MarkdownRenderer.svelte` nothing in this package could measure it —
 * no test here mounts a component. What stood in for a measurement was an
 * assertion about the SOURCE TEXT of the component, and three successive
 * versions of that assertion were wrong in both directions: it accepted six
 * spellings of the defect (a trailing comma, an alias, `String(…)`, a template
 * literal, an `as string` cast, a block comment between the arguments) and
 * refused four correct ones. The set of spellings cannot be enumerated, because
 * whoever writes the next edit picks the spelling. Exported, the property is
 * checked directly and every one of those spellings fails the same test.
 */

export interface RenderedFence {
	/** The fence's markup as it appears in the message — a needle, not a pattern. */
	readonly original: string;
	/** What takes its place: highlighted code, an artifact placeholder, or the fence itself. */
	readonly result: string;
}

/**
 * Put each rendered fence back where its source fence was.
 *
 * A REPLACER FUNCTION, not the replacement string itself.
 *
 * `String.prototype.replace` reads a STRING replacement as a template: `$&`
 * becomes the match, `` $` `` and `$'` the text before and after it, and `$$`
 * collapses to a single `$`. `$1` and `$<name>` are inert at this call site —
 * `original` is a string, so the match has no capture groups — and listing them
 * as misfires would send a reader looking for something that never happened. A
 * function replacement is inserted verbatim; that is the documented way to opt
 * out of substitution.
 *
 * `result` is built from the fence BODY, i.e. from content. So a `$` sequence an
 * author wrote was being read as an instruction.
 *
 * ⚠ WHICH sequences are live depends on the fence's LANGUAGE, and the trigger is
 * wider than "somebody typed `$&`". The highlighter escapes to NUMERIC entities
 * (`&#x26;` for `&`, `&#x3C;` for `<`), so a lone `$` sitting directly before
 * such a character becomes a live `$&…` in the replacement. Measured over this
 * repo's own shiki: `$$` is live in every language tried; `$&` and `$<` are live
 * in `json`, `text`, `plaintext` and `md`, and NOT in `js`/`ts`, where the
 * highlighter splits the two characters into separate tokens so the sequence
 * never forms. Named entities (`&amp;`) reach this point only through
 * `processBlocks`' `catch` branch, which hands the unhighlighted fence back.
 */
export function substituteRenderedFences(html: string, fences: readonly RenderedFence[]): string {
	let out = html;
	for (const { original, result } of fences) {
		if (original) out = out.replace(original, () => result);
	}
	return out;
}
