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

/**
 * Repair an odd number of code fences. When the LLM leaves a fence open,
 * naively appending a closing fence drags the entire remainder into a
 * `<pre><code>` — which renders the response as raw markdown source and
 * blows up the chat container width. We do better:
 *
 * - If the content after the unclosed fence contains markdown structure
 *   (ATX headings, table rows, bold, list markers), the opening fence was
 *   almost certainly the LLM wrapping its answer in ```markdown / ```md.
 *   Strip the opening fence and let marked render it as prose.
 * - Otherwise (looks like real code), append a closing fence so the rest
 *   doesn't fall off the parser's state.
 *
 * Counts only fences that are alone on a line (`^```\w*\s*$`), matching
 * marked's recognition rule.
 */
export function repairCodeFences(md: string): string {
	const validFence = /^```\w*\s*$/gm;
	const fences = [...md.matchAll(validFence)];
	if (fences.length % 2 === 0) return md;

	const lastOpen = fences[fences.length - 1];
	if (!lastOpen || lastOpen.index === undefined) return md + '\n```';
	const after = md.slice(lastOpen.index + lastOpen[0].length);
	if (looksLikeMarkdown(after)) {
		return md.slice(0, lastOpen.index) + after;
	}
	return md + '\n```';
}

/** Heuristic: does this string contain enough markdown structure that
 *  rendering it as prose is more useful than as a code block? */
function looksLikeMarkdown(s: string): boolean {
	let signals = 0;
	if (/^#{1,6}\s+\S/m.test(s)) signals++;          // ATX heading
	if (/^\s*\|.*\|\s*$/m.test(s)) signals++;         // table row
	if (/\*\*[^*\n]+\*\*/.test(s)) signals++;          // bold
	if (/^\s*[-*+]\s+\S/m.test(s)) signals++;          // bullet list
	if (/^\s*\d+\.\s+\S/m.test(s)) signals++;          // numbered list
	return signals >= 2;
}
