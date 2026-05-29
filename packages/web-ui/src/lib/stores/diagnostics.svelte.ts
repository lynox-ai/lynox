/**
 * Diagnostics mode — persistent per-browser preference.
 *
 * Default OFF. When enabled, ChatView shows an expandable per-message detail
 * row (token breakdown, stop_reason, iterations, TTFB, duration, tok/s, run id)
 * under the baseline footer. A viewing preference, so it lives in localStorage
 * like the voice toggles — not in the engine vault. Demo tenants force it off
 * at the render site (`!getDemoMode()`), so the public playground never exposes
 * the panel regardless of this flag.
 */

const STORAGE_KEY = 'lynox_diagnostics_enabled';

function readInitial(): boolean {
	try {
		return typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY) === '1';
	} catch { return false; }
}

let enabled = $state<boolean>(readInitial());

export function isDiagnosticsEnabled(): boolean {
	return enabled;
}

export function toggleDiagnostics(): void {
	setDiagnostics(!enabled);
}

export function setDiagnostics(value: boolean): void {
	enabled = value;
	try {
		if (typeof localStorage === 'undefined') return;
		if (enabled) localStorage.setItem(STORAGE_KEY, '1');
		else localStorage.removeItem(STORAGE_KEY);
	} catch { /* private mode — state lives in memory only */ }
}
