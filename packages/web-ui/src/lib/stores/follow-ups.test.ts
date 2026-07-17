import { describe, it, expect } from 'vitest';
import { parseFollowUps, stripFollowUpsFromHistory, type FollowUpHistoryMessage } from './follow-ups.js';

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

describe('stripFollowUpsFromHistory (thread-resume re-parse — the engine re-entry bug)', () => {
	it('strips the raw bare-JSON trailer on resume and restores the pills (exact reported case)', () => {
		// The server persisted the agent's RAW output; on resume it must not leak as text.
		const msgs: FollowUpHistoryMessage[] = [
			{ role: 'user', content: 'Nenne mir in einem kurzen Satz die Hauptstadt der Schweiz.' },
			{
				role: 'assistant',
				content:
					'Bern ist die Hauptstadt der Schweiz.\n\n[{"label":"Mehr über Bern erfahren","task":"Erzähl mir interessante Fakten über Bern."},{"label":"Schweizer Kantone auflisten","task":"Liste alle 26 Schweizer Kantone auf."},{"label":"Schweiz auf Wikipedia","task":"Rufe den Wikipedia-Artikel ab."}]',
			},
		];
		stripFollowUpsFromHistory(msgs);
		expect(msgs[1]!.content).toBe('Bern ist die Hauptstadt der Schweiz.');
		expect(msgs[1]!.followUps?.map((s) => s.label)).toEqual([
			'Mehr über Bern erfahren',
			'Schweizer Kantone auflisten',
			'Schweiz auf Wikipedia',
		]);
	});

	it('cleans EVERY assistant turn but keeps pills only on the LAST (no stale pills on old turns)', () => {
		const msgs: FollowUpHistoryMessage[] = [
			{ role: 'user', content: 'q1' },
			{ role: 'assistant', content: 'A1.\n[{"label":"old","task":"do old"}]' },
			{ role: 'user', content: 'q2' },
			{ role: 'assistant', content: 'A2.\n[{"label":"new","task":"do new"}]' },
		];
		stripFollowUpsFromHistory(msgs);
		expect(msgs[1]!.content).toBe('A1.');
		expect(msgs[1]!.followUps).toBeUndefined(); // older turn: cleaned, no pills
		expect(msgs[3]!.content).toBe('A2.');
		expect(msgs[3]!.followUps?.map((s) => s.label)).toEqual(['new']); // current turn: pills
	});

	it('also strips the trailer from the last text block', () => {
		const msgs: FollowUpHistoryMessage[] = [
			{
				role: 'assistant',
				content: 'Done.\n[{"label":"x","task":"do x"}]',
				blocks: [
					{ type: 'tool_call' },
					{ type: 'text', text: 'Done.\n[{"label":"x","task":"do x"}]' },
				],
			},
		];
		stripFollowUpsFromHistory(msgs);
		expect(msgs[0]!.blocks![1]!.text).toBe('Done.');
	});

	it('leaves a message without a trailer untouched (no spurious followUps)', () => {
		const msgs: FollowUpHistoryMessage[] = [
			{ role: 'assistant', content: 'Just a normal reply, no suggestions.' },
		];
		stripFollowUpsFromHistory(msgs);
		expect(msgs[0]!.content).toBe('Just a normal reply, no suggestions.');
		expect(msgs[0]!.followUps).toBeUndefined();
	});
});
