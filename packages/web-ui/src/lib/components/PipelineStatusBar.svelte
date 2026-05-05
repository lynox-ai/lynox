<script lang="ts">
	import { t } from '../i18n.svelte.js';
	import type { ActiveRun, PromptKind } from '../stores/chat.svelte.js';
	import { findPromptFormByKind, prefersReducedMotion, scrollBehaviorForMotion } from '../utils/pipeline-status.js';

	interface Props {
		run: ActiveRun;
		waitingOnUser: boolean;
		/** Kind of the active head-of-queue prompt, used to route the
		 *  "zur Frage springen" jump to the correct inline form when permission
		 *  and secret prompts coexist. null when no prompt is pending. */
		pendingPromptKind?: PromptKind | null;
	}

	let { run, waitingOnUser, pendingPromptKind = null }: Props = $props();

	const currentStep = $derived(run.steps[run.currentStepIdx]);
	const stepLabel = $derived(t('pipeline.status_step')
		.replace('{n}', String(run.currentStepIdx + 1))
		.replace('{total}', String(run.totalSteps)));
	const stepTitle = $derived(currentStep?.task ?? currentStep?.id ?? '');
	const pipelineName = $derived(run.name || t('pipeline.untitled'));

	function jumpToPrompt(): void {
		if (typeof document === 'undefined') return;
		const el = findPromptFormByKind(document, pendingPromptKind);
		if (!el) return;
		el.scrollIntoView({ behavior: scrollBehaviorForMotion(prefersReducedMotion()), block: 'center' });
		el.focus({ preventScroll: true });
	}
</script>

<div
	class="pipeline-status-bar sticky top-0 z-20 border-b border-border bg-bg-subtle/95 backdrop-blur supports-[backdrop-filter]:bg-bg-subtle/80"
	role="status"
	aria-live="polite"
>
	<div class="max-w-3xl mx-auto px-4 py-2 md:py-2.5 flex flex-col gap-1 md:gap-1.5">
		<!-- Line 1: pipeline name + current step -->
		<div class="flex items-center gap-2 text-xs md:text-sm min-w-0">
			<span aria-hidden="true" class="flex-shrink-0">🔄</span>
			<span class="font-medium text-text truncate">{pipelineName}</span>
			<span aria-hidden="true" class="text-text-subtle flex-shrink-0">·</span>
			<span class="text-text-muted tabular-nums flex-shrink-0">{stepLabel}</span>
			{#if stepTitle}
				<span aria-hidden="true" class="text-text-subtle hidden md:inline flex-shrink-0">·</span>
				<span class="text-text-muted truncate hidden md:inline">{stepTitle}</span>
			{/if}
		</div>

		<!-- Line 2: waiting-on-user banner with jump link. Only renders when
		     a prompt is pending. On mobile the whole bar collapses to a
		     single line — line 1 is the running step, line 2 is the wait
		     banner; the step title is hidden on mobile to keep height bounded. -->
		{#if waitingOnUser}
			<div class="flex items-center gap-2 text-xs md:text-sm">
				<span aria-hidden="true" class="flex-shrink-0">🤚</span>
				<span class="text-accent-text font-medium truncate">{t('pipeline.waiting_on_user')}</span>
				<button
					type="button"
					onclick={jumpToPrompt}
					class="ml-auto flex-shrink-0 underline underline-offset-2 text-accent-text hover:opacity-80 focus:outline-none focus:ring-2 focus:ring-accent/40 rounded-sm px-1"
				>{t('pipeline.jump_to_question')}</button>
			</div>
		{/if}
	</div>
</div>
