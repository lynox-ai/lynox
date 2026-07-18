import { isIosSafari } from './ios-safari.js';

// Save a blob as a file, iOS-aware.
//
// iOS Safari IGNORES the `<a download>` attribute and blocks a programmatic
// click on a `blob:` URL, so the usual create-anchor-and-click download does
// NOTHING on iPhone (the "download button doesn't work" report). There, use the
// Web Share API — the share sheet offers "Save to Photos" / "Save to Files".
// On desktop keep the direct download, where it works and file-sharing usually
// isn't offered by the browser.
//
// A share the user cancels (AbortError) is a no-op — we must NOT then also
// download, or a cancel would surprise-save the file. Any OTHER share failure
// falls back to the download so the button never dead-ends.

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
	if (isIosSafari() && canShareFiles([file])) {
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
