<!--
	BulkStartDomains — the allowed link domains of a judged list run: the domains its new texts may
	link to besides the store's own (PRD shopify-preset §20.2 item 5). Editable in the start form of
	the judge, one domain per line, each wrong line marked before the start; read-only wherever the
	list is already fixed (a restart, the approval view), so the owner approves a checksum over a
	list they have seen. The engine checks the list again; this keeps its refusal a net.
-->
<script lang="ts">
	import { t, tf } from '../i18n.svelte.js';
	import { readStartDomainLines } from './bulk-start-domains.js';
	import { bulkTemplateParts } from './bulk-runs.js';
	import BulkHost from './BulkHost.svelte';

	let {
		storeHost,
		editable,
		domains = $bindable<string[]>([]),
		valid = $bindable(true),
	}: { storeHost: string; editable: boolean; domains?: string[]; valid?: boolean } = $props();

	let text = $state(domains.join('\n'));
	// Ties the marked lines to the field, so a screen reader reads them with it.
	const errorsId = `bulk-start-domains-errors-${Math.random().toString(36).slice(2)}`;
	const read = $derived(readStartDomainLines(text));

	function onInput(value: string): void {
		text = value;
		const r = readStartDomainLines(value);
		domains = r.domains;
		valid = r.badLines.length === 0 && !r.tooMany;
	}
</script>

<!-- A sentence naming the store's host and the allowed domains: each one boxed at its place (U-423). -->
{#snippet storeSentence(key: string)}{#each bulkTemplateParts(t(key), ['store', 'list'], {}) as part, i (i)}{#if 'text' in part}{part.text}{:else if part.slot === 'store'}<BulkHost value={storeHost} />{:else}{#each domains as d, j (j)}{j > 0 ? ', ' : ''}<BulkHost value={d} testid="bulk-start-domain" />{/each}{/if}{/each}{/snippet}

<div class="text-sm space-y-1" data-testid="bulk-start-domains">
	{#if editable}
		<!-- space-y-2: the focus ring stands 4px outside the field and must not touch the label (U-339). -->
		<label class="block space-y-2">
			<span>{t('bulk.start_domains.label')}</span>
			<textarea
				class="w-full rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1 font-mono text-sm"
				rows="3"
				spellcheck="false"
				autocomplete="off"
				placeholder={t('bulk.start_domains.placeholder')}
				aria-invalid={read.badLines.length > 0 || read.tooMany}
				aria-describedby={read.badLines.length > 0 || read.tooMany ? errorsId : undefined}
				value={text}
				oninput={(e) => onInput(e.currentTarget.value)}
			></textarea>
		</label>
		{#if read.badLines.length > 0 || read.tooMany}
			<div class="text-danger" role="alert" id={errorsId}>
				{#each read.badLines as i (i)}
					<p><span class="font-mono">{tf('bulk.start_domains.bad_line', { line: String(i + 1), text: text.split('\n')[i] ?? '' })}</span></p>
				{/each}
				<p>{t('bulk.start_domains.invalid')}</p>
			</div>
		{/if}
		<p class="text-text-muted">{@render storeSentence('bulk.start_domains.explain')}</p>
	{:else if domains.length === 0}
		<p>{@render storeSentence('bulk.start_domains.none')}</p>
	{:else}
		<p>{@render storeSentence('bulk.start_domains.shown')}</p>
	{/if}
</div>
