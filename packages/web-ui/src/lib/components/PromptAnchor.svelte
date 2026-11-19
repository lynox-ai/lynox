<script lang="ts">
	import { t } from '../i18n.svelte.js';
	import Icon from '../primitives/Icon.svelte';
	import type { PendingPromptHead } from '../stores/chat.svelte.js';
	import { findPromptFormByKind, formatRunElapsed, prefersReducedMotion, promptAnchorShown, promptFormInView, scrollBehaviorForMotion, type PromptFormSight } from '../utils/pipeline-status.js';

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

	// The bar points to a question that is off screen. While the question's form is on screen it shows
	// the question once, there; the bar would only repeat it. Watched with an IntersectionObserver on
	// the form (which clips by the chat's scroll area), and a MutationObserver that follows the form
	// when the next question replaces it.
	let sight = $state<PromptFormSight>({ kind: 'pending' });
	const shown = $derived(promptAnchorShown(sight));
	$effect(() => {
		const kind = prompt.kind;
		void prompt.promptId;
		if (typeof document === 'undefined' || typeof IntersectionObserver === 'undefined' || typeof MutationObserver === 'undefined') {
			sight = { kind: 'unobservable' };
			return;
		}
		// `undefined` = not looked yet, so the first look always settles `sight` (also when it finds nothing).
		let target: HTMLElement | null | undefined = undefined;
		const io = new IntersectionObserver((entries) => {
			const last = entries[entries.length - 1];
			if (last && last.target === target) sight = { kind: 'seen', inView: promptFormInView(last) };
		}, { threshold: [0, 0.25, 0.5, 0.75, 1] });
		const follow = (): void => {
			const el = findPromptFormByKind(document, kind);
			if (el === target) return;
			if (target) io.unobserve(target);
			target = el;
			if (el) { sight = { kind: 'pending' }; io.observe(el); } else sight = { kind: 'absent' };
		};
		follow();
		const mo = new MutationObserver(follow);
		mo.observe(document.body, { childList: true, subtree: true });
		return () => { mo.disconnect(); io.disconnect(); };
	});

	function expandInlinePrompt(): void {
		if (typeof document === 'undefined') return;
		const el = findPromptFormByKind(document, prompt.kind);
		if (!el) return;
		el.scrollIntoView({ behavior: scrollBehaviorForMotion(prefersReducedMotion()), block: 'center' });
		el.focus({ preventScroll: true });
	}
</script>

{#if shown}
<div
	class="prompt-anchor border-t border-accent/30 bg-accent/5 px-4 py-2"
	role="region"
	data-prompt-anchor
	aria-label={t('prompt_anchor.aria_label')}
>
	<div class="max-w-3xl mx-auto flex items-center gap-2 min-w-0">
		<Icon name="chat" size="xs" class="flex-shrink-0" />
		<span class="text-xs md:text-sm text-text font-medium truncate min-w-0">{prompt.question}</span>

		<!-- Who asked. This bar exists BECAUSE the dialog is off-screen, so it is
		     the surface where the user has the least context — the one place the
		     provenance must not be dropped for space. Only the workflow name
		     (the half a non-technical user recognises); the step id and task are
		     one tap away in the dialog this bar scrolls to. -->
		{#if prompt.origin?.workflowName}
			<span class="text-text-subtle flex-shrink-0" aria-hidden="true">·</span>
			<span class="text-[11px] text-text-subtle truncate min-w-0 max-w-[40%] flex-shrink">{prompt.origin.workflowName}</span>
		{/if}

		{#if showCounter || runForLabel}
			<span class="hidden md:inline text-text-subtle flex-shrink-0" aria-hidden="true">·</span>
			<span class="hidden md:inline text-[11px] text-text-subtle font-mono flex-shrink-0 tabular-nums">
				{#if showCounter}{counterLabel}{/if}{#if showCounter && runForLabel} · {/if}{#if runForLabel}{runForLabel}{/if}
			</span>
		{/if}

		<button
			type="button"
			onclick={expandInlinePrompt}
			class="ml-auto flex-shrink-0 rounded-[var(--radius-sm)] bg-accent px-3 py-1 text-xs text-accent-fg hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-accent/40"
		>{t('prompt_anchor.answer')}</button>
	</div>
</div>
{/if}
