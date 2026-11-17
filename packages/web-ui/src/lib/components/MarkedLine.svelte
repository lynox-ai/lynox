<script lang="ts">
	import { segments } from '../utils/plan-takeover.js';
	// A sentence of lynox's with the values someone else wrote in it (marked by `shownValue`) set
	// apart, each in its own isolated element: a value cannot pass for lynox's words, nor turn the
	// direction of the text around it. The box keeps a hair of space to the quotes and punctuation
	// around it (`mx-0.5`), and none on its left where it starts the line, so it stays flush with
	// the lines below. An empty value also gets inner space (`px-1`), or it would draw nothing where
	// a value stands. A 1 px edge in `text-subtle` draws the box on every ground: measured on the
	// rendered page, at least 4.4:1 against the card, the dialog and the warning notice, light and
	// dark, where the grey grounds differ from each other by less than 1.2:1. `mono` sets the value
	// in the code font, for a value inside a sentence; a title keeps its own font and width
	// (`mono={false}`), and the box alone sets it apart.
	let { text, mono = true }: { text: string; mono?: boolean } = $props();
</script>

{#each segments(text) as s, i (i)}{#if s.foreign}<bdi data-foreign-value class="{i === 0 ? 'mr-0.5' : 'mx-0.5'} rounded-[var(--radius-sm)] border border-text-subtle bg-bg-muted {mono ? 'font-mono' : ''} {s.text === '' ? 'px-1' : ''}">{s.text}</bdi>{:else}{s.text}{/if}{/each}
