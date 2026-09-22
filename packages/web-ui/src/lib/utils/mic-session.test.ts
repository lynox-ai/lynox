import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	createMicSession, isEmptyCapture, MIN_CAPTURE_BYTES,
	type MicSessionHost, type MicStream, type MicTrack,
} from './mic-session.js';

const IDLE_MS = 60_000;

/** A fake audio track. `wedge()` models iOS: produces nothing, still reads `live`. */
function fakeTrack(): MicTrack & { stopped: boolean; end(): void } {
	let state = 'live';
	return {
		get readyState() { return state; },
		stop() { this.stopped = true; state = 'ended'; },
		stopped: false,
		end() { state = 'ended'; },
	};
}

function fakeStream(): MicStream & { tracks: ReturnType<typeof fakeTrack>[] } {
	const tracks = [fakeTrack()];
	return { tracks, getAudioTracks: () => tracks, getTracks: () => tracks };
}

function fakeHost() {
	const acquired: ReturnType<typeof fakeStream>[] = [];
	const timers = new Map<number, { fn: () => void; dueIn: number }>();
	let nextHandle = 1;
	let recycles = 0;

	const host: MicSessionHost = {
		acquire: async () => { const s = fakeStream(); acquired.push(s); return s; },
		setTimer: (fn, ms) => { const h = nextHandle++; timers.set(h, { fn, dueIn: ms }); return h; },
		clearTimer: (handle) => { timers.delete(handle as number); },
		onRecycle: () => { recycles++; },
	};

	return {
		host,
		acquired,
		/** Fire every armed timer, as the idle window elapsing would. */
		elapse() { for (const [h, t] of [...timers]) { timers.delete(h); t.fn(); } },
		armed: () => timers.size,
		armedDelays: () => [...timers.values()].map((t) => t.dueIn),
		recycles: () => recycles,
	};
}

describe('isEmptyCapture', () => {
	it('rejects a container with no audio frames in it', () => {
		// iOS hands back roughly sixty bytes when the session is wedged.
		expect(isEmptyCapture(0)).toBe(true);
		expect(isEmptyCapture(60)).toBe(true);
		expect(isEmptyCapture(MIN_CAPTURE_BYTES - 1)).toBe(true);
	});

	it('accepts anything from a real capture upward', () => {
		expect(isEmptyCapture(MIN_CAPTURE_BYTES)).toBe(false);
		expect(isEmptyCapture(48_000)).toBe(false);
	});
});

describe('createMicSession — acquiring and reusing', () => {
	it('acquires once and reuses a healthy stream', async () => {
		const f = fakeHost();
		const s = createMicSession(f.host, IDLE_MS);
		const a = await s.ensure();
		const b = await s.ensure();
		expect(a).toBe(b);
		expect(f.acquired).toHaveLength(1);
	});

	it('re-acquires when the track has ended', async () => {
		const f = fakeHost();
		const s = createMicSession(f.host, IDLE_MS);
		const first = await s.ensure();
		f.acquired[0]!.tracks[0]!.end();
		const second = await s.ensure();
		expect(second).not.toBe(first);
		expect(f.acquired).toHaveLength(2);
	});

	it('cancels a pending idle release rather than losing the session', async () => {
		const f = fakeHost();
		const s = createMicSession(f.host, IDLE_MS);
		const first = await s.ensure();
		s.scheduleRelease();
		expect(f.armed()).toBe(1);

		const again = await s.ensure();
		expect(again).toBe(first);
		expect(f.armed()).toBe(0);
		expect(f.acquired).toHaveLength(1);
	});
});

describe('createMicSession — releasing', () => {
	it('arms the idle release at the configured delay', async () => {
		const f = fakeHost();
		const s = createMicSession(f.host, IDLE_MS);
		await s.ensure();
		s.scheduleRelease();
		expect(f.armedDelays()).toEqual([IDLE_MS]);
	});

	it('does not arm a timer when nothing is held', () => {
		const f = fakeHost();
		createMicSession(f.host, IDLE_MS).scheduleRelease();
		expect(f.armed()).toBe(0);
	});

	it('does not arm a second timer on top of a pending one', async () => {
		const f = fakeHost();
		const s = createMicSession(f.host, IDLE_MS);
		await s.ensure();
		s.scheduleRelease();
		s.scheduleRelease();
		expect(f.armed()).toBe(1);
	});

	it('stops the tracks when the idle window elapses', async () => {
		const f = fakeHost();
		const s = createMicSession(f.host, IDLE_MS);
		await s.ensure();
		s.scheduleRelease();
		f.elapse();
		expect(f.acquired[0]!.tracks[0]!.stopped).toBe(true);
		expect(s.isHeld()).toBe(false);
	});

	it('releaseNow stops the tracks and drops the pending timer', async () => {
		const f = fakeHost();
		const s = createMicSession(f.host, IDLE_MS);
		await s.ensure();
		s.scheduleRelease();
		s.releaseNow();
		expect(f.acquired[0]!.tracks[0]!.stopped).toBe(true);
		expect(f.armed()).toBe(0);
		expect(s.isHeld()).toBe(false);
	});
});

/**
 * The reported failure, as a scenario.
 *
 * iOS wedges the audio session: the recorder yields a header-only blob, but the
 * track still reads `live`, so nothing in the health check notices. What made it
 * PERMANENT rather than occasional was the recovery path — a 60-second idle
 * release that the next attempt cancelled. A user retrying every few seconds
 * never reached it.
 */
describe('a wedged session must not survive the next attempt', () => {
	it('an empty capture forces a fresh stream even though the old track still reads live', async () => {
		const f = fakeHost();
		const s = createMicSession(f.host, IDLE_MS);
		const wedged = await s.ensure();
		expect(wedged.getAudioTracks()[0]!.readyState).toBe('live'); // nothing looks wrong

		expect(s.afterCapture(60)).toBe('empty');
		const fresh = await s.ensure();

		expect(fresh).not.toBe(wedged);
		expect(f.acquired).toHaveLength(2);
		expect(f.acquired[0]!.tracks[0]!.stopped).toBe(true);
	});

	it('recovers on the very next attempt, without waiting out the idle window', async () => {
		const f = fakeHost();
		const s = createMicSession(f.host, IDLE_MS);
		const wedged = await s.ensure();

		expect(s.afterCapture(60)).toBe('empty');
		// No f.elapse() anywhere: the user retried after two seconds, as people do.
		const next = await s.ensure();
		expect(next).not.toBe(wedged);
	});

	it('scheduling a release instead would NOT have recovered — the retry cancels it', async () => {
		// This is the old behaviour, written out, so the fix above has something
		// to be different from. Three impatient retries, same dead stream each
		// time, and the escape hatch pushed further away on every one.
		const f = fakeHost();
		const s = createMicSession(f.host, IDLE_MS);
		const wedged = await s.ensure();

		for (let attempt = 0; attempt < 3; attempt++) {
			s.scheduleRelease();          // what cleanupRecording did
			expect(f.armed()).toBe(1);
			const again = await s.ensure(); // the user taps again, inside the window
			expect(again).toBe(wedged);     // …and gets the wedged session back
			expect(f.armed()).toBe(0);      // …having just cancelled their own recovery
		}
		expect(f.acquired).toHaveLength(1);
	});

	it('reports the recycle so the failure can leave a trace', async () => {
		const f = fakeHost();
		const s = createMicSession(f.host, IDLE_MS);
		await s.ensure();
		expect(s.afterCapture(60)).toBe('empty');
		expect(f.recycles()).toBe(1);
	});

	it('an empty capture with nothing held is harmless', () => {
		const f = fakeHost();
		createMicSession(f.host, IDLE_MS).afterCapture(60);
		expect(f.armed()).toBe(0);
	});
});

describe('afterCapture decides, so the call site cannot pick wrong', () => {
	it('a real capture keeps the session and arms the idle release', async () => {
		// The counter-direction. Recycling unconditionally would "fix" the wedge
		// and break the warm session: on some browsers every recording would
		// re-prompt for the microphone, and the quick re-tap this whole idle
		// window exists for would stop working.
		const f = fakeHost();
		const s = createMicSession(f.host, IDLE_MS);
		const held = await s.ensure();

		expect(s.afterCapture(48_000)).toBe('captured');
		expect(s.isHeld()).toBe(true);
		expect(f.armedDelays()).toEqual([IDLE_MS]);
		expect(f.recycles()).toBe(0);
		expect(await s.ensure()).toBe(held);
		expect(f.acquired).toHaveLength(1);
	});

	it('an empty capture drops the session and arms nothing', async () => {
		const f = fakeHost();
		const s = createMicSession(f.host, IDLE_MS);
		await s.ensure();

		expect(s.afterCapture(60)).toBe('empty');
		expect(s.isHeld()).toBe(false);
		expect(f.armed()).toBe(0);
		expect(f.recycles()).toBe(1);
	});

	it('splits exactly at the capture threshold', async () => {
		const f = fakeHost();
		const s = createMicSession(f.host, IDLE_MS);
		await s.ensure();
		expect(s.afterCapture(MIN_CAPTURE_BYTES)).toBe('captured');
		await s.ensure();
		expect(s.afterCapture(MIN_CAPTURE_BYTES - 1)).toBe('empty');
	});

	it('an empty capture clears a release armed moments earlier', async () => {
		// Order matters at the call site: cleanupRecording() schedules the idle
		// release BEFORE the blob is weighed. If afterCapture only stopped the
		// tracks, that timer would survive and fire against a dead session.
		const f = fakeHost();
		const s = createMicSession(f.host, IDLE_MS);
		await s.ensure();
		s.scheduleRelease();
		expect(f.armed()).toBe(1);

		s.afterCapture(60);
		expect(f.armed()).toBe(0);
	});
});

/**
 * Wiring. Source-level because ChatView cannot be imported in vitest (a rune
 * component, no svelte plugin in the root config) — but narrowed to what a
 * regex can actually hold. The decision itself is NOT guarded here: there is
 * only one method to call, so "recycle or schedule?" is no longer a choice the
 * call site can get wrong.
 *
 * Full-line comments are stripped before matching. `//` also appears inside
 * dozens of URLs in this file, so stripping every `//` to end-of-line would
 * corrupt the text being searched; and an earlier guard elsewhere in this repo
 * matched its own subject inside a COMMENTED-OUT line and stayed green over the
 * original bug.
 */
describe('ChatView goes through the mic session', () => {
	const SRC = readFileSync(
		fileURLToPath(new URL('../components/ChatView.svelte', import.meta.url)), 'utf-8',
	)
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^[ \t]*\/\/.*$/gm, '');

	const occurrences = (needle: string): number => SRC.split(needle).length - 1;

	it('has source to scan — anchored on the recording path, not on an import', () => {
		expect(SRC).toContain('recorder.onstop');
		expect(SRC).toContain('createMicSession');
	});

	it('weighs every finished recording through the session, exactly once', () => {
		expect(occurrences('afterCapture(')).toBe(1);
		expect(SRC).toMatch(/micSession\.afterCapture\(\s*blob\.size\s*\)\s*===\s*'empty'/);
	});

	it('never reaches past the session to the raw microphone', () => {
		// Acquisition belongs to the session host and nowhere else; a second one
		// would hold a stream the session cannot recycle. Counted as a CALL
		// (`getUserMedia(`) rather than a mention: the guard first fired on the
		// feature test `navigator.mediaDevices?.getUserMedia`, which is a
		// legitimate second mention and not a second acquisition.
		expect(occurrences('getUserMedia(')).toBe(1);
		expect(SRC).toContain('navigator.mediaDevices?.getUserMedia');
		expect(SRC).not.toMatch(/getTracks\(\)\s*\.\s*forEach/);
		expect(SRC).not.toContain('micStream');
	});

	it('shows the honest message, and the misleading one is gone', () => {
		// The old copy told the user to HOLD a button that has been tap-to-toggle
		// since the day that text was written.
		expect(SRC).toContain("t('chat.voice_empty_capture')");
		expect(SRC).not.toContain('voice_too_short');
	});
});

describe('the misleading copy is gone from both languages', () => {
	const I18N = readFileSync(
		fileURLToPath(new URL('../i18n.svelte.ts', import.meta.url)), 'utf-8',
	);

	it('has source to scan', () => {
		expect(I18N).toContain("'chat.voice_empty_capture'");
	});

	it('no longer instructs a gesture the button does not support', () => {
		expect(I18N).not.toContain('voice_too_short');
		expect(I18N).not.toMatch(/Halte den Mic-Button gedr/);
		expect(I18N).not.toMatch(/Hold the mic button/);
	});

	it('carries the replacement in both languages', () => {
		const line = I18N.split('\n').find((l) => l.includes("'chat.voice_empty_capture'")) ?? '';
		expect(line).toMatch(/de:\s*'[^']{20,}'/);
		expect(line).toMatch(/en:\s*'[^']{20,}'/);
	});
});
