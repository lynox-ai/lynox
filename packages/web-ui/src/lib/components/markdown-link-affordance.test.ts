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
	 * remembers them does not conclude the requirements were dropped. Names as
	 * they read NOW, because a note whose point is findability has to be greppable:
	 *
	 *   · "⭐ sanitizes to a DOM fragment and mutates nodes, never a string"
	 *     → became "⭐ asks the sanitizer for NODES, which is what makes the
	 *       passes node passes" — and it is now an OBSERVED call option rather
	 *       than a string found in the source.
	 *   · "runs no string replace inside the sanitized pipeline"
	 *     → became "⭐ keeps a raw `>` in an attribute inside that attribute —
	 *       the string rewrite did not". The old one asserted on source text; the
	 *       new one runs the pipeline and measures the breakout.
	 *   · "imports the helper it calls" → the component no longer imports the
	 *     passes, the pipeline does, so the assertion followed the import and the
	 *     witnesses above cover that the passes actually run.
	 *
	 * All three now live in `utils/markdown-render.test.ts`. The reason for the
	 * move is NOT that the regex slice they used was broken — for this shape a
	 * de-indented function makes the slice empty, which its own guard caught. It
	 * is that the property turned out to be RUNNABLE once the pipeline was
	 * importable, and a witness beats an assertion about text.
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
