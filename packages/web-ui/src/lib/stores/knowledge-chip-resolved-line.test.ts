import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A resolved review chip must not read as the tail of its own warning.
 *
 * Observed 2026-08-19 on a live thread. The chip stacks two lines: the CAUSE
 * (why this fact was queued) and, once the person decides, the OUTCOME. Both were
 * `text-text-subtle`, and each locale's cause left a slot open for the outcome
 * participle to fill — so the wrapped outcome read as one fluent sentence saying
 * the opposite of what the line reports:
 *
 *     prüfen → lynox GmbH  ein früherer Schritt in diesem Chat hatte Inhalte von ausserhalb
 *     übernommen
 *
 * German by an unclosed verb bracket ("hatte ... übernommen"), English by the
 * causative ("had content from outside discarded" = arranged for its removal).
 * Both read as a WARNING about the agent; both are in fact a DONE marker about the
 * person. The status vanished into the warning, and the chip looked like an open
 * case whose buttons had gone missing — which is how it was reported.
 *
 * WHY THE WORDING IS PINNED BY VALUE, not by a grammar rule. The first version of
 * this test carried a regex for "unclosed German verb bracket". It was worse than
 * nothing: "hatte Inhalte von aussen", "hatte Inhalte von externen Quellen" and
 * "wurden Inhalte von ausserhalb" all sail past it while re-opening the exact merge
 * (measured, not feared). A heuristic that misses the cases it exists for buys false
 * confidence, so the wording is pinned literally: changing a cause line is a decision,
 * and it should cost a deliberate test edit that makes you read this note. The
 * STRUCTURAL guards below are the actual net, and they survive a re-wording.
 *
 * Source-read, not imported: `i18n.svelte.ts` holds the locale in a `$state` rune and
 * throws under the ROOT vitest config that CI runs. Same route as `preset-cards-i18n
 * .test.ts` and `knowledge-chip.test.ts` — see their notes.
 *
 * What this cannot see: the rendered pixel. web-ui has no component-test harness.
 */
describe('a resolved review chip reads as its own line', () => {
	const i18n = readFileSync(fileURLToPath(new URL('../i18n.svelte.ts', import.meta.url)), 'utf-8');
	const chatView = readFileSync(fileURLToPath(new URL('../components/ChatView.svelte', import.meta.url)), 'utf-8');

	const value = (key: string, locale: 'de' | 'en'): string => {
		const m = new RegExp(`'${key.replace(/\./g, '\\.')}':\\s*\\{[^}]*\\b${locale}:\\s*'([^']*)'`).exec(i18n);
		if (!m) throw new Error(`no ${locale} value for ${key} — key renamed?`);
		return m[1]!;
	};

	/** The resolved branch of the review chip, sliced by its own delimiters — no char
	 *  budget, which the first version used and which any added comment would have
	 *  silently overrun. */
	const resolvedBranch = (): string => {
		const open = chatView.indexOf('{#if kw.resolved}');
		const close = chatView.indexOf('{:else if editingKnowledgeId', open);
		if (open < 0 || close < 0) throw new Error('resolved branch not found — re-anchor this guard');
		return chatView.slice(open, close);
	};

	// Both locales of both causes, and both outcomes. A new locale or a re-worded
	// line lands here first, with the note above explaining what to check.
	it.each([
		['chat.knowledge.cause.earlier', 'de', 'ein früherer Schritt in diesem Chat enthielt Inhalte von ausserhalb'],
		['chat.knowledge.cause.earlier', 'en', 'an earlier step in this chat contained content from outside'],
		['chat.knowledge.cause.this_step', 'de', 'kann Inhalte von ausserhalb enthalten'],
		['chat.knowledge.cause.this_step', 'en', 'may include content from outside'],
		['chat.knowledge.review_kept', 'de', 'übernommen'],
		['chat.knowledge.review_kept', 'en', 'kept'],
		['chat.knowledge.review_discarded', 'de', 'verworfen'],
		['chat.knowledge.review_discarded', 'en', 'discarded'],
	])('%s [%s] is the reviewed wording', (key, locale, expected) => {
		expect(value(key, locale as 'de' | 'en')).toBe(expected);
	});

	it('sets EVERY line of the resolved branch apart from the cause line above it', () => {
		// The cause span and the outcome paragraph shared `text-text-subtle`, which is
		// what let the eye read them as one flowing sentence. Checked over every <p> in
		// the branch, not just the first: a second subtle-weight paragraph would restore
		// the merge while a first-match guard stayed green.
		expect(chatView).toMatch(/<span class="text-text-subtle">\{t\(knowledgeCauseKey\(kw\.cause\)\)\}<\/span>/);
		const paragraphs = [...resolvedBranch().matchAll(/<p class="([^"]*)"/g)].map((m) => m[1]!);
		expect(paragraphs.length).toBeGreaterThan(0);
		for (const cls of paragraphs) expect(cls).not.toContain('text-text-subtle');
	});

	it('marks the outcome with a glyph so a re-worded cause cannot merge into it again', () => {
		const branch = resolvedBranch();
		// `✗`, not `✕` — the pair this file already uses for done/failed (ChatView:2099, :2733).
		expect(branch).toMatch(/['"]✓['"]/);
		expect(branch).toMatch(/['"]✗['"]/);
	});
});
