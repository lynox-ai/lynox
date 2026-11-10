<script lang="ts">
	// The whole planned value of a field lynox does not write (`shortcode_changed`, 1130, ux U-103):
	// shown folded, copied whole, for the owner to paste into the shop themselves.
	import { t } from '../i18n.svelte.js';
	import { bulkFoldedValue } from './bulk-runs.js';

	let { value }: { value: string } = $props();

	let open = $state(false);
	let copied = $state(false);
	const folded = $derived(bulkFoldedValue(value));
	const shown = $derived(open ? value : folded.shown);

	async function copy(): Promise<void> {
		copied = false;
		try {
			// Always the whole value, never the folded text on screen.
			await navigator.clipboard.writeText(value);
			copied = true;
		} catch {
			copied = false;
		}
	}
</script>

<div class="mt-1" data-testid="bulk-refused-value">
	<pre class="max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded border border-border bg-bg-subtle p-2 text-xs" data-testid="bulk-refused-value-text">{shown}{#if folded.cut && !open}…{/if}</pre>
	<div class="mt-1 flex flex-wrap items-center gap-2 text-xs">
		{#if folded.cut && !open}
			<button type="button" class="underline" onclick={() => { open = true; }} data-testid="bulk-refused-value-toggle">{t('bulk.invalid.value_whole')}</button>
		{/if}
		<button type="button" class="rounded border border-border px-2 py-0.5" onclick={copy} data-testid="bulk-refused-value-copy">{t('bulk.invalid.value_copy')}</button>
		<span aria-live="polite" class="text-success" data-testid="bulk-refused-value-copied">{copied ? t('bulk.invalid.value_copied') : ''}</span>
	</div>
</div>
