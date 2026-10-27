<!--
	BulkStartDomains — the link domains the owner allows a judged list run's verdicts to add,
	besides the store's own (PRD shopify-preset §20.2 item 5). Editable in the start form of the
	judge, one host name per line; shown read-only in the approval view, so the owner approves a
	checksum over a list they have seen. The server checks and normalises the list; this only
	splits what was typed.
-->
<script lang="ts">
	import { t, tf } from '../i18n.svelte.js';

	let {
		storeHost,
		editable,
		domains = $bindable<string[]>([]),
	}: { storeHost: string; editable: boolean; domains?: string[] } = $props();

	let text = $state(domains.join('\n'));

	function onInput(value: string): void {
		text = value;
		domains = value.split(/[\s,]+/).map((d) => d.trim()).filter((d) => d.length > 0);
	}
</script>

<div class="text-sm space-y-1" data-testid="bulk-start-domains">
	{#if editable}
		<label class="block space-y-1">
			<span>{t('bulk.start_domains.label')}</span>
			<textarea
				class="w-full rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1 font-mono text-sm"
				rows="3"
				spellcheck="false"
				autocomplete="off"
				placeholder={t('bulk.start_domains.placeholder')}
				value={text}
				oninput={(e) => onInput(e.currentTarget.value)}
			></textarea>
		</label>
		<p class="text-text-muted">{tf('bulk.start_domains.explain', { store: storeHost })}</p>
	{:else}
		<p>{t('bulk.start_domains.shown')}</p>
		{#if domains.length === 0}
			<p class="text-text-muted">{tf('bulk.start_domains.none', { store: storeHost })}</p>
		{:else}
			<ul class="font-mono list-disc pl-5">
				{#each domains as d (d)}
					<li>{d}</li>
				{/each}
			</ul>
			<p class="text-text-muted">{tf('bulk.start_domains.and_store', { store: storeHost })}</p>
		{/if}
	{/if}
</div>
