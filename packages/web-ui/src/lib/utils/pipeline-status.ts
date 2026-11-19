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
	MailConnectPromptView,
} from '../stores/chat.svelte.js';
import type { PromptOrigin } from './prompt-origin.js';

/**
 * Collapse the legacy pendingX vars into the unified head shape the
 * PromptAnchor renders. Priority: mail > secret > permission > tabs. Mail and
 * secret take precedence because both collect credentials — blocking them with
 * a permission UI would risk leaking the credential-prompt context.
 */
export function selectPendingPromptHead(
	pendingPermission: PermissionPrompt | null,
	pendingTabsPrompt: TabsPrompt | null,
	pendingSecretPrompt:
		| { name: string; prompt: string; keyType?: string; promptId?: string; origin?: PromptOrigin }
		| null,
	pendingMailConnect?: MailConnectPromptView | null,
): PendingPromptHead | null {
	if (pendingMailConnect) {
		return {
			kind: 'mail',
			question: pendingMailConnect.address,
			promptId: pendingMailConnect.promptId,
			origin: pendingMailConnect.origin,
		};
	}
	if (pendingSecretPrompt) {
		return {
			kind: 'secret',
			question: pendingSecretPrompt.prompt,
			promptId: pendingSecretPrompt.promptId,
			origin: pendingSecretPrompt.origin,
		};
	}
	if (pendingPermission) {
		return {
			kind: 'permission',
			question: pendingPermission.question,
			promptId: pendingPermission.promptId,
			options: pendingPermission.options,
			origin: pendingPermission.origin,
		};
	}
	if (pendingTabsPrompt) {
		const head = pendingTabsPrompt.questions[0];
		return {
			kind: 'tabs',
			question: head?.question ?? '',
			promptId: pendingTabsPrompt.promptId,
			options: head?.options,
			origin: pendingTabsPrompt.origin,
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
 * True when a pipeline still has a step pending or running.
 *
 * Defensive against malformed PERSISTED shapes: a pre-1.18 workflow thread
 * restored from localStorage can carry a `pipeline` whose `steps` is missing
 * or not an array (its shape predates the current `PipelineInfo`). Calling
 * `.some()` on a non-array there throws inside the `pipelineRunning` $derived
 * and takes the whole ChatView render down — the "can't open an old workflow
 * thread" crash. We guard the array before iterating, and tolerate a
 * null/garbage step entry, so an old shape simply reads as "not running"
 * instead of crashing. The param is intentionally loose (not `PipelineInfo`)
 * because the danger is exactly the data that violates that type at runtime.
 */
export function isPipelineRunning(
	pipeline: { steps?: ReadonlyArray<{ status?: string } | null> } | null | undefined,
): boolean {
	if (!pipeline || !Array.isArray(pipeline.steps)) return false;
	return pipeline.steps.some((s) => s?.status === 'pending' || s?.status === 'running');
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

/**
 * How much of the inline question must be on screen for it to count as seen: its first line or so
 * (the question text sits at the top of the card), or the whole card when it is smaller than that.
 */
export const PROMPT_FORM_SEEN_PX = 48;

/** What the anchor bar needs to know about the inline question it points to. */
export type PromptFormSight =
	/** No observer in this browser: the bar cannot know, so it shows, as it always did. */
	| { kind: 'unobservable' }
	/** The question's form is not in the page (yet): nothing to point to beside the bar itself. */
	| { kind: 'absent' }
	/** Observed, the browser has not reported yet (it does within a frame of observing). */
	| { kind: 'pending' }
	/** The last report: on screen or not. */
	| { kind: 'seen'; inView: boolean };

/**
 * Whether the question counts as on screen, from one IntersectionObserver entry: enough of it shows
 * to read its first line. A sliver of the card's bottom edge does not count — the question text is
 * at its top, so the user would see the buttons and not what they answer.
 */
export function promptFormInView(entry: { isIntersecting: boolean; intersectionRect: { height: number }; boundingClientRect: { height: number } }): boolean {
	if (!entry.isIntersecting) return false;
	return entry.intersectionRect.height >= Math.min(PROMPT_FORM_SEEN_PX, entry.boundingClientRect.height);
}

/**
 * Whether the anchor bar shows. It is a locator for a question that is off screen; while the question
 * is on screen the bar would only say the same text a second time. Where the bar cannot know (no
 * observer, no form found), it shows — a question nobody finds is worse than one shown twice.
 */
export function promptAnchorShown(sight: PromptFormSight): boolean {
	switch (sight.kind) {
		case 'unobservable':
		case 'absent':
			return true;
		case 'pending':
			return false;
		case 'seen':
			return !sight.inView;
	}
}
