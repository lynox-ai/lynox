// === Touch-primary detection ===
//
// True when the device's primary input is touch (phone, most tablets in
// no-keyboard mode). Used to suppress UI affordances that only make
// sense with a physical keyboard — e.g. the inbox keyboard-shortcuts
// help overlay.
//
// matchMedia(`(hover: none) and (pointer: coarse)`) is the modern
// portable check; an iPad with an attached Bluetooth keyboard still
// reports `hover: hover`, which correctly opts back into the
// keyboard-driven affordances.

let cached: boolean | null = null;

export function isTouchPrimary(): boolean {
	if (cached !== null) return cached;
	if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
		cached = false;
		return false;
	}
	try {
		cached = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
	} catch {
		cached = false;
	}
	return cached;
}

/** Reset the memoised result. Test-only. */
export function __resetTouchPrimaryCache(): void {
	cached = null;
}
