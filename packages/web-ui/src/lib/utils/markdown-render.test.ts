import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * ⚠ THIS FILE ASSERTS ON SOURCE TEXT, and that is a deliberate choice with a
 * reason — not a shortcut around a test that was hard to write.
 *
 * The property is "nothing in the sanitized pipeline rewrites a string". It
 * cannot be run: the breakout it prevents needs an engine whose `innerHTML`
 * serialiser returns `<`/`>` raw inside attributes, and no current parser does.
 * `DOMPurify.sanitize` is also not a function outside a browser, so the pipeline
 * cannot even be called here. What a run CAN show is that the DOM passes behave
 * — `external-links.test.ts` does exactly that. What is left over is this.
 *
 * ## What a source assertion may and may not be used for
 *
 * A sibling change learned this the expensive way. An assertion that pinned the
 * SPELLING of an argument was wrong in both directions, because the set of
 * spellings has no end — whoever writes the next edit picks it. That is not the
 * situation here. The question is "which METHOD rewrites a string", and
 * `String.prototype` has exactly two that take a pattern: `replace` and
 * `replaceAll`. A closed set can be refused; an open one cannot.
 *
 * The other half of that lesson is SCOPE. This used to slice `renderMarkdown`
 * out of a component with a regex, and the slice had two measured failure
 * directions: a `}` at the wrong indentation inside the body truncated it (false
 * red), and de-indenting the function let the interesting code fall outside it
 * (false green). The pipeline now lives in a file of its own, so the scope is
 * the file. Nothing has to guess where the property lives.
 */
const MODULE_PATH = new URL('./markdown-render.ts', import.meta.url);
const MODULE = readFileSync(fileURLToPath(MODULE_PATH), 'utf-8');
const RENDERER = readFileSync(
	fileURLToPath(new URL('../components/MarkdownRenderer.svelte', import.meta.url)),
	'utf-8',
);

/**
 * Comments out, BOTH syntaxes. A comment *about* a string rewrite is not a
 * string rewrite, and the sibling tripwire that stripped only `//` was a false
 * red on the next person to document the change in a `/* *\/` block.
 *
 * ⚠ Known limit, stated rather than papered over: this would also strip a `/*`
 * that appeared inside a string literal. The module has none, and the control
 * below shows the stripper leaves real code standing.
 */
function codeOnly(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** …and the import block, so statement order means statement order. */
function bodyCode(src: string): string {
	return codeOnly(src)
		.split('\n')
		.filter((line) => !line.startsWith('import '))
		.join('\n');
}

describe('the sanitized markdown pipeline', () => {
	it('is the file this test thinks it is', () => {
		// Without this every assertion below passes vacuously if the read ever
		// points somewhere else. A sibling test had exactly this gap.
		expect(MODULE, 'markdown-render.ts does not export the pipeline').toContain(
			'export function renderSanitizedMarkdown(',
		);
	});

	/**
	 * ⭐ THE POINT, and the requirement has not changed — only the instrument.
	 *
	 * The link work adds attributes to anchors, so it must run on markup the
	 * sanitizer has already cleaned. Running it BEFORE `DOMPurify.sanitize` would
	 * decorate tags not yet known to be anchors, and the sanitizer could strip or
	 * reshape what was just added. That still holds.
	 *
	 * ⚠ What changed is that "after the sanitizer" is not enough. Both passes
	 * used to be STRING rewrites over the sanitized HTML, and the earlier version
	 * of this test pinned the ORDER of a nested call chain and was green
	 * throughout — because the order was never the defect. The string was.
	 */
	it('⭐ sanitizes to a DOM fragment and mutates nodes, never a string', () => {
		const code = bodyCode(MODULE);
		const sanitizeAt = code.indexOf('DOMPurify.sanitize');
		const linksAt = code.indexOf('externalizeLinksInDom');
		const tablesAt = code.indexOf('wrapTablesInDom');
		expect(sanitizeAt, 'the sanitizer call is gone').toBeGreaterThan(-1);
		expect(linksAt, 'the link pass is gone').toBeGreaterThan(-1);
		expect(tablesAt, 'the table pass is gone').toBeGreaterThan(-1);
		expect(sanitizeAt, 'the link pass runs before the sanitizer').toBeLessThan(linksAt);
		expect(sanitizeAt, 'the table pass runs before the sanitizer').toBeLessThan(tablesAt);
		// A fragment, not a string — this is what makes "after" sufficient.
		expect(code, 'the sanitizer hands back a string again').toContain('RETURN_DOM_FRAGMENT');
	});

	it('⭐ runs no string rewrite over the sanitized markup', () => {
		const code = bodyCode(MODULE);
		expect(code, 'a `.replace(` is back in the sanitized pipeline').not.toContain('.replace(');
		expect(code, 'a `.replaceAll(` is back in the sanitized pipeline').not.toContain('.replaceAll(');
	});

	it('imports the helpers it calls', () => {
		// Moved here from `markdown-link-affordance.test.ts`, which asserted this
		// against the COMPONENT. The component no longer imports the passes — the
		// pipeline does — so the assertion followed the import rather than being
		// dropped.
		expect(MODULE).toContain("from './external-links.js'");
		expect(MODULE).toContain("from './markdown-preprocess.js'");
	});

	it('the renderer gets its markdown from this module', () => {
		// The one thing the file scope cannot prove: that anybody calls it. A
		// rename reddens this, which is correct — a test names what it depends on.
		expect(
			RENDERER,
			'MarkdownRenderer no longer calls renderSanitizedMarkdown — the pipeline is back in the component',
		).toContain('renderSanitizedMarkdown(');
	});

	describe('the instrument itself', () => {
		// Each of these failed in an earlier version of this tripwire. They are
		// controls, not decoration: without them a stripper that deleted
		// everything, or a detector that matched nothing, would read as a pass.
		it('strips both comment syntaxes and leaves the code', () => {
			const sample = [
				'/* was: out.replace(a, b) */',
				'// also: out.replaceAll(c, d)',
				'const kept = fn(x);',
				'/** doc with out.replace(e, f) */',
			].join('\n');
			const out = codeOnly(sample);
			expect(out, 'a commented-out rewrite is still being read as code').not.toContain('.replace(');
			expect(out, 'the stripper ate the code too').toContain('const kept = fn(x);');
		});

		it('catches a rewrite that is really there', () => {
			expect(codeOnly('const y = x.replace(/<a/g, z);')).toContain('.replace(');
			expect(codeOnly('const y = x.replaceAll("<a", z);')).toContain('.replaceAll(');
		});

		it('drops imports without dropping statements', () => {
			const out = bodyCode("import { a } from './a.js';\nconst b = a(1);\n");
			expect(out).not.toContain('import {');
			expect(out).toContain('const b = a(1);');
		});
	});
});
