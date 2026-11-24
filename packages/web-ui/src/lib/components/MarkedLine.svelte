<script lang="ts" module>
	/** The box a value someone else wrote is drawn in; `MarkedValue` draws the same one. */
	export const VALUE_BOX = 'rounded-[var(--radius-sm)] border border-text-subtle bg-bg-muted px-1 box-decoration-clone';
</script>

<script lang="ts">
	import { moreText, segments } from '../utils/plan-takeover.js';
	import { tf } from '../i18n.svelte.js';
	// A sentence of lynox's with the values someone else wrote in it (marked by `shownValue`) set
	// apart, each in its own isolated element: a value cannot pass for lynox's words, nor turn the
	// direction of the text around it. The box has no outer space of its own: the spaces in the
	// sentence keep it from its neighbours, and a value at the start of a line stays flush with the
	// lines below. Inside it keeps 4 px (`px-1`), so an empty value still draws a box, and a value
	// that wraps gets a closed box on each line (`box-decoration-clone`). A 1 px edge in
	// `text-subtle` draws the box: measured on the rendered page, at least 4:1
	// against the card, the dialog, the warning notice and the warning badge, light and dark
	// (lowest: the badge in light, 4.09:1), where the grey grounds differ from each other by less
	// than 1.2:1.
	// `mono` sets the value in the code font, for a value inside a sentence; a title
	// keeps its own font and width (`mono={false}`), and the box alone sets it apart.
	// A list of plans past five (`planList`) keeps its rest folded: "and {n} more" is a button in
	// the sentence, and pressing it puts the remaining titles in its place, in the same sentence,
	// each in its own box. There is no folding back. Focus goes to the first title it put in, so a
	// keyboard or screen reader carries on where the button was.
	let { text, mono = true }: { text: string; mono?: boolean } = $props();
	let open = $state(false);
	const gap = ' ';
	const focusFirst = (node: HTMLElement): void => { node.focus(); };
</script>

{#each segments(text) as s, i (i)}{#if s.more !== undefined}{#if open}{#each s.more.pieces as p, j (j)}{#if p.foreign}{#if j === s.more.pieces.findIndex((q) => q.foreign)}<bdi data-foreign-value tabindex="-1" use:focusFirst class="{VALUE_BOX} {mono ? 'font-mono' : ''} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{p.text}</bdi>{:else}<bdi data-foreign-value class="{VALUE_BOX} {mono ? 'font-mono' : ''}">{p.text}</bdi>{/if}{:else}{p.text}{/if}{/each}{:else}{gap}<button type="button" class="underline underline-offset-2 rounded-[var(--radius-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-expanded="false" aria-label={tf('takeover.plans_more_show', { n: String(s.more.n) })} data-testid="plans-more" onclick={() => { open = true; }}>{moreText(s.more.n)}</button>{/if}{:else if s.foreign}<bdi data-foreign-value class="{VALUE_BOX} {mono ? 'font-mono' : ''}">{s.text}</bdi>{:else}{s.text}{/if}{/each}
