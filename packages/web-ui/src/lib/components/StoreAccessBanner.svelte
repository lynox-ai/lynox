<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { getLocale, t, tf } from '../i18n.svelte.js';
	import { untrack } from 'svelte';
	import { connectHref } from '../oauth-connect-path.js';
	import { isOwnerSession, isViewerKnown, loadSettingsViewer } from '../stores/settings-viewer.svelte.js';
	import { hostParts, hostSegments, storeAccessShown, type StoreAccessProfile } from '../utils/store-access-end.js';

	// The owner's line per store whose access runs out soon or has (U-391): without web push the
	// owner learns of it here, before the end, and not only when a run halts. Hidden until the next
	// load at most, never for good: the end would come unnoticed again. The host's box moves to the
	// next line whole; only a host longer than a line breaks in it, after a dot. Shown once the server named
	// the session the owner's, also when that answer comes late (a retry).
	let profiles = $state<StoreAccessProfile[]>([]);
	let dismissed = $state(false);
	let now = $state(new Date());
	const lines = $derived(profiles.flatMap((p) => { const shown = storeAccessShown(p, now, getLocale()); return shown === null ? [] : [shown]; }));

	async function load(): Promise<void> {
		await loadSettingsViewer();
		// A session the server named another's is not asked; one not named yet is, and shows only
		// once the owner's.
		if (isViewerKnown() && !isOwnerSession()) return;
		try {
			const res = await fetch(`${getApiBase()}/api-profiles`);
			if (!res.ok) return;
			const data = (await res.json()) as { profiles?: StoreAccessProfile[] };
			profiles = data.profiles ?? [];
		} catch { /* silent: StatusBar handles an engine that is down */ }
	}

	$effect(() => {
		untrack(() => void load());
		// An end that passes while the page is open: the line says so within a minute.
		const timer = setInterval(() => { now = new Date(); }, 60_000);
		return () => clearInterval(timer);
	});
</script>

{#if lines.length > 0 && !dismissed && isOwnerSession()}
	<div role="status" class="border-b border-warning/30 bg-warning-subtle px-4 py-2.5 flex items-start justify-between gap-3" data-testid="store-access-banner">
		<ul class="space-y-2 min-w-0">
			{#each lines as line (line.profileId)}
				{@const parts = hostParts(tf(line.kind === 'soon' ? 'store_access.banner_soon' : 'store_access.banner_ended', { date: line.date, host: '{host}' }))}
				<li class="flex items-center gap-3 flex-wrap text-[12px] text-warning" data-testid="store-access-line">
					<span class="min-w-0 break-words">{parts.before}<span class="inline-block max-w-full font-mono rounded-[var(--radius-sm)] bg-bg-muted px-1 py-0.5 text-text" data-testid="store-access-host">{#each hostSegments(line.host) as seg, i (i)}{#if i > 0}<wbr />{/if}<span class="whitespace-nowrap">{seg}</span>{/each}</span>{parts.after}</span>
					<!-- A full page load: the engine's route answers with a page or a redirect to the provider. -->
					<a href={connectHref(getApiBase(), line.profileId)} data-sveltekit-reload data-testid="store-access-reconnect"
						class="shrink-0 rounded-[var(--radius-sm)] bg-accent/10 px-3 py-1 text-[12px] text-accent-text hover:bg-accent/15">{t('apis.reconnect')}</a>
				</li>
			{/each}
		</ul>
		<button onclick={() => (dismissed = true)} class="shrink-0 text-[12px] text-warning/70 hover:text-warning transition-colors" data-testid="store-access-dismiss">{t('banner.dismiss')}</button>
	</div>
{/if}
