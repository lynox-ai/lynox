<script lang="ts">
	import { t } from '../i18n.svelte.js';
	import type { PendingPromptHead } from '../stores/chat.svelte.js';
	import { formatRunElapsed, prefersReducedMotion, scrollBehaviorForMotion } from '../utils/pipeline-status.js';

	interface Props {
		prompt: PendingPromptHead;
		/** Total prompts the active run has fired. >1 → counter is shown. */
		promptCount: number;
		/** Epoch ms when the active run started. Used for the "Run läuft seit X" hint. */
		runStartedAt: number | null;
	}

	let { prompt, promptCount, runStartedAt }: Props = $props();

	// Tick for elapsed-time display. Every 30s matches the user-facing
	// precision (seconds → minutes). Cleared on unmount.
	let now = $state(Date.now());
	$effect(() => {
		const id = setInterval(() => { now = Date.now(); }, 30_000);
		return () => clearInterval(id);
	});

	const elapsedRaw = $derived(formatRunElapsed(runStartedAt, now));
	const elapsed = $derived(
		elapsedRaw === null
			? null
			: elapsedRaw.unit === 'seconds'
				? t('prompt_anchor.duration_seconds').replace('{n}', String(elapsedRaw.value))
				: t('prompt_anchor.duration_minutes').replace('{n}', String(elapsedRaw.value)),
	);
	const showCounter = $derived(promptCount > 1);
	const counterLabel = $derived(t('prompt_anchor.question_n').replace('{n}', String(promptCount)));
	const runForLabel = $derived(elapsed ? t('prompt_anchor.run_for').replace('{duration}', elapsed) : null);

	function expandInlinePrompt(): void {
		if (typeof document === 'undefined') return;
		const el = document.querySelector<HTMLElement>('[data-pending-prompt]');
		if (!el) return;
		el.scrollIntoView({ behavior: scrollBehaviorForMotion(prefersReducedMotion()), block: 'center' });
		el.focus({ preventScroll: true });
	}
</script>

<div
	class="prompt-anchor border-t border-accent/30 bg-accent/5 px-4 py-2"
	role="region"
	aria-label={t('prompt_anchor.aria_label')}
>
	<div class="max-w-3xl mx-auto flex items-center gap-2 min-w-0">
		<span aria-hidden="true" class="flex-shrink-0">💬</span>
		<span class="text-xs md:text-sm text-text font-medium truncate min-w-0">{prompt.question}</span>

		{#if showCounter || runForLabel}
			<span class="hidden md:inline text-text-subtle flex-shrink-0" aria-hidden="true">·</span>
			<span class="hidden md:inline text-[11px] text-text-subtle font-mono flex-shrink-0 tabular-nums">
				{#if showCounter}{counterLabel}{/if}{#if showCounter && runForLabel} · {/if}{#if runForLabel}{runForLabel}{/if}
			</span>
		{/if}

		<button
			type="button"
			onclick={expandInlinePrompt}
			class="ml-auto flex-shrink-0 rounded-[var(--radius-sm)] bg-accent px-3 py-1 text-xs text-text hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-accent/40"
		>{t('prompt_anchor.answer')}</button>
	</div>
</div>
