<script lang="ts">
	import { segments } from '../utils/plan-takeover.js';

	// A sentence of lynox's with the values someone else wrote in it (a plan's title, a name) set
	// apart, each in its own isolated element: a value cannot pass for lynox's words, nor turn the
	// direction of the text around it.
	let { text }: { text: string } = $props();
</script>

{#each segments(text) as s, i (i)}{#if s.foreign}<bdi data-foreign-value class="rounded-[var(--radius-sm)] bg-bg-muted font-mono">{s.text}</bdi>{:else}{s.text}{/if}{/each}
