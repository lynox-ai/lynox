import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The consent block's own strings, pinned WHOLE in both languages.
 *
 * Existence and non-emptiness were all this file checked, and that let the
 * defect three rounds had removed walk back in through the table: changing the
 * waiting sentence to "it runs shortly after you confirm" left the suite green,
 * because the template guard can only see the template. The sentences ARE the
 * product here — six short strings that change once a year — so they are
 * compared whole, the same instrument used for a small, rarely-edited artefact
 * elsewhere.
 *
 * What that buys, stated so the friction is understood: editing any of these
 * means editing this file, which is the point. What it does not buy is a check
 * on the German and English saying the same thing; that is a reading, and no
 * assertion here claims to make it.
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

/** The whole table row for a key, as written. */
function row(key: string): string {
	const at = I18N.indexOf(`'${key}':`);
	expect(at, `${key} is gone from the table`).toBeGreaterThan(-1);
	expect(I18N.indexOf(`'${key}':`, at + 1), `${key} appears twice`).toBe(-1);
	return I18N.slice(at, I18N.indexOf('\n', at)).trim();
}

describe('the consent block speaks both languages, and says only what it may', () => {
	it('every sentence is exactly the one that was reviewed', () => {
		const pinned: Record<string, string> = {
			'triggers.awaiting_confirmation':
				"'triggers.awaiting_confirmation': { de: 'Wartet auf Bestätigung', en: 'Awaiting confirmation' },",
			'triggers.awaiting_hint':
				`'triggers.awaiting_hint': { de: 'Läuft erst, wenn du ihn bestätigst.', en: "It won't run until you confirm it." },`,
			'triggers.instruction':
				"'triggers.instruction': { de: 'Auftrag (von lynox geschrieben)', en: 'Instruction (written by lynox)' },",
			'triggers.confirm': "'triggers.confirm': { de: 'Bestätigen', en: 'Confirm' },",
			'triggers.confirm_label':
				"'triggers.confirm_label': { de: 'Bestätigen, dass dieser Trigger ohne dich laufen darf', en: 'Confirm that this trigger may run without you' },",
			'triggers.confirmed': "'triggers.confirmed': { de: 'Bestätigt.', en: 'Confirmed.' },",
			'triggers.confirm_failed':
				"'triggers.confirm_failed': { de: 'Bestätigen fehlgeschlagen. Bitte erneut versuchen.', en: 'Could not confirm. Please try again.' },",
			'triggers.watch_url': "'triggers.watch_url': { de: 'Beobachtete Seite', en: 'Watched page' },",
			'triggers.watch_every':
				"'triggers.watch_every': { de: 'Prüft alle {minutes} Minuten.', en: 'Checks every {minutes} minutes.' },",
		};
		for (const [key, expected] of Object.entries(pinned)) {
			expect(row(key), key).toBe(expected);
		}
	});

	it('the cadence sentence keeps its slot in both languages', () => {
		// It is the one string here that carries a number, and a lost slot renders
		// the word `{minutes}` to the person about to allow an unattended fetch.
		const every = row('triggers.watch_every');
		expect(every).toContain('{minutes}');
		expect(every.match(/\{minutes\}/g) ?? []).toHaveLength(2);
	});

	it('no sentence promises a time, in either language', () => {
		// The claim this block may not make, in the place it came back through the
		// last time: "runs shortly after", "on its schedule", a date, a duration.
		//
		// `triggers.watch_every` is deliberately NOT in this set, and the omission is
		// the considered half: "checks every 30 minutes" states the watch's INTERVAL,
		// which is a property of the thing being confirmed, not a promise about when
		// the first run happens. Its own test above pins its slot.
		const consent = Object.keys({
			'triggers.awaiting_confirmation': 0, 'triggers.awaiting_hint': 0, 'triggers.instruction': 0,
			'triggers.confirm': 0, 'triggers.confirm_label': 0, 'triggers.confirmed': 0, 'triggers.confirm_failed': 0,
			'triggers.watch_url': 0,
		}).map((key) => row(key)).join('\n');
		for (const forbidden of [
			/\bgleich\b/i, /\bkurz (danach|nach)\b/i, /\bsofort\b/i, /zeitplan/i, /\bf\u00e4llig\b/i, /\bminuten?\b/i,
			/\bshortly\b/i, /\bimmediately\b/i, /\bschedule\b/i, /\bdue\b/i, /\bminutes?\b/i, /\{date\}/,
		]) {
			expect(consent, String(forbidden)).not.toMatch(forbidden);
		}
	});
});
