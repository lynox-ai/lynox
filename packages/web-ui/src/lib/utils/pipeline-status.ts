/**
 * Pure helpers for the pipeline-status-v2 layers (PRD pro #93).
 *
 * Kept as plain TS so they can be unit-tested without a Svelte runtime —
 * the .svelte.ts store is a thin wrapper around these.
 */

import type {
	ChatMessage,
	PendingPromptHead,
	PermissionPrompt,
	PipelineStepInfo,
	TabsPrompt,
} from '../stores/chat.svelte.js';
import type { ActiveRun } from '../stores/chat.svelte.js';

/**
 * Walk messages from newest to oldest and return the latest run that hasn't
 * reached a terminal state (= some step is still pending or running).
 *
 * Returns null when no message owns a pipeline, or when the latest pipeline-
 * carrying message is fully done. The "newest first" walk is what makes the
 * status bar disappear at the terminal step rather than re-surfacing the
 * previous run.
 */
export function findActiveRun(messages: ChatMessage[]): ActiveRun | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const p = messages[i]?.pipeline;
		if (!p) continue;
		const stillRunning = p.steps.some(
			(s: PipelineStepInfo) => s.status === 'pending' || s.status === 'running',
		);
		if (!stillRunning) return null;
		let cur = p.steps.findIndex(
			(s: PipelineStepInfo) => s.status !== 'completed' && s.status !== 'skipped',
		);
		if (cur < 0) cur = Math.max(p.steps.length - 1, 0);
		return {
			pipelineId: p.pipelineId,
			name: p.name,
			steps: p.steps,
			currentStepIdx: cur,
			totalSteps: p.steps.length,
		};
	}
	return null;
}

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
 * `prefers-reduced-motion` query — extracted so jump-to-prompt can be
 * unit-tested without spinning up a real browser. Both PipelineStatusBar
 * and PromptAnchor route their scrollIntoView through this.
 */
export function prefersReducedMotion(win: { matchMedia?: (q: string) => MediaQueryList } | undefined = typeof window !== 'undefined' ? window : undefined): boolean {
	if (!win?.matchMedia) return false;
	return win.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** ScrollBehavior the components should use given the current motion preference. */
export function scrollBehaviorForMotion(reduced: boolean): ScrollBehavior {
	return reduced ? 'auto' : 'smooth';
}
