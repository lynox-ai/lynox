<!--
	A settings page's values as text, for a mandate's session (ux U-104): one "Label: value" line
	each, never a field. A secret is left out by the page, not shown masked.
-->
<script lang="ts">
	export interface ReadOnlyRow {
		label: string;
		value: string;
	}

	let { rows }: { rows: ReadOnlyRow[] } = $props();
</script>

<dl class="space-y-2 text-sm" data-testid="read-only-rows">
	{#each rows as row (row.label)}
		<div class="flex flex-wrap gap-x-2">
			<dt class="text-text-muted">{row.label}:</dt>
			<dd class="text-text break-words min-w-0">{row.value}</dd>
		</div>
	{/each}
</dl>
