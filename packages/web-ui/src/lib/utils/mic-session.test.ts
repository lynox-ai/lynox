import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	createMicSession, MicSessionReleased, MIN_CAPTURE_BYTES, MIN_CAPTURE_MS,
	type MicSessionHost, type MicStream, type MicTrack,
} from './mic-session.js';

/**
 * Deliberately NOT the production value (60_000).
 *
 * With the two equal, `expect(armedDelays()).toEqual([IDLE_MS])` passes against
 * an implementation that ignores its `idleReleaseMs` argument and hardcodes
 * 60_000 — measured: that mutation survived the whole suite. A distinctive
 * number turns a coincidence back into an assertion.
 */
const IDLE_MS = 7_337;

/** A fake audio track. Real `stop()` sets readyState synchronously; so does this. */
function fakeTrack(kind: 'audio' | 'video' = 'audio') {
	return {
		kind,
		readyState: 'live',
		stopped: false,
		stop(this: { readyState: string; stopped: boolean }) { this.stopped = true; this.readyState = 'ended'; },
	};
}

/**
 * A stream whose `getAudioTracks()` and `getTracks()` are genuinely different
 * sets, because the distinction is load-bearing and a shared array hides it:
 * health is judged on audio tracks (a live video track must not vouch for a
 * dead microphone) while teardown must stop everything. With one shared array,
 * swapping the two methods — and `some` for `every`, and `=== 'live'` for
 * `!== 'ended'` — all survived.
 */
function fakeStream(audio: ReturnType<typeof fakeTrack>[] = [fakeTrack()], video: ReturnType<typeof fakeTrack>[] = [fakeTrack('video')]) {
	const all = [...audio, ...video];
	return {
		audio, video, all,
		getAudioTracks: () => audio as unknown as MicTrack[],
		getTracks: () => all as unknown as MicTrack[],
	};
}

function fakeHost(streams?: Array<ReturnType<typeof fakeStream>>) {
	const acquired: ReturnType<typeof fakeStream>[] = [];
	const timers = new Map<number, { fn: () => void; dueIn: number }>();
	let nextHandle = 1;
	const recycles: Array<{ bytes: number; durationMs: number }> = [];
	let queue = streams ? [...streams] : null;
	let pendingResolve: (() => void) | null = null;
	let deferred = false;

	const host: MicSessionHost<MicStream> = {
		acquire: async () => {
			const s = queue?.shift() ?? fakeStream();
			acquired.push(s);
			if (deferred) return new Promise<MicStream>((r) => { pendingResolve = () => r(s as unknown as MicStream); });
			return s as unknown as MicStream;
		},
		setTimer: (fn, ms) => { const h = nextHandle++; timers.set(h, { fn, dueIn: ms }); return h; },
		clearTimer: (handle) => { timers.delete(handle as number); },
		onRecycle: (bytes, durationMs) => { recycles.push({ bytes, durationMs }); },
	};

	return {
		host,
		acquired,
		/** Make the next acquire hang until `settleAcquire()` is called. */
		deferAcquire() { deferred = true; },
		settleAcquire() { deferred = false; pendingResolve?.(); },
		elapse() { for (const [h, t] of [...timers]) { timers.delete(h); t.fn(); } },
		armed: () => timers.size,
		armedDelays: () => [...timers.values()].map((t) => t.dueIn),
		recycles: () => recycles,
	};
}

/** A capture that is real audio, and one that is a container header. */
const REAL = MIN_CAPTURE_BYTES * 40;
const HEADER_ONLY = 60;
const LONG = MIN_CAPTURE_MS * 4;

describe('the thresholds are values, not whatever the source says', () => {
	it('pins the byte floor', () => {
		// Asserting `MIN_CAPTURE_BYTES ± 1` is relative to the subject: every
		// threshold between the header size and a real recording survived it.
		expect(MIN_CAPTURE_BYTES).toBe(1024);
	});

	it('pins the duration floor', () => {
		expect(MIN_CAPTURE_MS).toBe(700);
	});
});

describe('acquiring and reusing', () => {
	it('acquires once and reuses a healthy stream', async () => {
		const f = fakeHost();
		const s = createMicSession(f.host, IDLE_MS);
		expect(await s.ensure()).toBe(await s.ensure());
		expect(f.acquired).toHaveLength(1);
	});

	it('re-acquires when the AUDIO track has ended, even with a live video track', async () => {
		// The health check must read audio tracks only. Judging `getTracks()`
		// instead lets a live video track vouch for a dead microphone — which is
		// the exact failure this module exists for.
		const dead = fakeTrack();
		dead.stop();
		const f = fakeHost([fakeStream([dead], [fakeTrack('video')]), fakeStream()]);
		const s = createMicSession(f.host, IDLE_MS);
		await s.ensure();
		await s.ensure();
		expect(f.acquired).toHaveLength(2);
	});

	it('requires EVERY audio track to be dead before re-acquiring, not just one', async () => {
		const dead = fakeTrack();
		dead.stop();
		const f = fakeHost([fakeStream([dead, fakeTrack()])]);
		const s = createMicSession(f.host, IDLE_MS);
		const first = await s.ensure();
		expect(await s.ensure()).toBe(first); // one live audio track is enough
		expect(f.acquired).toHaveLength(1);
	});

	it('stops the old stream before asking for a new one', async () => {
		const dead = fakeTrack();
		const f = fakeHost([fakeStream([dead]), fakeStream()]);
		const s = createMicSession(f.host, IDLE_MS);
		await s.ensure();
		dead.readyState = 'ended';
		await s.ensure();
		expect(f.acquired[0]!.all.every((t) => t.stopped)).toBe(true);
	});

	it('does not keep reporting a stream it failed to replace', async () => {
		// A refused permission must not leave `isHeld()` claiming a session that
		// nobody can record from.
		const dead = fakeTrack();
		dead.stop();
		const f = fakeHost([fakeStream([dead])]);
		const failing: MicSessionHost<MicStream> = {
			...f.host, acquire: () => Promise.reject(new Error('NotAllowedError')),
		};
		const s = createMicSession(failing, IDLE_MS);
		await expect(s.ensure()).rejects.toThrow();
		expect(s.isHeld()).toBe(false);
	});

	it('cancels a pending idle release rather than losing the session', async () => {
		const f = fakeHost();
		const s = createMicSession(f.host, IDLE_MS);
		const first = await s.ensure();
		s.scheduleRelease();
		expect(f.armed()).toBe(1);
		expect(await s.ensure()).toBe(first);
		expect(f.armed()).toBe(0);
		expect(f.acquired).toHaveLength(1);
	});
});

describe('a teardown during an in-flight acquire', () => {
	it('does not install the stream the user already walked away from', async () => {
		// Reproduced from the real call path: `startRecording` awaits `ensure()`
		// while `visibilitychange`, `beforeunload` and `afterNavigate` all call
		// `releaseNow()`. Before the generation guard, the acquire resolved after
		// the release and re-installed the stream — the recording indicator stayed
		// lit with no way to turn it off.
		const f = fakeHost();
		const s = createMicSession(f.host, IDLE_MS);
		f.deferAcquire();
		const pending = s.ensure();
		s.releaseNow();
		f.settleAcquire();

		await expect(pending).rejects.toBeInstanceOf(MicSessionReleased);
		expect(s.isHeld()).toBe(false);
		expect(f.acquired[0]!.all.every((t) => t.stopped)).toBe(true);
	});

	it('leaves a later acquire alone', async () => {
		const f = fakeHost();
		const s = createMicSession(f.host, IDLE_MS);
		f.deferAcquire();
		const pending = s.ensure();
		s.releaseNow();
		f.settleAcquire();
		await pending.catch(() => {});

		const fresh = await s.ensure();
		expect(s.isHeld()).toBe(true);
		expect(fresh).toBe(f.acquired[1] as unknown as MicStream);
	});
});

describe('releasing', () => {
	it('arms the idle release at the delay it was CONFIGURED with', async () => {
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

	it('stops every track when the idle window elapses', async () => {
		const f = fakeHost();
		const s = createMicSession(f.host, IDLE_MS);
		await s.ensure();
		s.scheduleRelease();
		f.elapse();
		expect(f.acquired[0]!.all.every((t) => t.stopped)).toBe(true);
		expect(s.isHeld()).toBe(false);
	});

	it('releaseNow stops every track and drops the pending timer', async () => {
		const f = fakeHost();
		const s = createMicSession(f.host, IDLE_MS);
		await s.ensure();
		s.scheduleRelease();
		s.releaseNow();
		expect(f.acquired[0]!.all.every((t) => t.stopped)).toBe(true);
		expect(f.armed()).toBe(0);
		expect(s.isHeld()).toBe(false);
	});
});

/**
 * `afterCapture` is the one entry point because the three small-blob cases need
 * different answers, and only one of them is a fault. Getting that wrong in
 * either direction is expensive: never dropping the session leaves a wedged
 * microphone wedged, and always dropping it reintroduces the per-recording
 * stop/getUserMedia pattern that the 2026-05-06 notes blame for the wedge.
 */
describe('afterCapture tells three small blobs apart', () => {
	const held = async (f: ReturnType<typeof fakeHost>) => {
		const s = createMicSession(f.host, IDLE_MS);
		await s.ensure();
		return s;
	};

	it('real audio: keeps the session warm', async () => {
		const f = fakeHost();
		const s = await held(f);
		expect(s.afterCapture(REAL, LONG)).toBe('captured');
		expect(s.isHeld()).toBe(true);
		expect(f.armedDelays()).toEqual([IDLE_MS]);
		expect(f.recycles()).toEqual([]);
	});

	it('a brief tap: honest, and the session survives it', async () => {
		// Two quick taps on a toggle button. Dropping the session here is the
		// counter-direction — it would thrash the audio session on a healthy
		// device, every time someone mis-taps.
		const f = fakeHost();
		const s = await held(f);
		expect(s.afterCapture(HEADER_ONLY, MIN_CAPTURE_MS - 1)).toBe('short');
		expect(s.isHeld()).toBe(true);
		expect(f.armedDelays()).toEqual([IDLE_MS]);
		expect(f.recycles()).toEqual([]);
	});

	it('long and silent: the session is dropped, and says so', async () => {
		const f = fakeHost();
		const s = await held(f);
		expect(s.afterCapture(HEADER_ONLY, LONG)).toBe('empty');
		expect(s.isHeld()).toBe(false);
		expect(f.armed()).toBe(0);
		expect(f.recycles()).toEqual([{ bytes: HEADER_ONLY, durationMs: LONG }]);
	});

	it('nothing held: reports nothing rather than inventing a fault', async () => {
		// Torn down mid-recording (backgrounded, navigated). The tiny blob is the
		// consequence. Reporting it would fill the only diagnostic trace with
		// noise and show the user an error for something they did on purpose.
		const f = fakeHost();
		const s = createMicSession(f.host, IDLE_MS);
		expect(s.afterCapture(HEADER_ONLY, LONG)).toBe('aborted');
		expect(f.recycles()).toEqual([]);
		expect(f.armed()).toBe(0);
	});

	it('splits at the byte floor', async () => {
		const f = fakeHost();
		const s = await held(f);
		expect(s.afterCapture(1024, LONG)).toBe('captured');
		expect(s.afterCapture(1023, LONG)).toBe('empty');
	});

	it('splits at the duration floor', async () => {
		const f = fakeHost();
		const s = await held(f);
		expect(s.afterCapture(HEADER_ONLY, 700)).toBe('empty');
		expect((await held(fakeHost())).afterCapture(HEADER_ONLY, 699)).toBe('short');
	});

	it('clears a release armed moments earlier', async () => {
		// Order at the call site: `cleanupRecording()` arms the idle release
		// BEFORE the blob is weighed. If the empty branch only stopped the tracks,
		// that timer would survive and fire against a dead session.
		const f = fakeHost();
		const s = await held(f);
		s.scheduleRelease();
		expect(f.armed()).toBe(1);
		s.afterCapture(HEADER_ONLY, LONG);
		expect(f.armed()).toBe(0);
	});

	it('recovers on the very next attempt, without waiting out the idle window', async () => {
		const f = fakeHost();
		const s = await held(f);
		const wedged = f.acquired[0];
		s.afterCapture(HEADER_ONLY, LONG);
		const next = await s.ensure();
		expect(next).not.toBe(wedged as unknown as MicStream);
		expect(f.acquired).toHaveLength(2);
	});

	it('the old behaviour would NOT have recovered — the retry cancels the release', async () => {
		// Written out so the branch above has something to be different from.
		// Three impatient retries, the same session each time, the escape hatch
		// pushed further away on every one.
		const f = fakeHost();
		const s = await held(f);
		const wedged = await s.ensure();
		for (let attempt = 0; attempt < 3; attempt++) {
			s.scheduleRelease();
			expect(f.armed()).toBe(1);
			expect(await s.ensure()).toBe(wedged);
			expect(f.armed()).toBe(0);
		}
		expect(f.acquired).toHaveLength(1);
	});
});

/**
 * ChatView wiring, pinned WHOLE rather than searched.
 *
 * Every token-matching guard written for this file was defeated in review: a
 * trailing `// …` comment revived the old code path while the regex matched
 * inside the comment, `if (false && …)` left the pattern intact, deleting the
 * early `return;` was invisible because only the condition was checked, and an
 * alias (`const weigh = micSession.afterCapture`) kept the occurrence count at
 * one. A deny-list over someone else's prose is open; a full comparison of a
 * small, rarely-changed block is closed.
 *
 * If one of these fails, read the diff and decide. That friction is the point.
 */
describe('ChatView is pinned to the session, block by block', () => {
	const RAW = readFileSync(
		fileURLToPath(new URL('../components/ChatView.svelte', import.meta.url)), 'utf-8',
	);

	const normalise = (src: string): string =>
		src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
			.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');

	const block = (from: string, to: string): string => {
		const i = RAW.indexOf(from);
		expect(i, `block start not found: ${from}`).toBeGreaterThan(-1);
		const j = RAW.indexOf(to, i);
		expect(j, `block end not found: ${to}`).toBeGreaterThan(-1);
		return normalise(RAW.slice(i, j + to.length));
	};

	it('read the whole file, not a prefix of it', () => {
		// `has source to scan` passed against a 26%-truncated file in review,
		// hiding a reintroduced regression past the cut. Anchor on both ends.
		expect(RAW.length).toBeGreaterThan(100_000);
		expect(RAW).toContain('<script lang="ts">');
		expect(RAW.trimEnd().endsWith('</style>') || RAW.trimEnd().endsWith('}')).toBe(true);
	});

	it('builds the session with the real browser and the real breadcrumb', () => {
		expect(block(
			'const micSession = createMicSession<MediaStream>({',
			'const releaseMicNow = (): void => micSession.releaseNow();',
		)).toBe([
			'const micSession = createMicSession<MediaStream>({',
			'acquire: () => navigator.mediaDevices.getUserMedia({ audio: true }),',
			'setTimer: (fn, ms) => setTimeout(fn, ms),',
			'clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),',
			'onRecycle: (bytes, durationMs) => {',
			"console.warn('[voice] capture had no audio, dropped the mic session', { bytes, durationMs });",
			'},',
			'}, MIC_IDLE_RELEASE_MS);',
			'const ensureMicStream = (): Promise<MediaStream> => micSession.ensure();',
			'const scheduleMicRelease = (): void => micSession.scheduleRelease();',
			'const releaseMicNow = (): void => micSession.releaseNow();',
		].join('\n'));
	});

	it('weighs every finished recording and acts on the verdict', () => {
		expect(block('let startedAt = 0;', '\t\t\t\t}\n\n\t\t\t\t// Lock the composer')).toBe([
			'let startedAt = 0;',
			'recorder.onstop = async () => {',
			'const durationMs = startedAt === 0 ? 0 : Date.now() - startedAt;',
			'cleanupRecording();',
			'const blob = new Blob(chunks, { type: actualMime });',
			'const verdict = micSession.afterCapture(blob.size, durationMs);',
			"if (verdict !== 'captured') {",
			"if (verdict === 'short') addToast(t('chat.voice_too_short'), 'error');",
			"if (verdict === 'empty') addToast(t('chat.voice_empty_capture'), 'error');",
			'return;',
			'}',
		].join('\n'));
	});

	it('still hands the mic back after an ordinary recording', () => {
		// Deleting `scheduleMicRelease()` here leaves the OS recording indicator
		// on for the rest of the session, and no behavioural test can see it.
		expect(block('function cleanupRecording() {', '\t}\n')).toBe([
			'function cleanupRecording() {',
			'recording = false;',
			'recordingSeconds = 0;',
			'if (recordingTimer) { clearInterval(recordingTimer); recordingTimer = null; }',
			'mediaRecorder = null;',
			'scheduleMicRelease();',
			'}',
		].join('\n'));
	});
});

describe('the copy says what happens, in both languages', () => {
	const I18N = readFileSync(
		fileURLToPath(new URL('../i18n.svelte.ts', import.meta.url)), 'utf-8',
	);
	const line = (key: string): string =>
		I18N.split('\n').find((l) => l.includes(`'${key}'`)) ?? '';

	it('read the whole table, not a prefix of it', () => {
		expect(I18N.length).toBeGreaterThan(100_000);
		expect(I18N).toContain('export function getLocale');
	});

	for (const key of ['chat.voice_too_short', 'chat.voice_empty_capture']) {
		it(`${key} carries both languages`, () => {
			expect(line(key)).toMatch(/de:\s*'[^']{20,}'/);
			expect(line(key)).toMatch(/en:\s*'[^']{20,}'/);
		});
	}

	it('never instructs a gesture the button does not support', () => {
		// The button has been tap-to-toggle since the same commit that wrote the
		// old "hold the mic button" text. Matched on the VERB in either language,
		// not on the one phrasing that happened to ship, because a rename walked
		// straight past the string-equality version of this guard in review.
		const voiceLines = I18N.split('\n').filter((l) => /'chat\.voice_/.test(l));
		expect(voiceLines.length).toBeGreaterThan(1);
		for (const l of voiceLines) {
			expect(l, l.trim()).not.toMatch(/gedrückt|gedrueckt|halte[ns]?\b/i);
			expect(l, l.trim()).not.toMatch(/\bhold(ing)?\b|press and hold/i);
		}
	});

	it('does not promise a repair it has not performed', () => {
		// The session is dropped when this shows; the NEXT tap re-acquires. Saying
		// "the microphone has been restarted" is a claim about something that has
		// not happened yet, and the evidence says re-acquiring may not help at all.
		expect(line('chat.voice_empty_capture')).not.toMatch(/neu gestartet|restarted|zurückgesetzt|has been reset/i);
	});
});
