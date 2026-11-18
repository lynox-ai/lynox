<script lang="ts">
	// The line that says the engine put the provider back on Anthropic, because the instance was
	// connected to a Shopify store and the provider picked before is off its list. It stands above the
	// chat input and on the LLM settings until the owner clicks "Got it" or picks a provider. A
	// mandate reads it without the button: only the owner ends it (the server refuses anyone else).
	import { t, tf } from '../i18n.svelte.js';
	import { dismissProviderReset, isOwnerSession, providerResetNotice, refreshProviderReset } from '../stores/settings-viewer.svelte.js';

	// The engine changes the provider at its start, which an open page does not see by itself: ask
	// again on mount, when the tab comes back into view, and after a provider save.
	$effect(() => {
		void refreshProviderReset();
		const onVisible = (): void => { if (document.visibilityState === 'visible') void refreshProviderReset(); };
		const onProviderChanged = (): void => { void refreshProviderReset(true); };
		document.addEventListener('visibilitychange', onVisible);
		window.addEventListener('lynox:provider-changed', onProviderChanged);
		return () => {
			document.removeEventListener('visibilitychange', onVisible);
			window.removeEventListener('lynox:provider-changed', onProviderChanged);
		};
	});

	let busy = $state(false);

	async function dismiss(): Promise<void> {
		busy = true;
		await dismissProviderReset();
		busy = false;
	}

	const from = $derived(providerResetNotice());
</script>

{#if from !== null}
	<div class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[var(--radius-md)] border border-border bg-bg-subtle px-3 py-2 text-sm" role="status" data-provider-reset>
		<p class="flex-1 min-w-0">{tf('llm.provider_reset.line', { provider: from })}</p>
		{#if isOwnerSession()}
			<button type="button" onclick={dismiss} disabled={busy}
				class="shrink-0 text-accent-text underline disabled:opacity-50">{t('llm.provider_reset.dismiss')}</button>
		{/if}
	</div>
{/if}
