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

	let {
		storeHost,
		editable,
		domains = $bindable<string[]>([]),
		valid = $bindable(true),
	}: { storeHost: string; editable: boolean; domains?: string[]; valid?: boolean } = $props();

	let text = $state(domains.join('\n'));
	const read = $derived(readStartDomainLines(text));

	function onInput(value: string): void {
		text = value;
		const r = readStartDomainLines(value);
		domains = r.domains;
		valid = r.badLines.length === 0 && !r.tooMany;
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
				aria-invalid={read.badLines.length > 0 || read.tooMany}
				value={text}
				oninput={(e) => onInput(e.currentTarget.value)}
			></textarea>
		</label>
		{#if read.badLines.length > 0 || read.tooMany}
			<div class="text-danger" role="alert">
				{#each read.badLines as i (i)}
					<p class="font-mono">{tf('bulk.start_domains.bad_line', { line: String(i + 1), text: text.split('\n')[i] ?? '' })}</p>
				{/each}
				<p>{t('bulk.start_domains.invalid')}</p>
			</div>
		{/if}
		<p class="text-text-muted">{tf('bulk.start_domains.explain', { store: storeHost })}</p>
	{:else if domains.length === 0}
		<p>{tf('bulk.start_domains.none', { store: storeHost })}</p>
	{:else}
		<p>{tf('bulk.start_domains.shown', { list: domains.join(', '), store: storeHost })}</p>
	{/if}
</div>
