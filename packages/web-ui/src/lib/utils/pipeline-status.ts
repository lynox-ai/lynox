/**
 * Pure helpers for the pipeline-status-v2 layers (PRD pro #93).
 *
 * Kept as plain TS so they can be unit-tested without a Svelte runtime —
 * the .svelte.ts store is a thin wrapper around these.
 */

import type {
	PendingPromptHead,
	PermissionPrompt,
	PromptKind,
	TabsPrompt,
} from '../stores/chat.svelte.js';

/**
 * Collapse the three legacy pendingX vars into the unified head shape the
 * PromptAnchor renders. Priority: secret > permission > tabs. Secret takes
 * precedence because if it surfaces, blocking the question with a permission
 * UI would risk leaking the secret-prompt context.
 */
export function selectPendingPromptHead(
	pendingPermission: PermissionPrompt | null,
	pendingTabsPrompt: TabsPrompt | null,
	pendingSecretPrompt:
		| { name: string; prompt: string; keyType?: string; promptId?: string }
		| null,
): PendingPromptHead | null {
	if (pendingSecretPrompt) {
		return {
			kind: 'secret',
			question: pendingSecretPrompt.prompt,
			promptId: pendingSecretPrompt.promptId,
		};
	}
	if (pendingPermission) {
		return {
			kind: 'permission',
			question: pendingPermission.question,
			promptId: pendingPermission.promptId,
			options: pendingPermission.options,
		};
	}
	if (pendingTabsPrompt) {
		const head = pendingTabsPrompt.questions[0];
		return {
			kind: 'tabs',
			question: head?.question ?? '',
			promptId: pendingTabsPrompt.promptId,
			options: head?.options,
		};
	}
	return null;
}

/**
 * Render the run-duration text for the prompt anchor. Returns null when
 * the run has no recorded start. Sub-minute → seconds, else minutes.
 *
 * The localized prefix ("Run läuft seit …") is composed in the component;
 * this helper is locale-free so tests stay deterministic.
 */
export function formatRunElapsed(
	startedAt: number | null,
	nowMs: number,
): { unit: 'seconds' | 'minutes'; value: number } | null {
	if (startedAt === null) return null;
	const seconds = Math.max(0, Math.floor((nowMs - startedAt) / 1000));
	if (seconds < 60) return { unit: 'seconds', value: seconds };
	return { unit: 'minutes', value: Math.floor(seconds / 60) };
}

/**
 * `prefers-reduced-motion` query — extracted so PromptAnchor's
 * scrollIntoView can be unit-tested without spinning up a real browser.
 */
export function prefersReducedMotion(win: { matchMedia?: (q: string) => MediaQueryList } | undefined = typeof window !== 'undefined' ? window : undefined): boolean {
	if (!win?.matchMedia) return false;
	return win.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** ScrollBehavior the components should use given the current motion preference. */
export function scrollBehaviorForMotion(reduced: boolean): ScrollBehavior {
	return reduced ? 'auto' : 'smooth';
}

/**
 * Resolve the inline prompt form to scroll to. Permission and secret prompts
 * can be visible simultaneously (independent SSE events / state vars), so
 * the bare `[data-pending-prompt]` first-match would race the kind that
 * `selectPendingPromptHead` prioritises (secret > permission > tabs).
 * PromptAnchor's [Antworten] jump uses this so the scroll target matches.
 */
export function findPromptFormByKind(
	doc: Document | undefined,
	kind: PromptKind | null,
): HTMLElement | null {
	if (!doc) return null;
	if (kind) {
		const el = doc.querySelector<HTMLElement>(`[data-pending-prompt][data-prompt-kind="${kind}"]`);
		if (el) return el;
	}
	return doc.querySelector<HTMLElement>('[data-pending-prompt]');
}
