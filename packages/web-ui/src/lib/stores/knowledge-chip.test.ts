import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { knowledgeCauseKey } from './knowledge-chip.js';

describe('knowledgeCauseKey', () => {
	it('maps each engine cause to its own wording', () => {
		// Distinct keys, not just "returns a string": the whole point is that the person
		// learns WHICH thing queued the write.
		const keys = ['marker', 'external-tool', 'conversation'].map(knowledgeCauseKey);
		expect(new Set(keys).size).toBe(3);
	});

	it('falls back to the generic line for an absent or unknown cause', () => {
		// An older engine behind a newer UI sends no cause; the chip must still say something.
		for (const c of [undefined, 'none', 'something-new-the-engine-invented']) {
			expect(knowledgeCauseKey(c)).toBe('chat.knowledge.review_hint');
		}
	});

	it('every key it can return is actually declared in i18n', () => {
		// The failure this guards is SILENT: `t()` falls back to echoing the key, so a typo
		// renders "chat.knowledge.cause.marker" at the user instead of a sentence. Checked by
		// reading the source rather than importing it — `i18n.svelte.ts` holds the locale in a
		// rune, so a test cannot import it, and an unassertable mapping is one that drifts.
		const src = readFileSync(
			fileURLToPath(new URL('../i18n.svelte.ts', import.meta.url)),
			'utf-8',
		);
		for (const c of ['marker', 'external-tool', 'conversation', undefined]) {
			const key = knowledgeCauseKey(c);
			expect(src, `missing i18n declaration for ${key}`).toContain(`'${key}': {`);
		}
	});
});
