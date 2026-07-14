import { describe, it, expect } from 'vitest';
import { parseFollowUps } from './follow-ups.js';

describe('parseFollowUps', () => {
	it('parses the wrapped <follow_ups> form and strips it from the text', () => {
		const r = parseFollowUps(
			'Die Checkliste ist gespeichert.\n<follow_ups>\n[{"label":"BVG recherchieren","task":"Recherchiere BVG"}]\n</follow_ups>',
		);
		expect(r.suggestions).toEqual([{ label: 'BVG recherchieren', task: 'Recherchiere BVG' }]);
		expect(r.cleanText).toBe('Die Checkliste ist gespeichert.');
	});

	it('FALLBACK: parses a BARE trailing array without the wrapper (the leak fix)', () => {
		// The exact drift observed in prod: the agent emitted the suggestions as a
		// bare trailing JSON array, which used to leak as raw text.
		const r = parseFollowUps(
			'Erledigt — der Leitfaden.\n\n[{"label":"Lohnsoftware recherchieren","task":"Recherchiere Optionen"},{"label":"Master-Übersicht","task":"Lies die Übersicht"}]',
		);
		expect(r.suggestions.map((s) => s.label)).toEqual(['Lohnsoftware recherchieren', 'Master-Übersicht']);
		expect(r.cleanText).toBe('Erledigt — der Leitfaden.');
	});

	it('does NOT consume ordinary trailing JSON without label+task keys', () => {
		const text = 'Hier die Config:\n[{"key":"foo","value":42}]';
		const r = parseFollowUps(text);
		expect(r.suggestions).toEqual([]);
		expect(r.cleanText).toBe(text); // untouched — no false positive
	});

	it('does NOT match a suggestions array that is NOT at the end of the message', () => {
		const text = '[{"label":"x","task":"y"}] und dann noch Text danach.';
		const r = parseFollowUps(text);
		expect(r.suggestions).toEqual([]);
		expect(r.cleanText).toBe(text);
	});

	it('returns the text untouched when there are no follow-ups at all', () => {
		const r = parseFollowUps('Just a plain reply.');
		expect(r.suggestions).toEqual([]);
		expect(r.cleanText).toBe('Just a plain reply.');
	});

	it('skips malformed items, dedupes by label, and caps at 4', () => {
		const r = parseFollowUps(
			'<follow_ups>[' +
				'{"label":"A","task":"ta"},' +
				'{"label":"A","task":"dup"},' + // dedup by label
				'{"label":"","task":"empty"},' + // empty label skipped
				'{"label":"B"},' + // missing task skipped
				'{"label":"C","task":"tc"},{"label":"D","task":"td"},{"label":"E","task":"te"}' +
				']</follow_ups>',
		);
		expect(r.suggestions.map((s) => s.label)).toEqual(['A', 'C', 'D', 'E']); // A once, capped at 4
	});
});
