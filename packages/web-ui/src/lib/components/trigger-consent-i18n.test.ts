import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The consent block's own strings, in both languages, with their slots intact.
 *
 * The type of the table already forces both languages to exist, so this is not
 * about a missing key — it is about the two halves saying the same thing and a
 * `{date}` slot surviving an edit. A sentence that loses its slot renders the
 * word `{date}` to the person who is about to allow an unattended run.
 */
const I18N = readFileSync(fileURLToPath(new URL('../i18n.svelte.ts', import.meta.url)), 'utf-8');

function entry(key: string): { de: string; en: string } {
	const at = I18N.indexOf(`'${key}':`);
	expect(at, `${key} is gone from the table`).toBeGreaterThan(-1);
	const row = I18N.slice(at, I18N.indexOf('\n', at));
	const de = /de: '((?:[^'\\]|\\.)*)'/.exec(row)?.[1];
	const en = /en: "((?:[^"\\]|\\.)*)"|en: '((?:[^'\\]|\\.)*)'/.exec(row);
	expect(de, `${key} has no German`).toBeDefined();
	const english = en?.[1] ?? en?.[2];
	expect(english, `${key} has no English`).toBeDefined();
	return { de: de as string, en: english as string };
}

const KEYS = [
	'triggers.awaiting_confirmation', 'triggers.awaiting_hint', 'triggers.instruction',
	'triggers.watch_url', 'triggers.watch_every', 'triggers.awaiting_due_since',
	'triggers.awaiting_first_run', 'triggers.awaiting_paused', 'triggers.awaiting_not_scheduled',
	'triggers.confirm', 'triggers.confirm_label', 'triggers.confirmed',
	'triggers.confirmed_paused', 'triggers.confirm_failed',
];

describe('the consent block speaks both languages', () => {
	it('every string exists in both, and neither is empty', () => {
		for (const key of KEYS) {
			const { de, en } = entry(key);
			expect(de.trim(), key).not.toBe('');
			expect(en.trim(), key).not.toBe('');
			// Not a translation check — a sameness check the type cannot make: an
			// English string identical to the German one is almost always a forgotten
			// half. (`triggers.confirm` is "Bestätigen"/"Confirm", so no key here is
			// legitimately identical.)
			expect(de, key).not.toBe(en);
		}
	});

	it('the sentences that name a time keep their slot in both languages', () => {
		for (const key of ['triggers.awaiting_due_since', 'triggers.awaiting_first_run']) {
			const { de, en } = entry(key);
			expect(de, key).toContain('{date}');
			expect(en, key).toContain('{date}');
		}
		const every = entry('triggers.watch_every');
		expect(every.de).toContain('{minutes}');
		expect(every.en).toContain('{minutes}');
	});
});
