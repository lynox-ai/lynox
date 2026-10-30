import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ESCALATION_NOTICE_KINDS } from './contract/http.js';

/**
 * The setting that switches the escalation mail off says which notices can send one
 * (`notifications.escalation_mail_desc`, ux U-070): a failed workflow and a watch's finding,
 * which the engine reports as `'escalation'`, and a scheduled run waiting for an answer,
 * `'question'`. The list is spelled out because "every notification" would be false.
 *
 * So the text is bound to the contract's kinds: a third kind added to the contract fails
 * here, instead of the setting going on describing two kinds while it switches off three.
 *
 * Read as source, not imported: `i18n.svelte.ts` holds the locale in a `$state` rune, which
 * the root vitest config cannot load (see `preset-cards-i18n.test.ts`).
 */
const source = readFileSync(fileURLToPath(new URL('./i18n.svelte.ts', import.meta.url)), 'utf-8');
const line = source.split('\n').find((l) => l.includes("'notifications.escalation_mail_desc':")) ?? '';

/** What the description names for each kind, in each language. */
const NAMED: Record<(typeof ESCALATION_NOTICE_KINDS)[number], { de: string[]; en: string[] }> = {
	escalation: {
		de: ['Schlägt ein Workflow fehl', 'findet eine Beobachtung etwas'],
		en: ['If a workflow fails', 'a watch finds something'],
	},
	question: {
		de: ['wartet ein geplanter Lauf auf deine Antwort'],
		en: ['a scheduled run is waiting for your answer'],
	},
};

describe('the escalation mail setting names every kind that can send the mail', () => {
	it('knows exactly the contract\'s kinds', () => {
		// A new kind lands here first: name it in the description (with ux), then add it below.
		expect(Object.keys(NAMED).sort()).toEqual([...ESCALATION_NOTICE_KINDS].sort());
	});

	it('names each kind in both languages', () => {
		expect(line).not.toBe('');
		for (const kind of ESCALATION_NOTICE_KINDS) {
			for (const phrase of [...NAMED[kind].de, ...NAMED[kind].en]) {
				expect(line, `${kind}: ${phrase}`).toContain(phrase);
			}
		}
	});

	it('says the mail carries no content and not the question', () => {
		expect(line).toContain('keine Inhalte und auch nicht die Frage');
		expect(line).toContain('no content, and not the question either');
	});
});
