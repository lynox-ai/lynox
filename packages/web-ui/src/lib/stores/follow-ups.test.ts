import { describe, it, expect } from 'vitest';
import { parseFollowUps, followUpsFromToolInput, computeDeferredTray, stripFollowUpsFromHistory, type FollowUpHistoryMessage } from './follow-ups.js';

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

	it('does NOT match a suggestions array that OPENS the message (no reply content before it)', () => {
		const text = '[{"label":"x","task":"y"}] und dann noch Text danach.';
		const r = parseFollowUps(text);
		expect(r.suggestions).toEqual([]);
		expect(r.cleanText).toBe(text);
	});

	it('TRAILING-TEXT: strips a bare array followed by a SHORT closing sentence (root cause #2)', () => {
		// The observed leak: a bare array then a trailing "Soll ich …?" broke the $-anchored fallback.
		const text = 'Der Leitfaden ist fertig.\n\n[{"label":"BVG recherchieren","task":"Recherchiere BVG-Optionen"}]\n\nSoll ich damit beginnen?';
		const r = parseFollowUps(text);
		expect(r.suggestions.map((s) => s.label)).toEqual(['BVG recherchieren']);
		expect(r.cleanText).toBe('Der Leitfaden ist fertig.\n\nSoll ich damit beginnen?');
	});

	it('does NOT strip a mid-content array with a long body of text after it (still a false-positive guard)', () => {
		const longAfter = 'Hier folgt eine ausführliche Analyse. '.repeat(10);
		const text = `Kurzer Vorspann. [{"label":"x","task":"y"}] ${longAfter}`;
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

describe('followUpsFromToolInput (suggest_follow_ups tool-call path)', () => {
	it('extracts and normalizes suggestions from the tool input', () => {
		const r = followUpsFromToolInput({ suggestions: [{ label: 'BVG', task: 'Recherchiere BVG' }] });
		expect(r).toEqual([{ label: 'BVG', task: 'Recherchiere BVG' }]);
	});

	it('applies the SAME rules as the text parser: skip malformed, dedupe by label, cap at 4', () => {
		const r = followUpsFromToolInput({
			suggestions: [
				{ label: 'A', task: 'ta' },
				{ label: 'A', task: 'dup' }, // dedup by label
				{ label: '', task: 'empty' }, // blank label skipped
				{ label: 'B' }, // missing task skipped
				{ label: 'C', task: 'tc' },
				{ label: 'D', task: 'td' },
				{ label: 'E', task: 'te' },
			],
		});
		expect(r.map((s) => s.label)).toEqual(['A', 'C', 'D', 'E']); // A once, capped at 4
	});

	it('trims the label to 40 characters', () => {
		const long = 'x'.repeat(60);
		const r = followUpsFromToolInput({ suggestions: [{ label: long, task: 't' }] });
		expect(r[0]!.label.length).toBe(40);
	});

	it('returns [] for any non-conforming input (never throws)', () => {
		expect(followUpsFromToolInput(null)).toEqual([]);
		expect(followUpsFromToolInput(undefined)).toEqual([]);
		expect(followUpsFromToolInput('a string')).toEqual([]);
		expect(followUpsFromToolInput({})).toEqual([]);
		expect(followUpsFromToolInput({ suggestions: 'not an array' })).toEqual([]);
		expect(followUpsFromToolInput({ suggestions: [{ foo: 'bar' }] })).toEqual([]);
	});
});

describe('computeDeferredTray (deferred-siblings tray — the "second option survives" fix)', () => {
	const A = { label: 'A', task: 'ta' };
	const B = { label: 'B', task: 'tb' };
	const C = { label: 'C', task: 'tc' };

	it('adds the un-taken siblings of the clicked pill, excluding the clicked one', () => {
		const next = computeDeferredTray([], A, [A, B, C], 8);
		expect(next.map((f) => f.task)).toEqual(['tb', 'tc']);
	});

	it('dedups new siblings against what is already in the tray', () => {
		const next = computeDeferredTray([B], A, [A, B, C], 8);
		expect(next.map((f) => f.task)).toEqual(['tb', 'tc']); // B not duplicated, C added
	});

	it('caps at max, dropping the oldest (newest-last)', () => {
		const current = [
			{ label: 'x1', task: 't1' },
			{ label: 'x2', task: 't2' },
		];
		const next = computeDeferredTray(current, A, [A, B, C], 3);
		// current [t1,t2] + siblings [tb,tc] = 4 → cap 3 → drop oldest t1
		expect(next.map((f) => f.task)).toEqual(['t2', 'tb', 'tc']);
	});

	it('returns the SAME reference when there are no new siblings (single-pill set)', () => {
		const current = [B];
		expect(computeDeferredTray(current, A, [A], 8)).toBe(current); // no siblings → unchanged
	});

	it('returns the SAME reference when every sibling is already in the tray', () => {
		const current = [B, C];
		expect(computeDeferredTray(current, A, [A, B, C], 8)).toBe(current);
	});

	it('dedups two siblings that share a task but differ by label (task-keyed tray must not duplicate)', () => {
		// normalizeSuggestions dedups by LABEL, so a set can legitimately hold two items with
		// the same `task` and different labels. The tray `{#each … (fu.task)}` is task-keyed, so
		// letting both through would crash Svelte with each_key_duplicate. Only ONE must land.
		const bAlt = { label: 'B alternative', task: 'tb' };
		const next = computeDeferredTray([], A, [A, B, bAlt, C], 8);
		expect(next.map((f) => f.task)).toEqual(['tb', 'tc']); // tb once, not twice
		expect(new Set(next.map((f) => f.task)).size).toBe(next.length); // no duplicate task keys
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
