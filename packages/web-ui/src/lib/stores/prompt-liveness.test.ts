import { describe, it, expect } from 'vitest';

import {
	turnEndSettlesTools,
	promptCreatedAtMs,
	zoneQualify,
	lostPromptRecheckVerdict,
} from './prompt-liveness.js';

/**
 * One prod thread, three ways the chat told the user something it had not
 * established (2026-09-06): a ✓ over a question nobody had been shown, a
 * countdown promising 24h to a prompt three hours old, and no path at all back
 * to a question whose SSE event was lost.
 */

describe('turnEndSettlesTools', () => {
	// THE POINT. `turn_end` fires when the model reports a stop reason, and
	// 'tool_use' means the tools run AFTERWARDS — so nothing has finished and
	// nothing may be marked done. Drop the check and an `ask_user` parked on a
	// human renders as answered.
	it('⭐ refuses to settle when the turn stopped to RUN tools', () => {
		expect(turnEndSettlesTools('tool_use')).toBe(false);
	});

	// The other half, and it has to keep passing: this settle exists to clear a
	// real ghost (a dropped tool_result spinning under a finished answer,
	// 2026-05-15). A fix that always returns false would revive that bug, so
	// every terminal reason must still settle.
	it('settles on every reason that really ends the turn', () => {
		for (const reason of ['end_turn', 'max_tokens', 'stop_sequence', 'pause_turn']) {
			expect(turnEndSettlesTools(reason)).toBe(true);
		}
	});

	// An engine that sends no stop_reason, or one this client does not know,
	// must not strand spinners forever — absence is not 'tool_use'.
	it('settles when the reason is absent or unrecognised', () => {
		expect(turnEndSettlesTools(undefined)).toBe(true);
		expect(turnEndSettlesTools('')).toBe(true);
		expect(turnEndSettlesTools('some_future_reason')).toBe(true);
	});

	// Guards the comparison itself: a prefix/substring match would let
	// 'tool_use_v2' settle, and a case-folding one would let 'TOOL_USE' through.
	it('matches the reason exactly, not by prefix or case', () => {
		expect(turnEndSettlesTools('tool_use_v2')).toBe(true);
		expect(turnEndSettlesTools('use')).toBe(true);
		expect(turnEndSettlesTools('TOOL_USE')).toBe(true);
	});
});

describe('promptCreatedAtMs', () => {
	const NOW = Date.parse('2026-09-06T13:51:00Z');

	// Kept, but it is NOT the guard for the UTC question — on a runner already
	// in UTC (which CI is: no TZ is set anywhere in the workflows) this passes
	// against a broken implementation too. `zoneQualify` below is the real one.
	it('reads a zone-less SQLite timestamp as an instant', () => {
		const parsed = promptCreatedAtMs('2026-09-06 10:58:40', NOW);
		expect(parsed).toBe(Date.parse('2026-09-06T10:58:40Z'));
		// And the consequence the user sees: ~2h52m elapsed, not ~0.
		expect(Math.round((NOW - parsed) / 60_000)).toBe(172);
	});

	// The defect in one assertion: a prompt hours old must not read as new.
	it('⭐ does not restart the clock for an old prompt', () => {
		expect(promptCreatedAtMs('2026-09-06 10:58:40', NOW)).toBeLessThan(NOW);
	});

	it('accepts an ISO string that already carries a zone', () => {
		expect(promptCreatedAtMs('2026-09-06T10:58:40Z', NOW)).toBe(Date.parse('2026-09-06T10:58:40Z'));
		expect(promptCreatedAtMs('2026-09-06T12:58:40+02:00', NOW)).toBe(Date.parse('2026-09-06T10:58:40Z'));
	});

	// Fallback, and it must be `now` rather than NaN: a restarted countdown is
	// wrong, but a NaN one renders nothing at all.
	it('falls back to now — never NaN — on a missing or malformed value', () => {
		for (const bad of [undefined, null, '', 42, {}, 'not a date']) {
			const out = promptCreatedAtMs(bad, NOW);
			expect(Number.isFinite(out)).toBe(true);
			expect(out).toBe(NOW);
		}
	});
});

describe('zoneQualify', () => {
	// ⭐ THE POINT, and it is a STRING assertion on purpose. The defect is that
	// `Date.parse` reads a zone-less timestamp as LOCAL time; asserting the
	// resulting NUMBER would agree with a broken implementation on any machine
	// in UTC, and CI sets no TZ — so on GitHub the number-based test is green
	// against nothing. This one fails there too.
	it('⭐ appends Z to a zone-less SQLite timestamp, regardless of runner TZ', () => {
		expect(zoneQualify('2026-09-06 10:58:40')).toBe('2026-09-06T10:58:40Z');
	});

	it('replaces the space separator with T', () => {
		expect(zoneQualify('2026-09-06 10:58:40')).toContain('T');
		expect(zoneQualify('2026-09-06 10:58:40')).not.toContain(' ');
	});

	// Qualifying twice would produce '…Z Z' / '…+02:00Z' and fail to parse.
	it('leaves a value that already carries a zone untouched', () => {
		expect(zoneQualify('2026-09-06T10:58:40Z')).toBe('2026-09-06T10:58:40Z');
		expect(zoneQualify('2026-09-06T12:58:40+02:00')).toBe('2026-09-06T12:58:40+02:00');
		expect(zoneQualify('2026-09-06T12:58:40+0200')).toBe('2026-09-06T12:58:40+0200');
		expect(zoneQualify('2026-09-06T10:58:40z')).toBe('2026-09-06T10:58:40z');
	});

	// The zone test must anchor at the END. A '+' inside the date would never
	// appear, but an unanchored check would also treat '10:58:40' as zoned
	// because of its own digits-and-colons shape.
	it('does not mistake the time-of-day colons for a zone offset', () => {
		expect(zoneQualify('2026-09-06 10:58:40')).toBe('2026-09-06T10:58:40Z');
		expect(zoneQualify('2026-09-06T10:58:40')).toBe('2026-09-06T10:58:40Z');
	});
});

describe('lostPromptRecheckVerdict', () => {
	const base = { epochAtSchedule: 7, currentEpoch: 7, isStreaming: true, hasPendingPrompt: false };

	// THE POINT. A live run with no prompt on screen is indistinguishable from
	// a lost one — so it gets asked, not assumed.
	it('⭐ asks the server while a run is live and no prompt is showing', () => {
		expect(lostPromptRecheckVerdict(base)).toBe('ask');
	});

	// Must not stop: a later tool in the SAME run can park again, and a timer
	// that quit here would miss it.
	it('⭐ keeps waiting — not stops — while a prompt is already on screen', () => {
		expect(lostPromptRecheckVerdict({ ...base, hasPendingPrompt: true })).toBe('wait');
	});

	it('stops once the run is over', () => {
		expect(lostPromptRecheckVerdict({ ...base, isStreaming: false })).toBe('stop');
		expect(lostPromptRecheckVerdict({ ...base, isStreaming: false, hasPendingPrompt: true })).toBe('stop');
	});

	// Without the epoch check a timer from an abandoned run would keep polling
	// underneath its replacement, which schedules its own.
	it('stops when a newer run has claimed the stream', () => {
		expect(lostPromptRecheckVerdict({ ...base, currentEpoch: 8 })).toBe('stop');
		// Even mid-stream with nothing showing — the epoch decides first.
		expect(lostPromptRecheckVerdict({ ...base, currentEpoch: 8, isStreaming: true })).toBe('stop');
	});

	// The ordering matters: a stale epoch must lose even when everything else
	// looks like a healthy reason to ask.
	it('lets the epoch outrank a would-be ask', () => {
		expect(lostPromptRecheckVerdict({
			epochAtSchedule: 1, currentEpoch: 2, isStreaming: true, hasPendingPrompt: false,
		})).toBe('stop');
	});
});
