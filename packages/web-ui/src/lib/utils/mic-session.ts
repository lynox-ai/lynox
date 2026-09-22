/*
 * The microphone session behind voice input — acquire, reuse, release, recycle.
 *
 * It is a module and not three closures in ChatView because the component
 * cannot be imported in vitest (rune component, no svelte plugin in the root
 * config), and this logic went four and a half months without a single test
 * while carrying the only response to a known iOS capture failure.
 *
 * ── WHAT IS MEASURED, AND WHAT IS NOT ──────────────────────────────────────
 *
 * Measured (core#256, 2026-05-06, from a HAR): on iOS Safari a wedged audio
 * session makes MediaRecorder emit a header-only WebM blob of about sixty
 * bytes, where a working recording in the same session was 87 KB and 221 KB.
 * Three orders of magnitude, so a byte threshold separates them with room to
 * spare. That commit ALSO recorded two things that argue against the obvious
 * repair, and they are written here because a later reader will otherwise
 * rediscover them the expensive way:
 *
 *   · "all subsequent clamped under 1KB **until page reload**" — and at that
 *     time every recording already stopped its tracks and called getUserMedia
 *     again. So re-acquiring did NOT heal it.
 *   · "per-recording getUserMedia + new MediaRecorder drove iOS Safari into a
 *     stuck audio-session state" — re-acquiring per recording was named as a
 *     CAUSE. The persistent stream this module keeps was the fix for it.
 *
 * NOT measured: that `recycle` helps. It is a hypothesis. What is known is only
 * that the session in hand is producing nothing, so dropping it cannot make
 * that session worse — and that dropping it on EVERY recording is the pattern
 * that historically caused the wedge, which is why `afterCapture` will not do
 * it for a short tap. A device verification is owed and is recorded as owed.
 *
 * NOT measured either: that today's failure (reported 2026-09-22, iPhone) is
 * the same mechanism as 2026-05-06. The analyser branch blamed back then has
 * since been removed entirely. Treat the two as related, not identical.
 */

/** The slice of MediaStreamTrack this module touches — narrow so a test can fake it. */
export interface MicTrack {
	readonly readyState: string;
	stop(): void;
}

/**
 * The slice of MediaStream this module touches.
 *
 * `getAudioTracks` and `getTracks` are DIFFERENT sets and the difference is
 * load-bearing: health is judged on audio tracks only (a live video track must
 * not vouch for a dead microphone), while teardown must stop everything.
 */
export interface MicStream {
	getAudioTracks(): MicTrack[];
	getTracks(): MicTrack[];
}

/** The browser surface, injected so the policy is drivable in a test. */
export interface MicSessionHost<S extends MicStream = MicStream> {
	/** `navigator.mediaDevices.getUserMedia({ audio: true })`. */
	acquire(): Promise<S>;
	setTimer(fn: () => void, ms: number): unknown;
	clearTimer(handle: unknown): void;
	/** Called when a capture came back empty and the session was dropped. */
	onRecycle?(byteLength: number, durationMs: number): void;
}

/**
 * Thrown by `ensure()` when the session was released while the acquire was
 * still in flight — the user backgrounded the app or navigated away mid-prompt.
 * The caller should abandon the recording quietly rather than report a fault.
 */
export class MicSessionReleased extends Error {
	constructor() {
		super('microphone session was released while acquiring');
		this.name = 'MicSessionReleased';
	}
}

/**
 * Bytes below which a capture cannot contain audio. See the HAR figures above:
 * broken is ~60 B, working was 87 KB. Anything in between separates them.
 */
export const MIN_CAPTURE_BYTES = 1024;

/**
 * Milliseconds below which a sub-threshold capture is explained by its own
 * brevity rather than by a fault.
 *
 * The mic button is tap-to-toggle, so two quick taps are a normal accident and
 * produce a small blob honestly. Telling those two cases apart matters because
 * the response differs: a short tap must NOT drop the session (dropping it per
 * recording is the pattern the 05-06 notes blame for the wedge), while an empty
 * long recording is the case worth dropping it for.
 */
export const MIN_CAPTURE_MS = 700;

/** What a finished recording turned out to be. */
export type CaptureVerdict =
	/** Real audio. The session stays warm for a quick re-tap. */
	| 'captured'
	/** Too brief to contain anything. Honest, not a fault; the session is kept. */
	| 'short'
	/** Long enough to contain audio, and did not. The session is dropped. */
	| 'empty'
	/** No session was held — it was torn down mid-recording. Not a fault to report. */
	| 'aborted';

export interface MicSession<S extends MicStream = MicStream> {
	/** The stream to record from. Throws `MicSessionReleased` if released meanwhile. */
	ensure(): Promise<S>;
	/** Arm the idle release. No-op when nothing is held, or one is already armed. */
	scheduleRelease(): void;
	/** Stop and drop the stream now, superseding any acquire still in flight. */
	releaseNow(): void;
	/**
	 * Report what a finished recording weighed and how long it ran, and let the
	 * session act on it.
	 *
	 * One entry point rather than a predicate plus two actions: split apart, a
	 * call site gets to pick, and picking the wrong one is the whole defect.
	 * (The caller may still have armed an idle release before this runs —
	 * `cleanupRecording` does — so every branch here leaves the timer in the
	 * state it wants rather than assuming one.)
	 */
	afterCapture(byteLength: number, durationMs: number): CaptureVerdict;
	/** Whether a live stream is currently held. */
	isHeld(): boolean;
}

export function createMicSession<S extends MicStream>(
	host: MicSessionHost<S>, idleReleaseMs: number,
): MicSession<S> {
	let stream: S | null = null;
	let releaseTimer: unknown = null;
	/**
	 * Bumped by every teardown. An `ensure()` that started before the bump must
	 * not install the stream it was waiting for: the user has already left, and
	 * installing it leaves the recording indicator lit with no way to turn it off.
	 */
	let generation = 0;

	const clearPendingRelease = (): void => {
		if (releaseTimer === null) return;
		host.clearTimer(releaseTimer);
		releaseTimer = null;
	};

	const teardown = (): void => {
		generation++;
		if (stream === null) return;
		for (const track of stream.getTracks()) track.stop();
		stream = null;
	};

	const scheduleRelease = (): void => {
		// Nothing held (the component may have torn the mic down on navigation)
		// → do not arm a timer that would only expire against null state.
		if (stream === null) return;
		if (releaseTimer !== null) return;
		releaseTimer = host.setTimer(() => {
			releaseTimer = null;
			teardown();
		}, idleReleaseMs);
	};

	return {
		async ensure(): Promise<S> {
			// A pending release means we are inside the idle window — cancel it and
			// keep the still-live session, so a quick re-tap does not re-prompt.
			clearPendingRelease();
			if (stream !== null && stream.getAudioTracks().some((t) => t.readyState === 'live')) {
				return stream;
			}
			// Drop the dead one BEFORE asking for a new one: if the acquire is
			// refused, `isHeld()` must not keep reporting a stream nobody can use.
			teardown();
			const mine = generation;
			const acquired = await host.acquire();
			if (mine !== generation) {
				for (const track of acquired.getTracks()) track.stop();
				throw new MicSessionReleased();
			}
			stream = acquired;
			return stream;
		},

		scheduleRelease,

		releaseNow(): void {
			clearPendingRelease();
			teardown();
		},

		afterCapture(byteLength: number, durationMs: number): CaptureVerdict {
			if (stream === null) {
				// Torn down while recording — backgrounded, navigated away. The tiny
				// blob is the consequence of that, not evidence of a fault, and
				// reporting it would fill the only diagnostic trace with noise.
				return 'aborted';
			}
			if (byteLength >= MIN_CAPTURE_BYTES) {
				scheduleRelease();
				return 'captured';
			}
			if (durationMs < MIN_CAPTURE_MS) {
				// Two quick taps. Keep the session: dropping it per recording is the
				// pattern the 05-06 notes blame for the stuck audio session.
				scheduleRelease();
				return 'short';
			}
			clearPendingRelease();
			teardown();
			host.onRecycle?.(byteLength, durationMs);
			return 'empty';
		},

		isHeld(): boolean {
			return stream !== null;
		},
	};
}
