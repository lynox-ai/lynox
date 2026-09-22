/*
 * The microphone session behind voice input — acquire, reuse, release, recycle.
 *
 * Why it is a module and not three closures in ChatView: the component cannot be
 * imported in vitest (rune component, no svelte plugin in the root config), and
 * everything in here was untested for four and a half months while carrying the
 * only defence against a known iOS capture failure.
 *
 * THE BUG THIS EXISTS FOR (reported 2026-09-22, iPhone/Safari). iOS sometimes
 * hands back a header-only WebM blob — about sixty bytes, no audio frames — on
 * second-and-later MediaRecorder runs over the same audio session. The old code
 * detected that (a blob under 1 KiB) and only showed a toast. It never touched
 * the stream, and a wedged stream is not an ENDED stream: its track still reads
 * `live`, so the reuse test kept handing the same dead session back. Worse, the
 * one escape — a 60-second idle release — was CANCELLED by the next attempt, so
 * a user retrying every few seconds (what a person actually does) pushed their
 * only recovery window ahead of themselves indefinitely. What looked like "voice
 * input stopped working" was voice input refusing to recover.
 *
 * So an empty capture must RECYCLE the session, not merely report it. That is
 * `recycle()`, and it is the difference between one failed recording and a
 * permanently broken microphone.
 */

/** The slice of MediaStreamTrack this module touches — narrow so a test can fake it. */
export interface MicTrack {
	readonly readyState: string;
	stop(): void;
}

/** The slice of MediaStream this module touches. */
export interface MicStream {
	getAudioTracks(): MicTrack[];
	getTracks(): MicTrack[];
}

/** The browser surface, injected so the policy above is drivable in a test. */
export interface MicSessionHost<S extends MicStream = MicStream> {
	/** `navigator.mediaDevices.getUserMedia({ audio: true })`. */
	acquire(): Promise<S>;
	setTimer(fn: () => void, ms: number): unknown;
	clearTimer(handle: unknown): void;
	/** Optional: called when a capture came back empty, for a console breadcrumb. */
	onRecycle?(): void;
}

/**
 * Bytes below which a capture cannot contain audio.
 *
 * A header-only WebM blob is roughly sixty bytes; a real capture of even a
 * fraction of a second is several kilobytes. The exact value is not load-bearing
 * — anything between "a container header" and "the shortest useful utterance"
 * behaves identically — but it is named here so the threshold has one home.
 */
export const MIN_CAPTURE_BYTES = 1024;

/** True when the browser returned a container with no audio frames in it. */
export function isEmptyCapture(byteLength: number): boolean {
	return byteLength < MIN_CAPTURE_BYTES;
}

export interface MicSession<S extends MicStream = MicStream> {
	/** The stream to record from, reusing a healthy one and re-acquiring otherwise. */
	ensure(): Promise<S>;
	/** Arm the idle release. No-op when nothing is held, or one is already armed. */
	scheduleRelease(): void;
	/** Stop and drop the stream now. */
	releaseNow(): void;
	/**
	 * Report what a finished recording weighed, and let the session act on it.
	 *
	 * The single entry point on purpose. Split into "is it empty?" plus "recycle
	 * or schedule?", a call site gets to pick — and picking `scheduleRelease` on
	 * an empty capture is exactly the bug: recovery 60 seconds away, cancelled by
	 * the next attempt. Here the caller reports a fact and reads a verdict.
	 */
	afterCapture(byteLength: number): 'empty' | 'captured';
	/** Whether a stream is currently held — for tests and for assertions at call sites. */
	isHeld(): boolean;
}

export function createMicSession<S extends MicStream>(
	host: MicSessionHost<S>, idleReleaseMs: number,
): MicSession<S> {
	let stream: S | null = null;
	let releaseTimer: unknown = null;

	const clearPendingRelease = (): void => {
		if (releaseTimer === null) return;
		host.clearTimer(releaseTimer);
		releaseTimer = null;
	};

	const stopStream = (): void => {
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
			stopStream();
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
			stream = await host.acquire();
			return stream;
		},

		scheduleRelease,

		releaseNow(): void {
			clearPendingRelease();
			stopStream();
		},

		afterCapture(byteLength: number): 'empty' | 'captured' {
			if (!isEmptyCapture(byteLength)) {
				// A real recording: keep the session warm for a quick re-tap.
				scheduleRelease();
				return 'captured';
			}
			// No audio came through. Reusing this stream is what kept the
			// microphone broken, so it goes now — not in 60 seconds, which the
			// next attempt would cancel.
			clearPendingRelease();
			stopStream();
			host.onRecycle?.();
			return 'empty';
		},

		isHeld(): boolean {
			return stream !== null;
		},
	};
}
