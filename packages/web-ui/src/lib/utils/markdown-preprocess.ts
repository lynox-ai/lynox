/**
 * Pre-processing for raw markdown before marked.parse, to undo two patterns
 * that LLM streamed output regularly produces but CommonMark won't render:
 *
 * 1. Concatenated sentences from streamed tool-call gaps — period directly
 *    followed by a capital letter without a separating space. Split into
 *    paragraphs so the chat reads as intended.
 *    Skips abbreviations whose stem is ≤2 letters (z.B., d.h., U.S., …).
 *
 * 2. Heading lines the agent emits without a space ("###2. Title") or with
 *    1-3 spaces of leading indentation. Both bypass marked's heading rule
 *    and end up as `<p>###2. Title</p>` or a `<pre><code>` indented code
 *    block. We normalise them. 4+ leading spaces is a real indented code
 *    block and is left alone; 7+ hashes is a paragraph and is left alone.
 *
 * Code fences (``` … ```) are preserved verbatim. Table rows (lines with `|`)
 * are skipped to avoid breaking aligned columns.
 */
export function fixMarkdownPreprocessing(md: string): string {
	const parts = md.split(/(```[\s\S]*?```)/g);
	return parts.map((part, i) => {
		if (i % 2 !== 0) return part; // inside code block — leave alone
		return part.split('\n').map((line) => {
			if (line.includes('|')) return line; // table row
			let fixed = line.replace(/^(#{1,6})(?=[^#\s])/, '$1 ');
			fixed = fixed.replace(/^ {1,3}(#{1,6} )/, '$1');
			return fixed.replace(/(?<!\b[a-zäöüA-ZÄÖÜ]{1,2})([.!?])([A-ZÄÖÜ])/g, '$1\n\n$2');
		}).join('\n');
	}).join('');
}
