import { marked } from 'marked';
import DOMPurify from 'dompurify';

import { fixMarkdownPreprocessing, repairCodeFences } from './markdown-preprocess.js';
import { externalizeLinksInDom, wrapTablesInDom } from './external-links.js';

/**
 * The sanitized markdown pipeline for chat messages.
 *
 * It lives in its own module so that it can be RUN. The property that matters —
 * "a raw `>` an attacker put in an attribute stays inside that attribute" —
 * cannot be observed while the pipeline is a closure inside a `.svelte`
 * component, because nothing in this package mounts a component. Exported, it
 * can be driven with a stubbed sanitizer, and `markdown-render.test.ts` does
 * exactly that, end to end, on the markdown that produces the payload.
 *
 * ⚠ An earlier version of this comment claimed the breakout could not be
 * demonstrated by any current parser. That was FALSE, and it was load-bearing:
 * it was the whole argument for guarding this with an assertion about source
 * TEXT instead of a witness. Measured — `linkedom` is a current parser and it
 * leaves `<`, `>`, `&` and NBSP raw in attribute values, so the dangerous round
 * trip is available in this package's own test environment.
 *
 * ## The rule, and why it is prose
 *
 * **Never run a string rewrite over sanitized HTML. Mutate nodes, serialise
 * once.** That rule is written down and deliberately NOT mechanised. A source
 * negative on `.replace(`/`.replaceAll(` was tried here and an adversarial round
 * put five evasions through it against a green baseline: `split`/`join`,
 * computed member access (`['replace']`), a space before the paren,
 * `RegExp.prototype[Symbol.replace]`, and a plain `.replace(` hidden from the
 * comment stripper by a `/*` inside a line comment. The set of pattern-driven
 * string operations is not closed, so no such check can be — and an evadable
 * guard is worse than none, because it reports green and takes the pressure off
 * the rule.
 *
 * What IS held mechanically is the PROPERTY, which is the thing the rule exists
 * for: all six of those spellings die on the witness, because it does not care
 * how a rewrite is written, only whether its pattern can end inside an
 * attribute. A rewrite that cannot overrun — anchored before any attribute, say
 * — breaks the rule and passes the witness. That is the correct split and not a
 * gap: the rule is a coding guideline, the property is the security boundary.
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
	// ⚠ `?? document` is unreachable at runtime, not a fallback anyone will take:
	// only a Document node has a null `ownerDocument`, and this is a fragment. It
	// is there to satisfy `Node.ownerDocument: Document | null`, so no test can
	// cover that branch — said here rather than left to look like dead defence.
	const holder = (fragment.ownerDocument ?? document).createElement('div');
	holder.appendChild(fragment);
	return holder.innerHTML;
}
