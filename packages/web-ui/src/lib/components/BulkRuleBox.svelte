<script lang="ts">
	// The rule of a judged run, where the owner starts the judging, approves its values, or judges
	// again. The agent writes the rule, up to the engine's length bound and possibly from data it
	// read, so its height is bounded here: a long rule scrolls inside the box and no longer pushes
	// the preview and the sentence under it out of sight. The whole rule stays readable, and a long
	// word breaks inside the box instead of running past its edge.
	//
	// A scrolling box hides what lies below its edge, and with overlay scrollbars nothing shows that
	// there is more: a rule could put its real instruction under a run of empty lines, and the owner
	// would reach the button without having seen it. So while lines lie below the edge, a fade on the
	// box and a button on its own row under it say how many (U-416, the same form as a question's
	// field); the count follows the scroll and both go away at the end.
	import { untrack } from 'svelte';
	import { t, tf } from '../i18n.svelte.js';
	import { prefersReducedMotion, scrollBehaviorForMotion } from '../utils/pipeline-status.js';
	import { bulkRuleLinesBelow } from './bulk-runs.js';

	// The rule as the page shows it: already through bulkVisibleText at the call, where the check
	// over the bulk pages' templates reads it, so a hidden character in it is visible here too.
	let { visibleRule }: { visibleRule: string } = $props();

	const lines = $derived(visibleRule.split('\n'));

	let box = $state<HTMLElement | null>(null);
	/** The rule's lines, whose height changes without the box's when the box is at its bound. */
	let body = $state<HTMLElement | null>(null);
	/** Screen lines of the rule not wholly in view below the box's edge. */
	let below = $state(0);

	const label = $derived(below === 1 ? t('bulk.rule_read_more_one') : tf('bulk.rule_read_more', { n: String(below) }));

	function measure(): void {
		const el = box;
		if (!el) return;
		const bottom = el.getBoundingClientRect().bottom;
		const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20;
		below = bulkRuleLinesBelow([...el.querySelectorAll<HTMLElement>('[data-rule-line]')].map((l) => { const r = l.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }), bottom, lineHeight);
	}

	let frame = 0;
	function schedule(): void {
		if (typeof requestAnimationFrame === 'undefined') { measure(); return; }
		cancelAnimationFrame(frame);
		frame = requestAnimationFrame(measure);
	}

	$effect(() => {
		const el = box;
		void lines;
		if (!el) return;
		untrack(measure);
		const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => schedule());
		ro?.observe(el);
		// At its bound the box keeps its height while a font swap or a new wrap changes the lines'
		// height, so the lines are watched as well.
		if (body) ro?.observe(body);
		window.addEventListener('resize', schedule);
		return () => {
			ro?.disconnect();
			window.removeEventListener('resize', schedule);
			if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(frame);
		};
	});

	/** On by the box's height less one line: the line cut at the edge stands whole at the top after. */
	function readOn(): void {
		const el = box;
		if (!el) return;
		const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20;
		el.scrollBy({ top: Math.max(lineHeight, el.clientHeight - lineHeight), behavior: scrollBehaviorForMotion(prefersReducedMotion()) });
	}
</script>

<div class="relative">
	<!-- A scrolling region takes the keyboard focus, so it can be scrolled without a pointer. -->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div
		class="text-sm whitespace-pre-wrap [overflow-wrap:anywhere] max-h-48 overflow-y-auto scrollbar-thin rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-2"
		role="region"
		aria-label={t('bulk.start.rule')}
		tabindex="0"
		data-testid="bulk-rule-box"
		bind:this={box}
		onscroll={schedule}
	><div bind:this={body}>{#each lines as line, i (i)}<span data-rule-line class="block min-h-[1lh]">{line}</span>{/each}</div></div>
	{#if below > 0}
		<div data-testid="bulk-rule-fade" class="pointer-events-none absolute inset-x-px bottom-px h-8 rounded-b-[var(--radius-sm)] bg-gradient-to-t from-bg to-transparent"></div>
	{/if}
</div>
{#if below > 0}
	<div class="flex justify-end pt-1">
		<button data-testid="bulk-rule-read-more" type="button" onclick={readOn} class="whitespace-nowrap rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-0.5 text-xs text-text-muted hover:text-text">{label} <span aria-hidden="true">↓</span></button>
	</div>
{/if}
