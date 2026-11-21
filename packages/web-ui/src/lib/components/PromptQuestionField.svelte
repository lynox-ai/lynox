<script lang="ts">
	import { t, tf } from '../i18n.svelte.js';
	import { prefersReducedMotion, scrollBehaviorForMotion } from '../utils/pipeline-status.js';
	import { linesBelow, promptFieldTooLow } from '../utils/prompt-head.js';

	interface Props {
		/** The system-written opening; stays in view, never scrolls. */
		head: string;
		/** The value's lines; only these scroll. */
		lines: string[];
		/** Set when there is no room for about four lines: the card then keeps its height. */
		tooLow?: boolean;
	}

	let { head, lines, tooLow = $bindable(false) }: Props = $props();

	let field = $state<HTMLElement | null>(null);
	/** Lines of the value not wholly in view below the field's edge. */
	let below = $state(0);

	const label = $derived(below === 1 ? t('chat.prompt_read_more_one') : tf('chat.prompt_read_more', { n: String(below) }));

	function measure(): void {
		const el = field;
		if (!el) return;
		const bottom = el.getBoundingClientRect().bottom;
		below = linesBelow([...el.querySelectorAll<HTMLElement>('[data-prompt-line]')].map((l) => l.getBoundingClientRect().bottom), bottom);
		const stack = el.closest<HTMLElement>('[data-chat-stack]');
		const over = stack ? stack.scrollHeight - stack.clientHeight : 0;
		const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 22;
		tooLow = promptFieldTooLow(el, over, lineHeight);
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
		measure();
		const stack = el.closest<HTMLElement>('[data-chat-stack]');
		const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => schedule());
		ro?.observe(el);
		if (stack) ro?.observe(stack);
		window.addEventListener('resize', schedule);
		return () => {
			ro?.disconnect();
			window.removeEventListener('resize', schedule);
			if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(frame);
		};
	});

	function readOn(): void {
		field?.scrollBy({ top: field.clientHeight, behavior: scrollBehaviorForMotion(prefersReducedMotion()) });
	}
</script>

<!-- The question opens with its head, which never scrolls; below it the value's lines scroll in
     their own field. While lines lie below the field's edge, a fade and a button say how many. -->
<div data-prompt-question class="flex min-h-0 min-w-0 flex-1 flex-col text-sm text-text-muted font-sans leading-relaxed">
	{#if head}
		<div data-prompt-head class="shrink-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{head}</div>
	{/if}
	<div class="relative flex min-h-0 flex-1 flex-col">
		<pre data-prompt-field bind:this={field} onscroll={schedule} class="min-h-0 flex-1 max-h-64 overflow-y-auto scrollbar-thin whitespace-pre-wrap font-sans [overflow-wrap:anywhere]">{#each lines as line, i (i)}<span data-prompt-line class="block">{#if line === ''}&nbsp;{:else}{line}{/if}</span>{/each}</pre>
		{#if below > 0}
			<div data-prompt-fade class="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-bg-subtle to-transparent"></div>
			<button data-prompt-read-more type="button" onclick={readOn} aria-label={t('chat.prompt_read_more_aria')} class="absolute bottom-0 right-0 whitespace-nowrap rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-0.5 text-xs text-text-muted hover:text-text">{label}</button>
		{/if}
	</div>
</div>
