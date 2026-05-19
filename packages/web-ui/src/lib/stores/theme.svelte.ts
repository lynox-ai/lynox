/*
 * Theme store — 3-state preference ('system' | 'light' | 'dark').
 *
 * Pattern mirrors i18n.svelte.ts (module-level $state + getter/setter, no
 * $effect inside the store file). Init guard prevents double matchMedia
 * registration on HMR / library re-mount.
 *
 * The actual <html data-theme="..."> attribute is also set by an inline
 * script in app.html that runs before hydrate (FOUC guard). initTheme()
 * reconciles: if the stored value matches what the inline script set,
 * the apply() call is skipped (avoids a layout pass).
 *
 * Multi-tab sync: a 'storage' event listener mirrors lyx-theme changes
 * across tabs without a manual refresh.
 */

export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'lyx-theme';
const ATTR = 'data-theme';

let _mode = $state<ThemeMode>('system');
let _resolved = $state<ResolvedTheme>('dark');

let _mql: MediaQueryList | null = null;
let _mqlListener: ((e: MediaQueryListEvent) => void) | null = null;
let _storageListener: ((e: StorageEvent) => void) | null = null;
let _initialized = false;

function readSystem(): ResolvedTheme {
	if (typeof window === 'undefined') return 'dark';
	return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function compute(mode: ThemeMode): ResolvedTheme {
	return mode === 'system' ? readSystem() : mode;
}

function apply(resolved: ResolvedTheme): void {
	if (typeof document === 'undefined') return;
	document.documentElement.setAttribute(ATTR, resolved);
}

function refreshMqListener(): void {
	if (typeof window === 'undefined') return;
	if (_mql && _mqlListener) _mql.removeEventListener('change', _mqlListener);
	_mql = null;
	_mqlListener = null;
	if (_mode !== 'system') return;
	_mql = window.matchMedia('(prefers-color-scheme: light)');
	_mqlListener = (e) => {
		_resolved = e.matches ? 'light' : 'dark';
		apply(_resolved);
	};
	_mql.addEventListener('change', _mqlListener);
}

function attachStorageListener(): void {
	if (typeof window === 'undefined' || _storageListener) return;
	_storageListener = (e) => {
		if (e.key !== STORAGE_KEY) return;
		// Re-read state from storage (another tab changed it).
		let next: ThemeMode = 'system';
		if (e.newValue === 'light' || e.newValue === 'dark') next = e.newValue;
		if (next === _mode) return;
		_mode = next;
		_resolved = compute(next);
		apply(_resolved);
		refreshMqListener();
	};
	window.addEventListener('storage', _storageListener);
}

export function getThemeMode(): ThemeMode {
	return _mode;
}

export function getResolvedTheme(): ResolvedTheme {
	return _resolved;
}

export function setThemeMode(mode: ThemeMode): void {
	_mode = mode;
	_resolved = compute(mode);
	apply(_resolved);
	if (typeof localStorage !== 'undefined') {
		try {
			if (mode === 'system') localStorage.removeItem(STORAGE_KEY);
			else localStorage.setItem(STORAGE_KEY, mode);
		} catch {
			/* private mode / quota — runtime-only override */
		}
	}
	refreshMqListener();
}

export function initTheme(): void {
	if (_initialized) return;
	_initialized = true;
	if (typeof window === 'undefined') return;
	let stored: ThemeMode = 'system';
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw === 'light' || raw === 'dark') stored = raw;
	} catch {
		/* ignore */
	}
	_mode = stored;
	_resolved = compute(stored);
	const current = document.documentElement.getAttribute(ATTR);
	if (current !== _resolved) apply(_resolved);
	refreshMqListener();
	attachStorageListener();
}
