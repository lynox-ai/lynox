import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A resolved review chip must not read as the tail of its own warning.
 *
 * Observed 2026-08-19 on a live thread. The chip stacks two lines: the CAUSE
 * ("ein früherer Schritt in diesem Chat hatte Inhalte von ausserhalb") and, once
 * the person decides, the OUTCOME ("übernommen"). Both were `text-text-subtle`,
 * and the German cause left its verb bracket open — so the wrapped outcome closed
 * it into a fluent sentence that says the opposite of what the line reports:
 *
 *     prüfen → lynox GmbH  ein früherer Schritt in diesem Chat hatte Inhalte von ausserhalb
 *     übernommen
 *
 * Read as one sentence that is a WARNING about the agent ("...had taken on content
 * from outside"). It is in fact a DONE marker about the person ("you kept this").
 * The status vanished into the warning, and the chip looked like an open case whose
 * buttons had gone missing — which is how it was reported.
 *
 * Two independent guards, because either alone is escapable:
 *   1. the German cause lines close their own verb bracket, so no participle fits;
 *   2. the outcome line is visually separated from the cause line.
 *
 * Source-read, not imported: `i18n.svelte.ts` holds the locale in a `$state` rune and
 * throws under the ROOT vitest config that CI runs. Same route as `preset-cards-i18n
 * .test.ts` and `knowledge-chip.test.ts` — see their notes.
 *
 * What this cannot see: the rendered pixel. It holds the two properties that produced
 * the merge, not the absence of every possible merge.
 */
describe('a resolved review chip reads as its own line', () => {
	const i18n = readFileSync(fileURLToPath(new URL('../i18n.svelte.ts', import.meta.url)), 'utf-8');
	const chatView = readFileSync(fileURLToPath(new URL('../components/ChatView.svelte', import.meta.url)), 'utf-8');

	const deValue = (key: string): string => {
		const m = new RegExp(`'${key.replace(/\./g, '\\.')}':\\s*\\{\\s*de:\\s*'([^']*)'`).exec(i18n);
		if (!m) throw new Error(`no German value for ${key} — key renamed?`);
		return m[1]!;
	};

	// The two outcomes, exactly as the chip renders them.
	const OUTCOMES_DE = ['chat.knowledge.review_kept', 'chat.knowledge.review_discarded'].map(deValue);

	it.each(['chat.knowledge.cause.earlier', 'chat.knowledge.cause.this_step'])(
		'%s closes its own German verb bracket, so an outcome cannot complete it',
		(key) => {
			const cause = deValue(key);
			// A finite auxiliary with no participle after it is exactly the open bracket
			// the outcome slotted into. "enthielt Inhalte von ausserhalb" is closed;
			// "hatte Inhalte von ausserhalb" is not.
			const openBracket = /\b(hatte|hat|hatten|war|ist|wurde|wird)\b(?!.*\b\w+(?:en|et|t)\b)/;
			expect(cause).not.toMatch(openBracket);
		},
	);

	it('the German outcomes are participles — which is WHY the cause must not invite one', () => {
		// Pins the premise of the test above: if these stop being participles the
		// bracket guard is guarding nothing and should be revisited, not silently kept.
		for (const outcome of OUTCOMES_DE) expect(outcome).toMatch(/(en|t)$/);
	});

	it('renders the outcome in a different weight than the cause line above it', () => {
		// The cause span and the outcome paragraph shared `text-text-subtle`, which is
		// what let the eye read them as one flowing sentence.
		const causeLine = /<span class="text-text-subtle">\{t\(knowledgeCauseKey\(kw\.cause\)\)\}<\/span>/;
		expect(chatView).toMatch(causeLine);
		const outcomeBlock = /\{#if kw\.resolved\}[\s\S]{0,1200}?<p class="([^"]*)"/.exec(chatView);
		expect(outcomeBlock, 'the resolved branch no longer opens with a <p> — re-anchor this guard').not.toBeNull();
		expect(outcomeBlock![1]).not.toContain('text-text-subtle');
	});

	it('marks the outcome with a glyph so a re-worded cause cannot merge into it again', () => {
		const outcomeBranch = /\{#if kw\.resolved\}[\s\S]{0,1200}?\{:else if editingKnowledgeId/.exec(chatView);
		expect(outcomeBranch, 'the resolved branch moved — re-anchor this guard').not.toBeNull();
		expect(outcomeBranch![0]).toMatch(/['"]✓['"]/);
		expect(outcomeBranch![0]).toMatch(/['"]✕['"]/);
	});
});
