<script lang="ts">
	import { segments } from '../utils/plan-takeover.js';
	// A sentence of lynox's with the values someone else wrote in it (marked by `shownValue`) set
	// apart, each in its own isolated element: a value cannot pass for lynox's words, nor turn the
	// direction of the text around it. The box has no outer space of its own: the spaces in the
	// sentence keep it from its neighbours, and a value at the start of a line stays flush with the
	// lines below. Inside it keeps 4 px (`px-1`), so an empty value still draws a box, and a value
	// that wraps gets a closed box on each line (`box-decoration-clone`). A 1 px edge in
	// `text-subtle` draws the box on every ground: measured on the rendered page, at least 4:1
	// against the card, the dialog, the warning notice and the warning badge, light and dark
	// (lowest: the badge in light, 4.09:1), where the grey grounds differ from each other by less
	// than 1.2:1. `mono` sets the value in the code font, for a value inside a sentence; a title
	// keeps its own font and width (`mono={false}`), and the box alone sets it apart.
	let { text, mono = true }: { text: string; mono?: boolean } = $props();
</script>

{#each segments(text) as s, i (i)}{#if s.foreign}<bdi data-foreign-value class="rounded-[var(--radius-sm)] border border-text-subtle bg-bg-muted px-1 box-decoration-clone {mono ? 'font-mono' : ''}">{s.text}</bdi>{:else}{s.text}{/if}{/each}
