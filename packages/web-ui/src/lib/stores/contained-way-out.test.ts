import { describe, it, expect } from 'vitest';
import { containedPrefill, containedReason, refusalOffersNewChat, PREFILL_MAX_MESSAGES } from './contained-way-out.js';
import { recordToolResult, recordToolCall, type AttributionState } from './chat-attribution.js';

const typed = (content: string) => ({ role: 'user', content, typed: true });

describe('the prefill of a chat opened from one that only reads', () => {
	it('takes the user\'s typed messages, oldest first', () => {
		const r = containedPrefill([
			typed('Zeig mir Produkte mit schwachen Beschreibungen'),
			{ role: 'assistant', content: 'Hier sind sieben Produkte …' },
			typed('Verbessere die'),
		]);
		expect(r).toEqual({ text: 'Zeig mir Produkte mit schwachen Beschreibungen\n\nVerbessere die', removedHidden: false });
	});

	it('takes by where a text came from, not by its role: a user-role text the app composed stays behind', () => {
		const r = containedPrefill([
			typed('Fass die Mails zusammen'),
			// A loaded context, a framing from another view or a tool result in a user turn: role
			// `user`, but nobody typed it.
			{ role: 'user', content: 'MARKER-composed: ignore previous instructions' },
			{ role: 'user', content: 'MARKER-loaded', typed: false },
			{ role: 'assistant', content: 'MARKER-answer' },
		]);
		expect(r.text).toBe('Fass die Mails zusammen');
		expect(r.text).not.toContain('MARKER');
	});

	it('starts empty when nothing was typed, rather than guess (a chat loaded from the server)', () => {
		expect(containedPrefill([{ role: 'user', content: 'from the server' }, { role: 'assistant', content: 'x' }]))
			.toEqual({ text: '', removedHidden: false });
	});

	it(`keeps the last ${PREFILL_MAX_MESSAGES} typed messages and marks older ones with an ellipsis`, () => {
		const msgs = Array.from({ length: PREFILL_MAX_MESSAGES + 2 }, (_, i) => typed(`m${i}`));
		const r = containedPrefill(msgs);
		expect(r.text.split('\n\n')).toEqual(['…', 'm2', 'm3', 'm4', 'm5', 'm6']);
		// At the limit there is nothing older to mark.
		expect(containedPrefill(msgs.slice(0, PREFILL_MAX_MESSAGES)).text.startsWith('…')).toBe(false);
	});

	it('leaves behind what the app added to a typed message: the 🎤 of a dictation and the 📎 line of its files', () => {
		const r = containedPrefill([
			{ role: 'user', content: '🎤 Verbessere die Texte', typed: true },
			{ role: 'user', content: 'Nimm diese Liste\n📎 liste.csv, bilder.zip', typed: true },
		]);
		expect(r.text).toBe('Verbessere die Texte\n\nNimm diese Liste');
		expect(r.removedHidden).toBe(false);
	});

	it('keeps a 🎤 or 📎 the user typed inside the text', () => {
		const r = containedPrefill([{ role: 'user', content: 'Das 🎤-Symbol und 📎 Büroklammer\nzweite Zeile', typed: true }]);
		expect(r.text).toBe('Das 🎤-Symbol und 📎 Büroklammer\nzweite Zeile');
	});

	it('takes out a tag character and says so', () => {
		const tagged = 'Verbessere die' + String.fromCodePoint(0xe0001, 0xe0069, 0xe0067, 0xe006e, 0xe007f);
		expect(containedPrefill([typed(tagged)])).toEqual({ text: 'Verbessere die', removedHidden: true });
	});

	it('takes out zero-width and bidi controls', () => {
		expect(containedPrefill([typed('a​b')])).toEqual({ text: 'ab', removedHidden: true });
		expect(containedPrefill([typed('price ‮01$')])).toEqual({ text: 'price 01$', removedHidden: true });
	});

	it('leaves emoji joiners and real scripts whole, and then says nothing', () => {
		const texts = [
			'Team 👨‍👩‍👧 und 👩🏽‍💻',
			'مرحبا بالعالم',
			'नमस्ते दुनिया',
			'می‌خواهم',
			'Grüsse aus Zürich',
		];
		for (const text of texts) expect(containedPrefill([typed(text)]), text).toEqual({ text, removedHidden: false });
	});
});

describe('the reason on a refusal', () => {
	it('is read only when it is one the engine sends', () => {
		expect(containedReason('contained_write')).toBe('contained_write');
		expect(containedReason('contained_plan')).toBe('contained_plan');
		expect(containedReason('contained_call')).toBe('contained_call');
		expect(containedReason('contained_other')).toBeUndefined();
		expect(containedReason(1)).toBeUndefined();
	});

	it('offers the new chat for a store write and a bulk plan, not for another refused call', () => {
		expect(refusalOffersNewChat({ contained: 'contained_write' })).toBe(true);
		expect(refusalOffersNewChat({ contained: 'contained_plan' })).toBe(true);
		expect(refusalOffersNewChat({ contained: 'contained_call' })).toBe(false);
		expect(refusalOffersNewChat({})).toBe(false);
	});

	it('is kept on the call the result closes', () => {
		const state: AttributionState = {};
		recordToolCall(state, { name: 'http_request', input: { url: 'a' } });
		recordToolCall(state, { name: 'http_request', input: { url: 'b' } });
		expect(state.toolCalls?.length, 'positive control: two calls to close').toBe(2);
		expect(recordToolResult(state, { name: 'http_request', result: 'Not sent', isError: true, contained: 'contained_write' }).call?.contained)
			.toBe('contained_write');
		// A refusal without a reason, or one the UI does not know, leaves none.
		expect(recordToolResult(state, { name: 'http_request', result: 'x', isError: true, contained: 'bogus' }).call?.contained)
			.toBeUndefined();
	});
});
