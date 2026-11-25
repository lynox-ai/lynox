<script lang="ts">
	import WholeValue from './WholeValue.svelte';

	// A watched page's address, its host set off (U-391): the address moves to the next line whole
	// when it fits on one; a longer one breaks after a dot or slash, also between host and path,
	// never at a hyphen inside the host.
	let { host, rest = '', testid = undefined }: { host: string; rest?: string; testid?: string | undefined } = $props();
</script>

<span class="inline-block max-w-full" data-testid={testid}><WholeValue value={host} kind="url" class="font-medium text-text" />{#if rest !== ''}<wbr /><WholeValue value={rest} kind="url" />{/if}</span>
