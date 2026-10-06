import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Links in chat answers had no affordance and no target.
 *
 * There is no component renderer in this package's tests, so a source assertion
 * is the only instrument for a Svelte template — the same reasoning, and the
 * same file, as `secret-prompt-frame.test.ts`. To keep this from being a string
 * count it pins the ORDER of the render pipeline, which is the part that
 * carries a security consequence, and the ABSENCE of the style that caused the
 * complaint.
 */
const RENDERER = readFileSync(
	fileURLToPath(new URL('./MarkdownRenderer.svelte', import.meta.url)),
	'utf-8',
);

describe('MarkdownRenderer link affordance', () => {
	/**
	 * ⭐ THE POINT, and the requirement has not changed — only the instrument.
	 *
	 * The link work adds attributes to anchors, so it must run on markup the
	 * sanitizer has already cleaned. Running it BEFORE `DOMPurify.sanitize` would
	 * decorate tags not yet known to be anchors, and the sanitizer could strip or
	 * reshape what was just added. That still holds.
	 *
	 * ⚠ What changed is that "after the sanitizer" is no longer enough. Both
	 * passes used to be STRING rewrites over the sanitized HTML, and a regex over
	 * sanitized HTML can match into an attribute value — on an engine whose
	 * `innerHTML` serialiser returns `<`/`>` raw in attributes, the replacement's
	 * own quote terminated the attribute and its `>` closed the tag. The old
	 * version of this test pinned the ORDER of a nested call chain and was green
	 * throughout, because the order was never the defect: the string was.
	 *
	 * So this now pins the SHAPE: sanitize to a fragment, mutate nodes, serialise
	 * once — and it pins it in statement order, which is what the pipeline is now.
	 */
	it('⭐ sanitizes to a DOM fragment and mutates nodes, never a string', () => {
		const fn = RENDERER.match(/function renderMarkdown\(src: string\): string \{[\s\S]*?\n\t\}/)?.[0] ?? '';
		expect(fn, 'renderMarkdown is gone or renamed — this test cannot see the pipeline').not.toBe('');
		const sanitizeAt = fn.indexOf('DOMPurify.sanitize');
		const linksAt = fn.indexOf('externalizeLinksInDom');
		const tablesAt = fn.indexOf('wrapTablesInDom');
		expect(sanitizeAt).toBeGreaterThan(-1);
		expect(linksAt).toBeGreaterThan(-1);
		expect(tablesAt).toBeGreaterThan(-1);
		// Statements now, not nesting: both passes come AFTER the sanitize call.
		expect(linksAt).toBeGreaterThan(sanitizeAt);
		expect(tablesAt).toBeGreaterThan(sanitizeAt);
		// And the sanitizer hands back NODES, which is what makes the passes
		// node-passes rather than string rewrites.
		expect(fn).toContain('RETURN_DOM_FRAGMENT');
	});

	/**
	 * SCOPED to the function whose body IS the property's domain, after two
	 * broader versions were each wrong in a way worth recording.
	 *
	 * The property is "no string rewrite over SANITIZED html". V1 searched the
	 * whole file for the bare regex `/<a\b[^>]*>/` — and the renderer's own
	 * comment quotes that pattern to say what was removed, so a comment
	 * DOCUMENTING the defect read as the defect. V2 searched the whole file for
	 * `.replace(` applied to a tag pattern, and found a LIVE one at the artifact
	 * path: `clean.replace(/<head[^>]*>/, …)`. That one is **not** in this class —
	 * `clean` there is the raw body of a code fence, never passed through
	 * DOMPurify, and its containment is the sandboxed iframe plus the injected
	 * CSP meta. A tripwire that reddens correct code is worse than none.
	 *
	 * Both versions were correlates of the property. `renderMarkdown`'s body is
	 * the property's domain exactly: everything in it is downstream of
	 * `DOMPurify.sanitize`. A `.replace(` there is the defect, not a sign of it.
	 *
	 * ⚠ Still only a tripwire: a rewrite moved into a helper CALLED from here
	 * passes. The rule lives in `utils/external-links.ts`; the breakout witnesses
	 * live in its test, and they are what actually measure the behaviour.
	 */
	it('runs no string replace inside the sanitized pipeline', () => {
		const fn = RENDERER.match(/function renderMarkdown\(src: string\): string \{[\s\S]*?\n\t\}/)?.[0] ?? '';
		expect(fn, 'renderMarkdown is gone or renamed — this test cannot see the pipeline').not.toBe('');
		expect(fn).not.toContain('.replace(');
		// Positive control: the shape this is meant to catch must be visible to
		// the same check, or the absence above means nothing.
		expect('function renderMarkdown(src: string): string {\n\t\treturn x.replace(/<a/g, y);\n\t}')
			.toContain('.replace(');
	});

	it('imports the helper it calls', () => {
		expect(RENDERER).toContain("from '$lib/utils/external-links.js'");
	});

	/**
	 * ⭐ The complaint itself. `prose-a:no-underline` left a link distinguishable
	 * from body text by colour alone — which is also the one channel a
	 * colour-blind reader may not have. Asserting its ABSENCE is the assertion
	 * that matters; a fix that adds an underline while leaving the override in
	 * place would change nothing on screen.
	 */
	it('⭐ no longer strips the underline from links', () => {
		expect(RENDERER).not.toContain('prose-a:no-underline');
	});

	it('gives links a visible underline', () => {
		expect(RENDERER).toMatch(/prose-a:underline\b/);
	});
});
