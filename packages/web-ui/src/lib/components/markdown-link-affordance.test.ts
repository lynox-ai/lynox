import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Links in chat answers had no affordance and no target.
 *
 * There is no component renderer in this package's tests, so a source assertion
 * is the only instrument for a Svelte template — the same reasoning, and the
 * same file, as `secret-prompt-frame.test.ts`. What is left in here is the
 * TEMPLATE half: the ABSENCE of the style that caused the complaint, and the
 * presence of the one that answers it. The render pipeline's own assertions
 * moved to `utils/markdown-render.test.ts` when the pipeline became a module —
 * see the note below.
 */
const RENDERER = readFileSync(
	fileURLToPath(new URL('./MarkdownRenderer.svelte', import.meta.url)),
	'utf-8',
);

describe('MarkdownRenderer link affordance', () => {
	/**
	 * ⚠ THREE TESTS MOVED OUT OF THIS FILE, and this note is here so a reader who
	 * remembers them does not conclude the requirements were dropped:
	 *
	 *   · "sanitizes to a DOM fragment and mutates nodes, never a string"
	 *   · "runs no string replace inside the sanitized pipeline"
	 *   · "imports the helper it calls"
	 *
	 * All three asserted on the render pipeline, which no longer lives in this
	 * component — it is `utils/markdown-render.ts`, and they are in
	 * `utils/markdown-render.test.ts` with the same requirements and a better
	 * scope. They used to slice `renderMarkdown` out of this file with a regex,
	 * and that slice had two measured failure directions: a `}` at the wrong
	 * indentation inside the body truncated it, and de-indenting the function let
	 * the interesting code fall outside it. A file scope has neither.
	 *
	 * What stays here is what is genuinely about the component's template.
	 */

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
