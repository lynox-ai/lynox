import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { knowledgeCauseKey } from './knowledge-chip.js';

describe('knowledgeCauseKey', () => {
	// The LITERAL pairs, not "three distinct keys": a swapped implementation passed a
	// distinctness count, which is a tautology dressed as coverage.
	it.each([
		['marker', 'chat.knowledge.cause.this_step'],
		['external-tool', 'chat.knowledge.cause.this_step'],
		['conversation', 'chat.knowledge.cause.earlier'],
	])('maps %s → %s', (cause, key) => {
		expect(knowledgeCauseKey(cause)).toBe(key);
	});

	it('separates THIS step from an EARLIER one — the only split the person can act on', () => {
		expect(knowledgeCauseKey('marker')).not.toBe(knowledgeCauseKey('conversation'));
	});

	it('falls back to the generic line for an absent or unknown cause', () => {
		// An older engine behind a newer UI sends no cause; the chip must still say something.
		for (const c of [undefined, 'none', 'something-new-the-engine-invented']) {
			expect(knowledgeCauseKey(c)).toBe('chat.knowledge.review_hint');
		}
	});

	it('every key it can return is declared in BOTH locales, non-empty', () => {
		// The failure this guards is SILENT: `t()` falls back to echoing the key, so a typo —
		// or a `de`-only entry — renders "chat.knowledge.cause.earlier" at the user instead of
		// a sentence. Checked by reading the source rather than importing it: `i18n.svelte.ts`
		// holds the locale in a rune, so a test cannot import it.
		const src = readFileSync(fileURLToPath(new URL('../i18n.svelte.ts', import.meta.url)), 'utf-8');
		for (const c of ['marker', 'external-tool', 'conversation', undefined]) {
			const key = knowledgeCauseKey(c);
			// Both locales, each with at least one character between the quotes — a bare
			// `toContain("'key': {")` passes for `{ de: 'x' }` with no `en`, and for `{ de: '' }`.
			const decl = new RegExp(
				`'${key.replace(/\./g, '\\.')}':\\s*\\{[^}]*\\bde:\\s*'[^']+'[^}]*\\ben:\\s*'[^']+'[^}]*\\}`,
			);
			expect(decl.test(src), `missing or incomplete i18n declaration for ${key}`).toBe(true);
		}
	});
});
