/**
 * Detect iOS Safari (Mobile Safari + the standalone PWA shell), excluding
 * other iOS browsers that wrap WKWebView with their own audio session
 * configuration (Chrome, Firefox, Edge, Opera, Yandex, Google Search App).
 *
 * Used to gate two iOS-WebKit-specific workarounds:
 *   - speak.svelte.ts: TTS via `<video playsinline>` instead of Web Audio,
 *     because Safari's default AVAudioSessionCategoryAmbient mutes both
 *     `<audio>` and AudioContext output.
 *   - ChatView.svelte: skip the MediaStream → AudioContext → Analyser path
 *     for the recording waveform, because attaching the analyser corrupts
 *     MediaRecorder output on the third-and-later sessions per page.
 *
 * Both patches are confirmed effective on iOS 18.7 Safari (2026-05-06).
 */
export function isIosSafari(): boolean {
	if (typeof navigator === 'undefined') return false;
	const ua = navigator.userAgent;
	if (!/iPhone|iPad|iPod/.test(ua)) return false;
	if (/CriOS|FxiOS|EdgiOS|OPiOS|YaBrowser|GSA/.test(ua)) return false;
	return true;
}
