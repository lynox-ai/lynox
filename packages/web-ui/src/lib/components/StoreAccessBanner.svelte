<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { getLocale, t, tf } from '../i18n.svelte.js';
	import { untrack } from 'svelte';
	import { connectHref } from '../oauth-connect-path.js';
	import { isOwnerSession, loadSettingsViewer } from '../stores/settings-viewer.svelte.js';
	import { hostParts, storeAccessShown, type StoreAccessProfile, type StoreAccessShown } from '../utils/store-access-end.js';

	// The owner's line per store whose access runs out soon or has (U-391): without web push the
	// owner learns of it here, before the end, and not only when a run halts. Hidden until the next
	// load at most, never for good: the end would come unnoticed again.
	let lines = $state<StoreAccessShown[]>([]);
	let dismissed = $state(false);

	async function load(): Promise<void> {
		const viewerRead = loadSettingsViewer();
		try {
			const res = await fetch(`${getApiBase()}/api-profiles`);
			if (!res.ok) return;
			const data = (await res.json()) as { profiles?: StoreAccessProfile[] };
			await viewerRead;
			if (!isOwnerSession()) return;
			const now = new Date();
			lines = (data.profiles ?? []).flatMap((p) => { const shown = storeAccessShown(p, now, getLocale()); return shown === null ? [] : [shown]; });
		} catch { /* silent: StatusBar handles an engine that is down */ }
	}

	$effect(() => {
		untrack(() => void load());
	});
</script>

{#if lines.length > 0 && !dismissed && isOwnerSession()}
	<div role="status" class="border-b border-warning/30 bg-warning-subtle px-4 py-2.5 flex items-start justify-between gap-3" data-testid="store-access-banner">
		<ul class="space-y-2 min-w-0">
			{#each lines as line (line.profileId)}
				{@const parts = hostParts(tf(line.kind === 'soon' ? 'store_access.banner_soon' : 'store_access.banner_ended', { date: line.date, host: '{host}' }))}
				<li class="flex items-center gap-3 flex-wrap text-[12px] text-warning" data-testid="store-access-line">
					<span class="min-w-0 break-words">{parts.before}<span class="font-mono rounded-[var(--radius-sm)] bg-bg-muted px-1 py-0.5 text-text break-all" data-testid="store-access-host">{line.host}</span>{parts.after}</span>
					<!-- A full page load: the engine's route answers with a page or a redirect to the provider. -->
					<a href={connectHref(getApiBase(), line.profileId)} data-sveltekit-reload data-testid="store-access-reconnect"
						class="shrink-0 rounded-[var(--radius-sm)] bg-accent/10 px-3 py-1 text-[12px] text-accent-text hover:bg-accent/15">{t('apis.reconnect')}</a>
				</li>
			{/each}
		</ul>
		<button onclick={() => (dismissed = true)} class="shrink-0 text-[12px] text-warning/70 hover:text-warning transition-colors" data-testid="store-access-dismiss">{t('banner.dismiss')}</button>
	</div>
{/if}
