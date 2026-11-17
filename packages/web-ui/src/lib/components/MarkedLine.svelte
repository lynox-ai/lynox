<script lang="ts">
	import { segments } from '../utils/plan-takeover.js';
	// A sentence of lynox's with the values someone else wrote in it (marked by `shownValue`) set
	// apart, each in its own isolated element: a value cannot pass for lynox's words, nor turn the
	// direction of the text around it. The box keeps a hair of space to the quotes and punctuation
	// around it (`mx-0.5`); an empty value also gets inner space (`px-1`), or it would draw nothing
	// where a value stands. `mono` sets the value in the code font; a title in a list keeps the
	// list's font and its width (`mono={false}`), the grey box alone sets it apart.
	let { text, mono = true }: { text: string; mono?: boolean } = $props();
</script>

{#each segments(text) as s, i (i)}{#if s.foreign}<bdi data-foreign-value class="mx-0.5 rounded-[var(--radius-sm)] bg-bg-muted {mono ? 'font-mono' : ''} {s.text === '' ? 'px-1' : ''}">{s.text}</bdi>{:else}{s.text}{/if}{/each}
