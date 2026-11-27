<script lang="ts">
	import { t } from '../i18n.svelte.js';

	// The line at the head of a review dialog that says why it is open again (the steps changed, a
	// schedule waits for this stamp). While it is short it stays in sight as the review scrolls, so
	// the reason and what it marks are read together. A long line is cut to three lines, says so,
	// and opens in place; opened, it scrolls with the rest, or it would cover the review. Where the
	// frame is low (a phone held sideways, a page zoomed in), nothing stays and nothing is cut: the
	// whole frame scrolls, as without this line, and everything in it stays reachable. Same query
	// as DIALOG_FOOT_CLASS (utils/dialog-sticky.ts).
	let { text, testid, el = $bindable(null) }: {
		text: string;
		testid: string;
		/** The line itself (role=status), for a caller that brings it into view. */
		el?: HTMLElement | null;
	} = $props();

	let open = $state(false);
	let clipped = $state(false);

	// Another reason starts folded again.
	$effect(() => {
		void text;
		open = false;
	});

	// Cut or not is read from the rendered line: the same text is cut on a phone and whole on a wide
	// screen.
	$effect(() => {
		const line = el;
		const folded = !open;
		void text;
		if (line === null) return;
		const measure = (): void => { clipped = folded && line.scrollHeight > line.clientHeight + 1; };
		measure();
		if (typeof ResizeObserver !== 'function') return;
		const watch = new ResizeObserver(measure);
		watch.observe(line);
		return () => watch.disconnect();
	});
</script>

<div
	data-dialog-status
	class="-mx-5 px-5 pb-3 bg-bg border-border {open ? '' : '[@media(min-height:30rem)]:sticky [@media(min-height:30rem)]:-top-5 [@media(min-height:30rem)]:z-10 [@media(min-height:30rem)]:pt-2 [@media(min-height:30rem)]:mb-3 [@media(min-height:30rem)]:border-b'}"
>
	<div class="rounded-[var(--radius-sm)] border border-warning/30 bg-warning/10 px-3 py-2 text-xs">
		<p bind:this={el} role="status" data-testid={testid} class="break-words {open ? '' : '[@media(min-height:30rem)]:line-clamp-3'}">{text}</p>
		{#if clipped || open}
			<button
				type="button"
				data-dialog-status-more
				aria-expanded={open}
				onclick={() => { open = !open; }}
				class="mt-1 min-h-11 md:min-h-0 text-xs text-accent-text underline underline-offset-2 hover:no-underline"
			>{open ? t('workflow_library.status.show_less') : t('workflow_library.status.show_more')}</button>
		{/if}
	</div>
</div>
