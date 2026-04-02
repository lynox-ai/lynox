<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { onMount } from 'svelte';

	let apiKeyMissing = $state(false);
	let dismissed = $state(false);

	onMount(async () => {
		try {
			const res = await fetch(`${getApiBase()}/secrets/status`);
			if (res.ok) {
				const data = (await res.json()) as { configured: Record<string, boolean> };
				apiKeyMissing = !data.configured['api_key'];
			}
		} catch { /* silent — StatusBar handles engine-down state */ }
	});

	function dismiss() {
		dismissed = true;
	}
</script>

{#if apiKeyMissing && !dismissed}
	<div role="alert" class="flex items-center justify-between gap-3 border-b border-warning/30 bg-warning/10 px-4 py-2 text-sm text-warning shrink-0">
		<div class="flex items-center gap-2 min-w-0">
			<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0" viewBox="0 0 20 20" fill="currentColor">
				<path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" />
			</svg>
			<span>{t('banner.api_key_missing')}</span>
		</div>
		<div class="flex items-center gap-2 shrink-0">
			<a href="/app/settings/keys" class="rounded-[var(--radius-sm)] bg-warning/20 px-2.5 py-1 text-xs font-medium hover:bg-warning/30 transition-colors">
				{t('banner.api_key_action')}
			</a>
			<button onclick={dismiss} class="text-warning/60 hover:text-warning transition-colors" aria-label={t('banner.dismiss')}>
				<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
					<path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
				</svg>
			</button>
		</div>
	</div>
{/if}
