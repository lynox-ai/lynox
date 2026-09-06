import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
	turnEndSettlesTools,
	promptCreatedAtMs,
	zoneQualify,
	lostPromptRecheckVerdict,
	shouldArmRecheck,
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
	// every other reason must still settle.
	//
	// Note what this does NOT claim. `max_tokens` does not end the run — the
	// agent pushes a continuation turn and re-enters the loop — and a provider on
	// the OpenAI-compatible wire can report `length` after complete tool calls,
	// which maps to `max_tokens`. It settles anyway because `tool_use` is the only
	// reason on which the client can PROVE nothing has finished; guessing at the
	// others would revive the ghost. What bounds the damage is the run's
	// `done`/`error` sweep, not this function.
	it('settles on every reason other than tool_use', () => {
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

	/**
	 * ⭐ The over-promise, closed on BOTH sides. The two timestamps come from
	 * different machines. If the browser's clock runs behind the server's,
	 * `now - createdAt` goes negative and the countdown renders MORE than the
	 * timeout — the caller clamps only the low end. Without this the fix would
	 * have swapped 23:59:49 for 26:00:00.
	 */
	it('⭐ never reports a creation time in the future, however skewed the clock', () => {
		const twoHoursAhead = '2026-09-06T15:51:00Z';
		expect(promptCreatedAtMs(twoHoursAhead, NOW)).toBe(NOW);
		expect(promptCreatedAtMs(twoHoursAhead, NOW)).toBeLessThanOrEqual(NOW);
	});

	it('leaves an un-skewed timestamp alone', () => {
		const parsed = promptCreatedAtMs('2026-09-06 10:58:40', NOW);
		expect(parsed).toBe(Date.parse('2026-09-06T10:58:40Z'));
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

describe('shouldArmRecheck', () => {
	/**
	 * ⭐ THE BLOCKER this exists for. A timer left pending by the PREVIOUS run
	 * must not stop the follow-up run from arming: the old timer dies on its own
	 * epoch check without re-arming, so deferring to it means the follow-up run
	 * gets no recheck at all — and a lost prompt is exactly what makes the user
	 * send again and start that follow-up run. The feature would have failed in
	 * its own reproduction.
	 */
	it('⭐ arms for a new run even though a timer from the old one is pending', () => {
		expect(shouldArmRecheck({ timerPending: true, timerEpoch: 1, currentEpoch: 2 })).toBe(true);
	});

	// The reason the guard exists at all: one turn_end per agent-loop iteration,
	// so the same run asks repeatedly and must not stack timers.
	it('does not re-arm for a run that already has one', () => {
		expect(shouldArmRecheck({ timerPending: true, timerEpoch: 2, currentEpoch: 2 })).toBe(false);
	});

	it('arms when nothing is pending', () => {
		expect(shouldArmRecheck({ timerPending: false, timerEpoch: -1, currentEpoch: 2 })).toBe(true);
		// A stale epoch left behind by a cancelled timer must not block it either.
		expect(shouldArmRecheck({ timerPending: false, timerEpoch: 2, currentEpoch: 2 })).toBe(true);
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


/**
 * Source-level wiring guard, following `prompt-origin.test.ts` in the sibling
 * directory — same file, same reason, and it names that reason precisely: the
 * pure helpers above are provable, but nothing in them proves the STORE CALLS
 * THEM. That is the half that carries the behaviour, and a first cut of this
 * change left all three call sites unmutated: deleting any one of them kept the
 * suite green.
 *
 * `chat.svelte.ts` is a Svelte 5 rune module and the root vitest config carries
 * no svelte plugin, so importing it throws `$state is not defined` (the reason
 * `chat-detach-reset.test.ts` reads the source too). Hence source assertions —
 * pinned to the STRUCTURE of each call site, not to a string appearing anywhere
 * in the file.
 */
describe('chat store wires the prompt-liveness decisions', () => {
	const SRC = readFileSync(
		fileURLToPath(new URL('./chat.svelte.ts', import.meta.url)),
		'utf-8',
	);

	/** One SSE `case` body, bounded by the next `case` rather than by `break`. */
	function caseBody(event: string): string {
		const start = SRC.indexOf(`case '${event}':`);
		expect(start, `no handler for SSE event ${event}`).toBeGreaterThan(-1);
		const next = SRC.indexOf("case '", start + 1);
		return SRC.slice(start, next > -1 ? next : undefined);
	}

	// ⭐ The settle must be GATED, not merely present. An ungated sweep in this
	// handler is the original defect.
	it('⭐ gates the turn_end settle behind turnEndSettlesTools', () => {
		const body = caseBody('turn_end');
		expect(body).toContain('turnEndSettlesTools(turnStop)');
		// And it must read the stop reason off THIS event, not off some
		// longer-lived variable that a previous turn could have set.
		expect(body).toMatch(/turnStop\s*=\s*typeof data\['stop_reason'\]/);
	});

	// ⭐ Without this line the recheck is dead code: nothing else schedules it.
	it('⭐ schedules the lost-prompt recheck when tools are about to run', () => {
		expect(caseBody('turn_end')).toContain("if (turnStop === 'tool_use') scheduleLostPromptRecheck();");
	});

	/**
	 * ⭐ The safety net the gate makes necessary. Holding `tool_use` back leaves
	 * genuinely unresolved calls for the end of the RUN — and there are paths
	 * that build a `tool_result` without emitting one (excluded tool, denied
	 * permission, unresolved secret, schema failure, the parallel cap). Without
	 * a sweep here a spinner outlives the run, and it is persisted, so a reload
	 * does not clear it either.
	 */
	it('⭐ sweeps still-running tool calls when the run ends', () => {
		expect(caseBody('done')).toContain('settleRunningToolCalls(msg)');
		expect(caseBody('error')).toContain('settleRunningToolCalls(msg)');
	});

	/**
	 * ⭐ The blocker, pinned at the call site. `shouldArmRecheck` is provable on
	 * its own, but the scheduler could still ask the wrong question — and the
	 * first cut did: it bailed on `promptRecheckTimer !== null` alone, so a timer
	 * from the previous run silently suppressed the follow-up run's recheck. That
	 * mutation survived every other test in this file.
	 */
	it('⭐ decides whether to arm by epoch, not merely by a pending timer', () => {
		const fn = SRC.slice(SRC.indexOf('function scheduleLostPromptRecheck'));
		const body = fn.slice(0, fn.indexOf('\n}'));
		expect(body).toContain('shouldArmRecheck(');
		expect(body).toContain('timerEpoch: promptRecheckEpoch');
		expect(body).toContain('currentEpoch: streamEpoch');
		// The bare form must be gone: a null-only check is the defect.
		expect(body).not.toMatch(/if \(promptRecheckTimer !== null\) return;/);
	});

	// A replaced timer has to be cleared, or the old one still fires and the
	// module leaks a live timeout per run.
	it('clears a superseded timer instead of abandoning it', () => {
		const fn = SRC.slice(SRC.indexOf('function scheduleLostPromptRecheck'));
		expect(fn.slice(0, fn.indexOf('\n}'))).toContain('cancelLostPromptRecheck()');
		const cancel = SRC.slice(SRC.indexOf('function cancelLostPromptRecheck'));
		expect(cancel.slice(0, cancel.indexOf('\n}'))).toContain('clearTimeout(promptRecheckTimer)');
	});

	/** `checkPendingPrompt`'s body, without the rest of the module. */
	function restoreBody(): string {
		const fn = SRC.slice(SRC.indexOf('export async function checkPendingPrompt'));
		return fn.slice(0, fn.indexOf('\n}'));
	}

	// ⭐ The restore path must take the server's creation time. `Date.now()` here
	// is the bug: it restarts the countdown on every reload.
	it('⭐ restores prompts with the server createdAt, never with now', () => {
		const body = restoreBody();
		expect(body).toContain("promptCreatedAtMs(data['createdAt']");
		expect(body).not.toContain('receivedAt: Date.now()');
	});

	// The live path is the opposite: there, "now" IS the creation time, and
	// reusing the restore value would be wrong.
	it('keeps Date.now() on the live event path', () => {
		const live = caseBody('prompt');
		expect(live).toContain('receivedAt: Date.now()');
	});

	// Module state that outlives a thread, and the detach-reset guard cannot see
	// it: that guard collects `let x = $state(...)` declarations, and this is a
	// plain `let`. So it is pinned here instead of silently uncovered.
	it('⭐ cancels a pending recheck on thread switch and new chat', () => {
		const newChat = SRC.slice(SRC.indexOf('export function newChat'));
		expect(newChat.slice(0, newChat.indexOf('\n}'))).toContain('cancelLostPromptRecheck()');
		const resume = SRC.slice(SRC.indexOf('export async function resumeThread'));
		expect(resume.slice(0, 3000)).toContain('cancelLostPromptRecheck()');
	});
});
