import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Guard: the client never re-POSTs /run on its own after an SSE transport
 * failure (2026-08-14, thread 861f3e4b — four run rows sharing ONE
 * prompt_hash).
 *
 * The old "pre-run" retry slept 2 s and re-POSTed the same payload whenever
 * the stream died with zero applied seq events, treating that as "the run
 * never started". The proxy was a false negative: a run whose provider is
 * erroring/backing off server-side can be live for minutes while streaming
 * nothing seq'd (the measured run: 52 s), so the re-POST minted a duplicate
 * billed run out of a transport hiccup. The authority on "is the run alive"
 * is the server: reattachToActiveRun() asks /runs/active, and only when that
 * says the run is gone does the turn render as failed for the user's
 * explicit tap-to-retry (chat.send_failed renders the failed user bubble as
 * a resend button).
 *
 * Like chat-detach-reset.test.ts this is a source-level guard, not a
 * behavioural one: chat.svelte.ts is a Svelte 5 rune module and the root
 * vitest config carries no svelte plugin, so importing it throws
 * (`$state is not defined`). Anchors THROW when they get lost, so a rename
 * turns this guard red instead of quietly making it vacuous.
 */

const SRC = readFileSync(
	fileURLToPath(new URL('./chat.svelte.ts', import.meta.url)),
	'utf-8',
);

/** Body of `_executeRun` — from its declaration to the next top-level function. */
function executeRunBody(): string {
	const start = SRC.indexOf('async function _executeRun(');
	if (start < 0) throw new Error('anchor lost: `async function _executeRun(`');
	const end = SRC.indexOf('\nfunction syncSpawnContext', start);
	if (end < 0) throw new Error('anchor lost: end of _executeRun (syncSpawnContext)');
	return SRC.slice(start, end);
}

/** The catch block that guards the SSE read loop, up to its `finally`. */
function sseCatchBlock(body: string): string {
	const afterTerminal = body.indexOf('let sawTerminal = false');
	if (afterTerminal < 0) throw new Error('anchor lost: `let sawTerminal = false`');
	const catchStart = body.indexOf('} catch {', afterTerminal);
	if (catchStart < 0) throw new Error('anchor lost: SSE `} catch {`');
	const finallyStart = body.indexOf('} finally {', catchStart);
	if (finallyStart < 0) throw new Error('anchor lost: SSE `} finally {`');
	return body.slice(catchStart, finallyStart);
}

describe('chat store — no client-side run re-fire', () => {
	it('the SSE transport-error catch fires no HTTP request at all', () => {
		const block = sseCatchBlock(executeRunBody());
		// No fetch( in the block ⇒ no request of any kind can leave it — the
		// word "/run" is deliberately NOT asserted (this guard's own comment
		// mentions it), the call is.
		expect(block).not.toContain('fetch(');
	});

	it('recovery asks the server first; a lost turn is failed, not re-POSTed', () => {
		const body = executeRunBody();
		// The retry machinery of the old pre-run path is gone entirely.
		expect(body).not.toContain('retryRes');
		// The whole recovery block (outer if) is thread-scoped …
		const blockStart = body.indexOf('if (shouldProbeServerAfterStream({');
		if (blockStart < 0) throw new Error('anchor lost: recovery block head');
		const blockWindow = body.slice(blockStart, blockStart + 5500);
		// Exact statement shape — a substring check would let a neutered guard
		// (`if (true || sessionId === sid)`) pass green.
		expect(blockWindow).toMatch(/\n\t\tif \(sessionId === sid\) \{/);
		// The re-attach is the FIRST thing after the stream ends…
		const reattachCall = body.indexOf('await reattachToActiveRun(sid, assistantIdx)');
		expect(reattachCall).toBeGreaterThan(-1);
		// …and the failed-turn fallback (tap-to-retry) sits AFTER it in the same
		// block — marking the turn failed before asking the server would regress
		// to a client-side guess about liveness, the exact bug this guards.
		const fallbackWindow = body.slice(reattachCall, reattachCall + 7000);
		expect(fallbackWindow).toContain('!.failed = true');
		// …and only for a turn that is honestly unsent: a run that FINISHED in
		// the drop window is absent from /runs/active with its answer already
		// persisted — the transcript check keeps tap-to-retry from re-running
		// a billed, already-answered turn.
		expect(fallbackWindow).toContain("/threads/${enc}/messages");
		expect(fallbackWindow).toContain(`.role === 'assistant'`);
		// The emptiness guard must cover the invisible-only states too: follow-up
		// pills and knowledge-write chips never populate content/blocks/toolCalls,
		// so a turn that rendered EITHER is partial, not unsent.
		expect(fallbackWindow).toContain('!dropped.followUps?.length');
		expect(fallbackWindow).toContain('!dropped.knowledgeWrites?.length');
		// …and when the transcript says the turn WAS answered, the recovery must
		// do something about it. Doing nothing left an empty assistant bubble
		// standing over a persisted, billed answer until a manual reload — the
		// sibling non-takeover path already reconciles for exactly this.
		//
		// Asserted as a STATEMENT (`await …;`), not as the bare name: the bare
		// name also occurs in the comment that explains this branch, so a
		// mutation removing the call left the guard green. Measured, not assumed.
		const answeredBranch = fallbackWindow.slice(fallbackWindow.indexOf('} else {'));
		expect(answeredBranch).toContain('await reconcileThread();');
		expect(answeredBranch).toContain('messages.splice(assistantIdx, 1);');
		// …and the two lines that make that call DO anything. `reconcileThread`
		// opens with `if (isStreaming) return`, and at this point in _executeRun
		// `isStreaming` is still true — it is cleared further down, after this
		// whole block. Without the reset the call is a guaranteed no-op: the
		// empty bubble stays and the billed answer stays invisible, i.e. exactly
		// the bug the branch claims to fix. Asserted as ORDER, not presence.
		// …and the error banner is cleared in that branch. A retry-shaped banner
		// standing over a confirmed answer invites the second billed send this
		// whole change exists to prevent. (Delta round on this fix, 2026-08-23.)
		expect(answeredBranch).toContain('chatError = null;');
		const reset = answeredBranch.indexOf('isStreaming = false;');
		const reconcile = answeredBranch.indexOf('await reconcileThread();');
		expect(reset).toBeGreaterThan(-1);
		expect(reset).toBeLessThan(reconcile);
	});

	it('a failure marked on a blind guess is labelled as one', () => {
		// `no-run` (the server answered: nothing live) and `unreachable` (we could
		// not ask) used to be the same `false`, and the caller read both as "the
		// run never started". Only the second one is a guess, and only the guess
		// may not be auto-re-sent.
		const body = executeRunBody();
		expect(body).toContain('failedOffline');
		// The label depends on the TRANSCRIPT alone. It used to be conjoined with
		// `reattachOutcome === 'unreachable'`, which scored `no-run` + unreachable
		// transcript as "verified" — but `no-run` only answers "nothing is live",
		// never "and nothing was persisted", which is the question this branch
		// decides. Conversely a reached transcript settles it on its own, since
		// this branch only runs when it said `!answered`.
		expect(body).toMatch(/failedOffline = !transcriptReached/);
		// And the transcript counts as reached only once its body PARSED as our
		// shape — a captive portal answers 200 with HTML, which is precisely what
		// sits in the path at the moment a network returns.
		expect(body).toContain('Array.isArray(md.messages)');
	});

	it('the reconnect refire is gated on a server re-check, not on the guess', () => {
		const onlineListener = SRC.indexOf("window.addEventListener('online'");
		if (onlineListener < 0) throw new Error('anchor lost: online listener');
		const onlineEnd = SRC.indexOf("window.addEventListener('beforeunload'", onlineListener);
		if (onlineEnd < 0) throw new Error('anchor lost: end of online listener (beforeunload)');
		const listener = SRC.slice(onlineListener, onlineEnd);
		// It asks the transcript…
		expect(listener).toContain('/threads/${enc}/messages');
		// …AND whether a run is still live. The transcript alone cannot answer
		// that: a still-executing run has not persisted its assistant message, so
		// the thread legitimately ends on the user turn — indistinguishable from
		// "never started" by role, and re-POSTing there earns a 409 and a
		// minutes-long poll duplicating the run it waits for.
		expect(listener).toContain('/runs/active');
		// …and hands the decision to the pure, unit-tested rule rather than
		// re-deriving it inline, where it could drift from the tests above.
		expect(listener).toContain('shouldRefireOfflineTurn({ reached, lastRole, activeRun })');
		// `reached` means the body PARSED as our shape, not merely that the status
		// line said 200 — the same captive-portal guard the drop path carries. It
		// needs its own assert here: the two probes are separate code, and a
		// mutation of this one alone left the drop path's assert green.
		expect(listener).toContain('Array.isArray(md.messages)');
		// The probe is single-flight. `online` fires in bursts (a Wi-Fi↔cellular
		// handover emits several) and the pre-async interlock — clearing `failed`
		// synchronously — no longer holds across the await.
		expect(listener).toContain('if (_offlineProbeInFlight) return;');
		// Every mutation is pinned to the thread the decision was made for:
		// `refireFailedTurn` → `_executeRun` resolves the CURRENT session, so a
		// thread switch mid-probe would post thread A's prompt into thread B.
		expect(listener).toContain('if (sessionId !== probeSid) return;');
		// The refire is INSIDE that decision, never before it.
		const decision = listener.indexOf('shouldRefireOfflineTurn(');
		const refire = listener.indexOf('refireFailedTurn(lastFailed)', decision);
		expect(refire).toBeGreaterThan(decision);
	});

	it('an engine `error` does not decide the turn is dead — the server does', () => {
		// THE regression this PR's second half exists for (2026-08-23, thread
		// 22edd8ee). `stream.ts` emits `type:'error'` for an unparsable tool
		// input, substitutes `input:{}` and CONTINUES the turn; `agent.ts` emits
		// the SAME event type for a genuinely dead run. The wire does not
		// distinguish them, so the client must not guess: it shows the error and
		// asks the server what became of the turn.
		//
		// Measured cost of guessing: run e2684d2e ran 152 s, spawned four
		// sub-agents and finished `completed`/`end_turn`, while its bubble read
		// "not sent — tap to retry". The only offered action was buying it twice.

		// 1) The read loop must not count `error` as a terminal end …
		const body = executeRunBody();
		expect(body).toMatch(/if \(eventType === 'done'\) sawTerminal = true;/);
		expect(body).toMatch(/else if \(eventType === 'error'\) sawErrorEvent = true;/);

		// 2) … and `_executeRun` must hand the turn's fate to the probe rather
		// than let the event handler settle it inline. Asserted on the ARGUMENT:
		// flipping it to false restores the exact old behaviour while every
		// other assert in this file stays green.
		expect(body).toContain('{ deferErrorDisposition: true }');

		// 3) The handler must actually honour the flag — the opt-in is worthless
		// if the disposition runs anyway. Pin the guard AND what it guards.
		const h = SRC.indexOf('function handleSSEEvent(');
		if (h < 0) throw new Error('anchor lost: handleSSEEvent');
		const errCase = SRC.indexOf("case 'error': {", h);
		if (errCase < 0) throw new Error('anchor lost: error case');
		const errBody = SRC.slice(errCase, errCase + 2200);
		expect(errBody).toContain('if (!opts?.deferErrorDisposition) {');
		const guard = errBody.indexOf('if (!opts?.deferErrorDisposition) {');
		const mark = errBody.indexOf('!.failed = true', guard);
		expect(mark).toBeGreaterThan(guard);
		// The toast is NOT behind the guard: the user still learns something went
		// wrong immediately. Only the "this turn is dead" verdict is deferred.
		expect(errBody.indexOf('addToast(')).toBeLessThan(guard);

		// 4) The OTHER caller keeps the immediate behaviour on purpose —
		// `reattachRun` has no post-stream probe, so deferring there would lose
		// the failure marking entirely instead of relocating it.
		const re = SRC.indexOf('async function reattachRun(');
		if (re < 0) throw new Error('anchor lost: reattachRun');
		const reBody = SRC.slice(re, SRC.indexOf('\nexport ', re + 40));
		expect(reBody).toContain('handleSSEEvent(eventType, data, assistantIdx, userIdx);');
		expect(reBody).not.toContain('deferErrorDisposition');
	});

	it('a deliberate stop is never mistaken for a transport drop', () => {
		// The server ends an aborted stream WITHOUT a done/error terminal, and
		// abortRun only clears isStreaming after the /abort round-trip — so the
		// stopped run's own cleanup needs a synchronous signal. The epoch stamp
		// is written BEFORE the abort fetch and consulted by the run's cleanup.
		const abortStart = SRC.indexOf('export async function abortRun(');
		if (abortStart < 0) throw new Error('anchor lost: abortRun');
		const abortEnd = SRC.indexOf('\nexport ', abortStart + 40);
		const abortBody = SRC.slice(abortStart, abortEnd < 0 ? SRC.length : abortEnd);
		const stamp = abortBody.indexOf('_userStopEpoch = streamEpoch;');
		expect(stamp).toBeGreaterThan(-1);
		// The real fetch (not the word "abort" in a comment above it).
		const abortFetch = abortBody.indexOf('sessions/${sessionId}/abort');
		if (abortFetch < 0) throw new Error('anchor lost: abort fetch');
		expect(stamp).toBeLessThan(abortFetch);
		// And the run's cleanup actually consults it — now as the `userStopped`
		// input of the pure probe rule (see shouldProbeServerAfterStream), which
		// returns false for a stop before it looks at anything else. Asserted on
		// the ARGUMENT, so deleting the input from the call site fails here even
		// though the rule itself stays green in its own unit tests.
		expect(executeRunBody()).toContain('userStopped: _userStopEpoch === epoch');
	});

	it('queue entries originate only from a user send or the reconnect retry', () => {
		// The send-queue is the one sanctioned "automatic" re-fire (tail drain
		// after a run ends, reload drain in resumeThread) — it is only safe
		// because no RUN machinery fills it. The two sanctioned sites:
		//   1. sendMessage() — an explicit user send while a run is streaming;
		//   2. the window 'online' listener — delivers the last VISIBLY-failed
		//      message once the network is back (gated on !isStreaming, and the
		//      server's 409 path keeps it from colliding with a live run).
		// A push anywhere else would be an auto-refire laundered through the queue.
		//
		// ANCHOR MOVED 2026-08-17, invariant unchanged. The listener's push now
		// lives in `refireFailedTurn()`, because the listener grew a second path:
		// a turn marked failed while BOTH server probes were blind gets verified
		// against the transcript before it may be re-sent. Two callers, one place
		// that touches the queue. The guard follows the code and then adds the
		// obligation the extraction creates — that the helper itself is reachable
		// only from that listener, never from the run machinery.
		const pushes = [...SRC.matchAll(/messageQueue\.push\(/g)];
		expect(pushes.length).toBe(2);

		const sendStart = SRC.indexOf('export async function sendMessage(');
		if (sendStart < 0) throw new Error('anchor lost: `export async function sendMessage(`');
		const sendEnd = SRC.indexOf('function mapApiError', sendStart);
		if (sendEnd < 0) throw new Error('anchor lost: end of sendMessage (mapApiError)');
		const inSendMessage = pushes.some((p) => p.index! > sendStart && p.index! < sendEnd);
		expect(inSendMessage).toBe(true);

		const refireStart = SRC.indexOf('function refireFailedTurn(');
		if (refireStart < 0) throw new Error('anchor lost: `function refireFailedTurn(`');
		const refireEnd = SRC.indexOf('\n}', refireStart);
		const inRefireHelper = pushes.some((p) => p.index! > refireStart && p.index! < refireEnd);
		expect(inRefireHelper).toBe(true);

		// Every CALL of the helper sits inside the online listener — so the second
		// queue site cannot be reached from a run, a resume, or a timer.
		const onlineListener = SRC.indexOf("window.addEventListener('online'");
		if (onlineListener < 0) throw new Error('anchor lost: online listener');
		const onlineEnd = SRC.indexOf("window.addEventListener('beforeunload'", onlineListener);
		if (onlineEnd < 0) throw new Error('anchor lost: end of online listener (beforeunload)');
		// Everything outside the helper's own body is a call site (its declaration
		// is inside that range, so it drops out here rather than needing a special
		// case).
		const callSites = [...SRC.matchAll(/refireFailedTurn\(/g)]
			.filter((c) => c.index! < refireStart || c.index! > refireEnd);
		expect(callSites.length).toBeGreaterThan(0);
		for (const c of callSites) {
			expect(c.index!).toBeGreaterThan(onlineListener);
			expect(c.index!).toBeLessThan(onlineEnd);
		}

		// And NONE of them may sit inside the run/resume machinery.
		const runStart = SRC.indexOf('async function _executeRun(');
		if (runStart < 0) throw new Error('anchor lost: _executeRun');
		const runEnd = SRC.indexOf('\nfunction syncSpawnContext', runStart);
		const resumeStart = SRC.indexOf('export async function resumeThread(');
		if (resumeStart < 0) throw new Error('anchor lost: resumeThread');
		const nextExport = SRC.indexOf('\nexport ', resumeStart + 40);
		const nextFunction = SRC.indexOf('\nfunction ', resumeStart + 40);
		const resumeEnd = Math.min(
			nextExport < 0 ? SRC.length : nextExport,
			nextFunction < 0 ? SRC.length : nextFunction,
		);
		for (const p of pushes) {
			const inRun = p.index! > runStart && p.index! < runEnd;
			expect(inRun, 'messageQueue.push inside run machinery').toBe(false);
			// resumeThread drains the queue but must never fill it.
			const inResume = p.index! > resumeStart && p.index! < resumeEnd;
			expect(inResume, 'messageQueue.push inside resumeThread').toBe(false);
		}
	});
});
