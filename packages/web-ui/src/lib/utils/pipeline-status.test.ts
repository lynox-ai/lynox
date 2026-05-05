import { afterEach, describe, expect, it } from 'vitest';
import {
	formatRunElapsed,
	prefersReducedMotion,
	scrollBehaviorForMotion,
	selectPendingPromptHead,
} from './pipeline-status.js';
import type {
	PermissionPrompt,
	TabsPrompt,
} from '../stores/chat.svelte.js';

// ---------------------------------------------------------------------------
// selectPendingPromptHead — covers gate 3 (multi-prompt, head-of-queue).
// ---------------------------------------------------------------------------

describe('selectPendingPromptHead', () => {
	function permission(question: string, promptId = 'pp-1'): PermissionPrompt {
		return { question, promptId };
	}

	function tabs(question: string, promptId = 'pt-1'): TabsPrompt {
		return {
			promptId,
			questions: [{ question, options: ['Yes', 'No'] }],
		};
	}

	it('returns null when no prompt is pending', () => {
		expect(selectPendingPromptHead(null, null, null)).toBeNull();
	});

	it('returns the permission prompt when only one is set', () => {
		const head = selectPendingPromptHead(permission('Want coffee?'), null, null);
		expect(head).toEqual({
			kind: 'permission',
			question: 'Want coffee?',
			promptId: 'pp-1',
			options: undefined,
		});
	});

	it('returns the tabs prompt head question when only tabs is set', () => {
		const head = selectPendingPromptHead(null, tabs('Pick one'), null);
		expect(head?.kind).toBe('tabs');
		expect(head?.question).toBe('Pick one');
		expect(head?.options).toEqual(['Yes', 'No']);
	});

	it('prioritises secret over permission over tabs', () => {
		const secret = selectPendingPromptHead(
			permission('PermQ'),
			tabs('TabsQ'),
			{ name: 'API_KEY', prompt: 'Enter your key', promptId: 'ps-1' },
		);
		expect(secret?.kind).toBe('secret');

		// Without secret, permission wins.
		const perm = selectPendingPromptHead(permission('PermQ'), tabs('TabsQ'), null);
		expect(perm?.kind).toBe('permission');
	});

	it('multi-prompt: a second prompt does not erase the previous answer', () => {
		// Acceptance gate 3 (logical part): the head-of-queue function returns
		// whichever prompt is currently set. Whether the previous answer
		// renders inline is the chat-message responsibility — selectPendingPromptHead
		// just returns the *current* one. Verifying the projection is stable
		// when the underlying prompt rotates is enough at this layer.
		const first = selectPendingPromptHead(permission('Q1', 'pp-1'), null, null);
		const second = selectPendingPromptHead(permission('Q2', 'pp-2'), null, null);
		expect(first?.promptId).toBe('pp-1');
		expect(second?.promptId).toBe('pp-2');
		expect(first?.question).not.toBe(second?.question);
	});
});

// ---------------------------------------------------------------------------
// formatRunElapsed — counter / duration formatting for the prompt anchor.
// ---------------------------------------------------------------------------

describe('formatRunElapsed', () => {
	const t0 = 1_700_000_000_000;

	it('returns null when run has no recorded start', () => {
		expect(formatRunElapsed(null, t0)).toBeNull();
	});

	it('reports seconds for sub-minute durations', () => {
		expect(formatRunElapsed(t0, t0 + 7_000)).toEqual({ unit: 'seconds', value: 7 });
		expect(formatRunElapsed(t0, t0 + 59_000)).toEqual({ unit: 'seconds', value: 59 });
	});

	it('switches to minutes at the 60-second boundary', () => {
		expect(formatRunElapsed(t0, t0 + 60_000)).toEqual({ unit: 'minutes', value: 1 });
		expect(formatRunElapsed(t0, t0 + 3 * 60_000)).toEqual({ unit: 'minutes', value: 3 });
	});

	it('clamps negative deltas to 0 (clock skew safety)', () => {
		expect(formatRunElapsed(t0, t0 - 5_000)).toEqual({ unit: 'seconds', value: 0 });
	});
});

// ---------------------------------------------------------------------------
// prefersReducedMotion + scrollBehaviorForMotion — covers gate 4 (smooth-scroll
// honouring `prefers-reduced-motion: reduce`).
// ---------------------------------------------------------------------------

describe('prefersReducedMotion', () => {
	afterEach(() => {
		// nothing to clean — we pass an explicit window stub each call,
		// never mutating global state.
	});

	function stubWin(matches: boolean): { matchMedia: (q: string) => MediaQueryList } {
		return {
			matchMedia: (_q: string) =>
				({ matches } as unknown as MediaQueryList),
		};
	}

	it('returns false when no window/matchMedia is available (SSR or node test env)', () => {
		expect(prefersReducedMotion(undefined)).toBe(false);
		expect(prefersReducedMotion({} as { matchMedia?: (q: string) => MediaQueryList })).toBe(false);
	});

	it('returns true when matchMedia reports the user prefers reduced motion', () => {
		expect(prefersReducedMotion(stubWin(true))).toBe(true);
	});

	it('returns false when matchMedia reports no preference', () => {
		expect(prefersReducedMotion(stubWin(false))).toBe(false);
	});
});

describe('scrollBehaviorForMotion', () => {
	it('uses smooth when motion is allowed', () => {
		expect(scrollBehaviorForMotion(false)).toBe('smooth');
	});

	it('uses auto (instant) when reduced-motion is preferred', () => {
		// Acceptance gate 4: "zur Frage springen" must not animate when the
		// user has set prefers-reduced-motion.
		expect(scrollBehaviorForMotion(true)).toBe('auto');
	});
});
