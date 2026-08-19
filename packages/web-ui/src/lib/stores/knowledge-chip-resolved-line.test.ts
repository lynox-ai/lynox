import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A resolved review chip must not read as the tail of its own warning.
 *
 * Observed 2026-08-19 on a live thread. The chip stacked the CAUSE (why this fact was
 * queued) and, once the person decided, the OUTCOME — same weight, one under the other:
 *
 *     prüfen → lynox GmbH  ein früherer Schritt in diesem Chat hatte Inhalte von ausserhalb
 *     übernommen
 *
 * That reads as one fluent sentence about the AGENT ("had taken on content from
 * outside"). It is in fact a done-marker about the PERSON. The status disappeared into
 * the warning and the chip looked like an open case with its buttons missing — which is
 * how it was reported.
 *
 * WHY THE FIX IS REMOVAL, NOT RE-WORDING. The first attempt closed the German verb
 * bracket and pinned the wording. It did not hold: there are THREE cause lines (the two
 * `cause.*` keys plus `knowledgeCauseKey`'s `review_hint` default) across two locales,
 * each has to survive both outcome participles, and the locales re-open the slot by
 * different grammar — German by a participial phrase ("aus externem Inhalt" +
 * "übernommen"), English by the causative AND by a reduced relative ("content from
 * outside discarded" = content that was discarded). Twelve pairs to re-check on every
 * copy edit is not a rule anyone keeps, and the first pass had already missed one.
 * Dropping the neighbour ends it for every wording at once — so that is what these
 * guards hold, and no i18n value is pinned.
 *
 * Source-read, not imported: `i18n.svelte.ts` holds the locale in a `$state` rune and
 * throws under the ROOT vitest config that CI runs. Same route as `preset-cards-i18n
 * .test.ts` and `knowledge-chip.test.ts` — see their notes.
 *
 * What this cannot see: the rendered pixel. web-ui has no component-test harness, so
 * these hold the SOURCE properties that produced the merge, not its visual absence.
 */
describe('a resolved review chip reads as its own line', () => {
	const chatView = readFileSync(fileURLToPath(new URL('../components/ChatView.svelte', import.meta.url)), 'utf-8');

	/** The resolved branch as MARKUP: sliced by its own delimiters — no char budget, which
	 *  an earlier version used and which any added comment would have silently overrun —
	 *  and with Svelte comments stripped. Both matter: the comments in this branch discuss
	 *  the very symbols the guards search for, so an un-stripped slice makes a guard answer
	 *  about prose instead of code (it fired on the first run here, in the safe direction;
	 *  the unsafe one is a comment SATISFYING a guard the markup no longer does). */
	const resolvedBranch = (): string => {
		const open = chatView.indexOf('{#if kw.resolved}');
		const close = chatView.indexOf('{:else if editingKnowledgeId', open);
		if (open < 0 || close < 0) throw new Error('resolved branch not found — re-anchor these guards');
		return chatView.slice(open, close).replace(/<!--[\s\S]*?-->/g, '');
	};

	it('renders the cause line ONLY while the decision is open', () => {
		// The load-bearing one: with no cause line beside it, no outcome wording in any
		// locale can be read as its continuation.
		expect(chatView).toMatch(
			/\{#if !kw\.resolved\}<span class="text-text-subtle">\{t\(knowledgeCauseKey\(kw\.cause\)\)\}<\/span>\{\/if\}/,
		);
		expect(resolvedBranch()).not.toContain('knowledgeCauseKey');
	});

	it('sets EVERY line of the resolved branch apart in weight', () => {
		// Both lines were `text-text-subtle`, which is what let the eye read them as one
		// flowing sentence. Every <p>, not just the first: a second subtle-weight
		// paragraph would restore the merge while a first-match guard stayed green.
		const paragraphs = [...resolvedBranch().matchAll(/<p class="([^"]*)"/g)].map((m) => m[1]!);
		expect(paragraphs.length).toBeGreaterThan(0);
		for (const cls of paragraphs) expect(cls).not.toContain('text-text-subtle');
	});

	it('binds each outcome to its OWN wording and glyph', () => {
		// Not a value-pin of the copy (that would brake edits without catching this):
		// these bind the resolved STATE to the text and glyph it selects, so inverting
		// either ternary fails here while every wording stays free to change.
		// `✗`/`✓` is the pair this file already uses — ChatView:2099, :2733.
		const branch = resolvedBranch();
		expect(branch).toMatch(/kw\.resolved === 'discarded'\s*\?\s*t\('chat\.knowledge\.review_discarded'\)\s*:\s*t\('chat\.knowledge\.review_kept'\)/);
		expect(branch).toMatch(/kw\.resolved === 'discarded'\s*\?\s*'✗'\s*:\s*'✓'/);
	});
});
