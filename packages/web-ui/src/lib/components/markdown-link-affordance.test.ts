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
	 * ⭐ THE POINT, and the reason a plain "is it called?" check is not enough:
	 * the rewrite adds attributes to anchors, so it must run on markup the
	 * sanitizer has already cleaned. Running it BEFORE `DOMPurify.sanitize`
	 * would mean decorating tags that are not yet known to be anchors, and the
	 * sanitizer could then strip or reshape what was just added.
	 */
	it('⭐ externalizes links AFTER DOMPurify has sanitized, never before', () => {
		const pipeline = RENDERER.match(/wrapTables\([\s\S]*?\)\s*\)?\s*\n?\s*\)/)?.[0] ?? '';
		expect(pipeline).toContain('externalizeLinks');
		const sanitizeAt = pipeline.indexOf('DOMPurify.sanitize');
		const externalizeAt = pipeline.indexOf('externalizeLinks');
		expect(sanitizeAt).toBeGreaterThan(-1);
		expect(externalizeAt).toBeGreaterThan(-1);
		// `externalizeLinks(DOMPurify.sanitize(...))` — the sanitize call sits
		// INSIDE, so it appears later in the source text.
		expect(sanitizeAt).toBeGreaterThan(externalizeAt);
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
