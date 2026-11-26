<script lang="ts">
	import { untrack } from 'svelte';
	import { t, tf } from '../i18n.svelte.js';
	import { prefersReducedMotion, scrollBehaviorForMotion } from '../utils/pipeline-status.js';
	import { linesBelow, promptFieldTooLow, type Segment } from '../utils/prompt-head.js';

	interface Props {
		/** The opening, as segments; stays in view, never scrolls. A short value in it stays a value. */
		head: Segment[];
		/** The value's lines; only these scroll. */
		lines: string[];
		/** Set when there is no room for about four lines: the card then keeps its height. */
		tooLow?: boolean;
	}

	let { head, lines, tooLow = $bindable(false) }: Props = $props();

	let field = $state<HTMLElement | null>(null);
	let fade = $state<HTMLElement | null>(null);
	/** Lines of the value not wholly in view below the field's edge. */
	let below = $state(0);

	const label = $derived(below === 1 ? t('chat.prompt_read_more_one') : tf('chat.prompt_read_more', { n: String(below) }));

	function measure(): void {
		const el = field;
		if (!el) return;
		const bottom = el.getBoundingClientRect().bottom;
		const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 22;
		below = linesBelow([...el.querySelectorAll<HTMLElement>('[data-prompt-line]')].map((l) => { const r = l.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }), bottom, lineHeight);
		const stack = el.closest<HTMLElement>('[data-chat-stack]');
		const over = stack ? stack.scrollHeight - stack.clientHeight : 0;
		tooLow = promptFieldTooLow(el, over, lineHeight, tooLow);
	}

	let frame = 0;
	function schedule(): void {
		if (typeof requestAnimationFrame === 'undefined') { measure(); return; }
		cancelAnimationFrame(frame);
		frame = requestAnimationFrame(measure);
	}

	$effect(() => {
		const el = field;
		void lines;
		void head;
		if (!el) return;
		untrack(measure);
		const stack = el.closest<HTMLElement>('[data-chat-stack]');
		const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => schedule());
		ro?.observe(el);
		// A field held at its full height does not change size when only its lines do (the font
		// arriving, say), so each line is watched too.
		for (const line of el.querySelectorAll<HTMLElement>('[data-prompt-line]')) ro?.observe(line);
		if (stack) ro?.observe(stack);
		window.addEventListener('resize', schedule);
		return () => {
			ro?.disconnect();
			window.removeEventListener('resize', schedule);
			if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(frame);
			tooLow = false;
		};
	});

	/** On to the first line not wholly seen above the fade: it stands whole at the top after, so no
	 *  line is only ever seen cut or under the fade. A line taller than the field (one long value
	 *  wrapped over many screen lines) already at the top is read on by the field's height less one
	 *  line, or less the fade where it is taller. */
	function readOn(): void {
		const el = field;
		if (!el) return;
		const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 22;
		const fadeHeight = fade?.offsetHeight ?? 0;
		const top = el.getBoundingClientRect().top;
		const seenTo = top + el.clientHeight - fadeHeight;
		let step = 0;
		for (const line of el.querySelectorAll<HTMLElement>('[data-prompt-line]')) {
			const box = line.getBoundingClientRect();
			if (box.bottom > seenTo + 0.5) { step = box.top - top; break; }
		}
		if (step < lineHeight) step = Math.max(lineHeight, el.clientHeight - Math.max(lineHeight, fadeHeight));
		el.scrollBy({ top: step, behavior: scrollBehaviorForMotion(prefersReducedMotion()) });
	}
</script>

<!-- The question opens with its head, which never scrolls; below it the value's lines scroll in
     their own field. While lines lie below the field's edge, a fade on the field and a button on its
     own row under it say how many; the button never covers a line, so the end of a command stays
     readable. -->
<div data-prompt-question class="flex min-h-0 min-w-0 flex-1 flex-col text-sm text-text-muted font-sans leading-relaxed">
	{#if head.length > 0}
		<div data-prompt-head class="shrink-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{#each head as seg, i (i)}{#if seg.kind === 'value'}<span data-prompt-value class="text-text">{seg.text}</span>{:else}{seg.text}{/if}{/each}</div>
	{/if}
	<div class="relative flex min-h-0 flex-1 flex-col">
		<pre data-prompt-field bind:this={field} onscroll={schedule} class="min-h-0 flex-1 max-h-64 overflow-y-auto scrollbar-thin whitespace-pre-wrap font-sans [overflow-wrap:anywhere]">{#each lines as line, i (i)}<span data-prompt-line class="block">{#if line === ''}<br />{:else}{line}{/if}</span>{/each}</pre>
		{#if below > 0}
			<div data-prompt-fade bind:this={fade} class="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-bg-subtle to-transparent"></div>
		{/if}
	</div>
	{#if below > 0}
		<div class="flex shrink-0 justify-end pt-1">
			<button data-prompt-read-more type="button" onclick={readOn} class="whitespace-nowrap rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-0.5 text-xs text-text-muted hover:text-text">{label} <span aria-hidden="true">↓</span></button>
		</div>
	{/if}
</div>
