import { marked } from 'marked';
import DOMPurify from 'dompurify';

import { fixMarkdownPreprocessing, repairCodeFences } from './markdown-preprocess.js';
import { externalizeLinksInDom, wrapTablesInDom } from './external-links.js';

/**
 * The sanitized markdown pipeline for chat messages — and this module exists so
 * that "the sanitized pipeline" is a FILE rather than a guess.
 *
 * The pipeline used to be a function inside `MarkdownRenderer.svelte`. The
 * property it has to hold is "no string rewrite runs over the sanitized HTML",
 * and that is a property of the CODE, not of a run: the breakout it prevents is
 * only reachable on an engine whose `innerHTML` serialiser returns `<`/`>` raw
 * in attributes, so no current parser can be made to demonstrate it. The test
 * therefore reads source — and while the pipeline sat in a component full of
 * legitimate string rewrites, reading source meant slicing the function out with
 * a regex. That slice had two measured failure directions: a `}` at the wrong
 * indentation inside the body truncated it (false red), and de-indenting the
 * function let the interesting code fall outside it (false green). A sliced
 * scope is a guess about where a property lives. A file is not.
 *
 * So: nothing in this file may rewrite a string. Everything that legitimately
 * does — `decodeEntities`, the fence substitution, the artifact paths — stays in
 * the component, where no such rule applies. `markdown-render.test.ts` holds
 * that line over this whole file.
 */

/**
 * Render chat markdown: sanitise, mutate NODES, then serialise ONCE.
 *
 * ## The defect this shape exists to prevent
 *
 * The link and table passes used to be string rewrites that ran AFTER
 * `DOMPurify.sanitize` — `html.replace(/<a\b[^>]*>/gi, …)` and
 * `html.replace(/<table\b[^>]*>/g, …)`. A regex over sanitized HTML can match
 * into an ATTRIBUTE VALUE. DOMPurify returns `body.innerHTML`, and until the
 * 2025 serializer change (Chromium 138, Firefox 140, WebKit 26) attribute-mode
 * escaping touched only `&`, `"` and NBSP — `<` and `>` came back RAW. So on an
 * older engine (an iOS ≤ 18 device is the realistic population) a sanitized
 * `title="x>…"` let the match end inside the attribute, the replacement's own
 * `"` terminated it, and its `>` closed the tag. See `utils/external-links.ts`
 * for the measurement and the rule.
 *
 * `RETURN_DOM_FRAGMENT` keeps the whole thing in one parse: DOMPurify hands back
 * nodes it has already cleaned, the passes mutate those nodes, and the single
 * serialisation at the end is the first time this becomes a string again. A raw
 * `>` in an attribute survives that round trip as part of the attribute, which
 * is exactly what it should be.
 */
export function renderSanitizedMarkdown(src: string): string {
	const html = marked.parse(repairCodeFences(fixMarkdownPreprocessing(src)), { async: false }) as string;
	const fragment = DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true });
	externalizeLinksInDom(fragment);
	wrapTablesInDom(fragment);
	// `ownerDocument` rather than the ambient `document`: the fragment belongs to
	// DOMPurify's own document, so building the container there leaves the nodes
	// where they already are.
	//
	// ⚠ NOT because a container from another document could not take them. An
	// earlier version of this comment said it "cannot adopt it", and that is
	// wrong: `appendChild` adopts. Measured — a node appended across documents
	// arrives in the new one and leaves its old parent, and the same holds for a
	// DocumentFragment. The only reason to use `ownerDocument` is that there is
	// no point forcing an adoption that buys nothing.
	const holder = (fragment.ownerDocument ?? document).createElement('div');
	holder.appendChild(fragment);
	return holder.innerHTML;
}
