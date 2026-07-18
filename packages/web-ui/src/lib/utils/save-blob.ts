import { isIosSafari } from './ios-safari.js';

// Save a blob as a file — mobile-aware.
//
// On MOBILE the native share sheet is the right "get it out" UX: iOS Safari
// IGNORES `<a download>` and blocks a programmatic `blob:` click, so the anchor
// download does NOTHING there (the "download button doesn't work" report); and
// on Android the share sheet ("Save to Drive", "Download", send to apps) is the
// natural, richer target. So on iOS + Android use the Web Share API. On DESKTOP
// keep the direct download, where it works and a share dialog would surprise.
//
// A share the user cancels (AbortError) is a no-op — we must NOT then also
// download, or a cancel would surprise-save the file. Any OTHER share failure
// (or a platform without Web Share, e.g. an older Android) falls back to the
// direct download so the button never dead-ends.

/** Platforms where the native share sheet is the right target (iOS + Android). */
function prefersShareSheet(): boolean {
	if (isIosSafari()) return true;
	return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
}

/** True when the platform can share these files via the Web Share API. Requires
 *  BOTH `canShare` (feature-detect) and `share` (the actual call) to exist. */
function canShareFiles(files: File[]): boolean {
	return typeof navigator !== 'undefined'
		&& typeof navigator.share === 'function'
		&& typeof navigator.canShare === 'function'
		&& navigator.canShare({ files });
}

export async function saveOrShareBlob(blob: Blob, filename: string): Promise<void> {
	const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
	if (prefersShareSheet() && canShareFiles([file])) {
		try {
			await navigator.share({ files: [file] });
			return;
		} catch (e) {
			// User dismissed the share sheet → do nothing (do NOT fall through to a
			// download, which would save a file they just cancelled). `instanceof
			// Error` guards a non-object reject; DOMException extends Error so the
			// real AbortError is caught.
			if (e instanceof Error && e.name === 'AbortError') return;
			// Any other failure → fall through to the direct download below.
		}
	}
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}
