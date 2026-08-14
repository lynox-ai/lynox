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
		// The re-attach is the FIRST thing after the stream ends…
		const reattachCall = body.indexOf('await reattachToActiveRun(sid, assistantIdx)');
		expect(reattachCall).toBeGreaterThan(-1);
		// …and the failed-turn fallback (tap-to-retry) sits AFTER it in the same
		// block — marking the turn failed before asking the server would regress
		// to a client-side guess about liveness, the exact bug this guards.
		const fallbackWindow = body.slice(reattachCall, reattachCall + 2000);
		expect(fallbackWindow).toContain('!.failed = true');
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
		const pushes = [...SRC.matchAll(/messageQueue\.push\(/g)];
		expect(pushes.length).toBe(2);

		const sendStart = SRC.indexOf('export async function sendMessage(');
		if (sendStart < 0) throw new Error('anchor lost: `export async function sendMessage(`');
		const sendEnd = SRC.indexOf('function mapApiError', sendStart);
		if (sendEnd < 0) throw new Error('anchor lost: end of sendMessage (mapApiError)');
		const inSendMessage = pushes.some((p) => p.index! > sendStart && p.index! < sendEnd);
		expect(inSendMessage).toBe(true);

		const onlineListener = SRC.indexOf("window.addEventListener('online'");
		if (onlineListener < 0) throw new Error('anchor lost: online listener');
		const onlineEnd = SRC.indexOf('window.addEventListener(', onlineListener + 10);
		const onlineWindowEnd = onlineEnd < 0 ? SRC.length : onlineEnd;
		const inOnlineListener = pushes.some((p) => p.index! > onlineListener && p.index! < onlineWindowEnd);
		expect(inOnlineListener).toBe(true);

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
