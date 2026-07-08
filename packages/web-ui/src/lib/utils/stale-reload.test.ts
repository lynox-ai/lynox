import { afterEach, describe, expect, it } from 'vitest';
import {
	isChunkLoadError,
	RELOAD_LOOP_WINDOW_MS,
	shouldAttemptReload,
	STALE_RELOAD_ATTEMPT_KEY,
	triggerStaleReload,
} from './stale-reload.js';

const ORIGINAL_WINDOW = (globalThis as { window?: unknown }).window;

interface FakeWindow {
	__lynoxStaleReloadFired?: boolean;
	location: { href: string; replace: (u: string) => void; reload: () => void };
	sessionStorage: { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void };
}

function installWindow(opts?: {
	fired?: boolean;
	storage?: Record<string, string>;
	storageThrows?: boolean;
	href?: string;
}): { replaced: string[]; store: Record<string, string> } {
	const store = opts?.storage ?? {};
	const replaced: string[] = [];
	const w: FakeWindow = {
		location: {
			href: opts?.href ?? 'https://app.lynox.cloud/app?x=1',
			replace: (u) => replaced.push(u),
			reload: () => replaced.push('RELOAD'),
		},
		sessionStorage: {
			getItem: (k) => {
				if (opts?.storageThrows) throw new Error('denied');
				return k in store ? (store[k] as string) : null;
			},
			setItem: (k, v) => {
				if (opts?.storageThrows) throw new Error('denied');
				store[k] = v;
			},
		},
	};
	if (opts?.fired) w.__lynoxStaleReloadFired = true;
	(globalThis as { window?: unknown }).window = w;
	return { replaced, store };
}

afterEach(() => {
	(globalThis as { window?: unknown }).window = ORIGINAL_WINDOW;
});

describe('isChunkLoadError', () => {
	it('matches the three dynamic-import failure signatures (Error, string, error-like)', () => {
		expect(isChunkLoadError(new Error('Failed to fetch dynamically imported module: https://x/chunk.js'))).toBe(true);
		expect(isChunkLoadError('error loading dynamically imported module')).toBe(true);
		expect(isChunkLoadError({ message: 'Importing a module script failed.' })).toBe(true);
	});

	it('is case-insensitive', () => {
		expect(isChunkLoadError(new Error('FAILED TO FETCH DYNAMICALLY IMPORTED MODULE'))).toBe(true);
	});

	it('does NOT match a genuine diagram-syntax / logic error', () => {
		expect(isChunkLoadError(new Error('Parse error on line 3: expected SEMI'))).toBe(false);
		expect(isChunkLoadError('No diagram type detected matching given configuration')).toBe(false);
	});

	it('returns false for nullish / non-error-like values', () => {
		expect(isChunkLoadError(null)).toBe(false);
		expect(isChunkLoadError(undefined)).toBe(false);
		expect(isChunkLoadError(42)).toBe(false);
		expect(isChunkLoadError({})).toBe(false);
	});
});

describe('shouldAttemptReload', () => {
	it('allows a reload when none was ever attempted', () => {
		expect(shouldAttemptReload(1_000_000, null)).toBe(true);
	});

	it('allows a reload when the stored value is unparseable (NaN)', () => {
		expect(shouldAttemptReload(1_000_000, Number.NaN)).toBe(true);
	});

	it('blocks a reload inside the loop window (tight re-fire = genuine loop)', () => {
		const now = 1_000_000;
		expect(shouldAttemptReload(now, now - (RELOAD_LOOP_WINDOW_MS - 1))).toBe(false);
	});

	it('allows a reload once the window has elapsed (later deploy)', () => {
		const now = 1_000_000;
		expect(shouldAttemptReload(now, now - RELOAD_LOOP_WINDOW_MS)).toBe(true);
		expect(shouldAttemptReload(now, now - (RELOAD_LOOP_WINDOW_MS + 5_000))).toBe(true);
	});
});

describe('triggerStaleReload', () => {
	it('no-ops during SSR (window undefined)', () => {
		(globalThis as { window?: unknown }).window = undefined;
		expect(() => triggerStaleReload()).not.toThrow();
	});

	it('cache-busts via location.replace and records the attempt', () => {
		const { replaced, store } = installWindow();
		triggerStaleReload();
		expect(replaced).toHaveLength(1);
		expect(replaced[0]).toMatch(/[?&]_v=\d+/);
		// existing query params preserved
		expect(replaced[0]).toContain('x=1');
		expect(store[STALE_RELOAD_ATTEMPT_KEY]).toBeDefined();
		expect((globalThis as { window?: FakeWindow }).window?.__lynoxStaleReloadFired).toBe(true);
	});

	it('respects the per-load __lynoxStaleReloadFired flag (no double-fire)', () => {
		const { replaced } = installWindow({ fired: true });
		triggerStaleReload();
		expect(replaced).toHaveLength(0);
	});

	it('does not reload when a recent attempt is in sessionStorage (loop guard)', () => {
		const { replaced } = installWindow({
			storage: { [STALE_RELOAD_ATTEMPT_KEY]: String(Date.now()) },
		});
		triggerStaleReload();
		expect(replaced).toHaveLength(0);
	});

	it('reloads when the stored attempt is older than the window', () => {
		const { replaced } = installWindow({
			storage: { [STALE_RELOAD_ATTEMPT_KEY]: String(Date.now() - (RELOAD_LOOP_WINDOW_MS + 60_000)) },
		});
		triggerStaleReload();
		expect(replaced).toHaveLength(1);
	});

	it('still reloads when sessionStorage is unavailable (private mode)', () => {
		const { replaced } = installWindow({ storageThrows: true });
		triggerStaleReload();
		expect(replaced).toHaveLength(1);
		expect(replaced[0]).toMatch(/[?&]_v=\d+/);
	});
});
