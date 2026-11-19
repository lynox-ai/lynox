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

	// The bar points to a question that is off screen. While the question's opening line is on screen it
	// shows the question once, there; the bar would only repeat it. The card sits in the scrolling stack
	// above the input, which never lets the whole card leave — so the measure is the card's TOP inside
	// the visible part of that stack, read on every scroll and resize and when the page changes (which
	// also finds the next question's card). An IntersectionObserver reports only threshold crossings and
	// misses a card taller than its stack scrolling under its own top.
	// Keyed on the question's kind and id, not the prop object: the head is rebuilt whenever any field of
	// the pending question changes, and re-measuring from scratch on each would blink the bar.
	const promptKind = $derived(prompt.kind);
	const promptKey = $derived(prompt.promptId ?? prompt.question);
	let sight = $state<PromptFormSight>({ kind: 'seen', inView: true });
	const shown = $derived(promptAnchorShown(sight));
	$effect(() => {
		const kind = promptKind;
		void promptKey;
		if (typeof document === 'undefined' || typeof window === 'undefined' || typeof MutationObserver === 'undefined') {
			sight = { kind: 'unobservable' };
			return;
		}
		let frame = 0;
		const measure = (): void => {
			frame = 0;
			const el = findPromptFormByKind(document, kind);
			if (!el) { sight = { kind: 'absent' }; return; }
			const scroller = el.closest<HTMLElement>('[data-chat-stack]');
			const view = scroller?.getBoundingClientRect();
			const top = Math.max(view?.top ?? 0, 0);
			const bottom = Math.min(view?.bottom ?? window.innerHeight, window.innerHeight);
			const inView = promptFormInView(el.getBoundingClientRect(), top, bottom);
			if (sight.kind !== 'seen' || sight.inView !== inView) sight = { kind: 'seen', inView };
		};
		const schedule = (): void => { if (frame === 0) frame = requestAnimationFrame(measure); };
		measure();
		const mo = new MutationObserver(schedule);
		mo.observe(document.querySelector('[data-chat-stack]') ?? document.body, { childList: true, subtree: true });
		// Scroll does not bubble; captured at the document it is seen for the stack and the page alike.
		document.addEventListener('scroll', schedule, { capture: true, passive: true });
		window.addEventListener('resize', schedule, { passive: true });
		return () => {
			mo.disconnect();
			document.removeEventListener('scroll', schedule, { capture: true });
			window.removeEventListener('resize', schedule);
			if (frame !== 0) cancelAnimationFrame(frame);
		};
	});

	function expandInlinePrompt(): void {
		if (typeof document === 'undefined') return;
		const el = findPromptFormByKind(document, prompt.kind);
		if (!el) return;
		// To the card's top, where the question opens: centred, a card taller than its stack would keep
		// the question cut off and this bar on screen.
		el.scrollIntoView({ behavior: scrollBehaviorForMotion(prefersReducedMotion()), block: 'start' });
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
