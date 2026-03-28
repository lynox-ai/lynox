<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';

	interface ApiEndpoint { method: string; path: string; description: string; }
	interface ApiProfile { id: string; name: string; base_url: string; description: string; auth?: { type: string }; endpoints?: ApiEndpoint[]; guidelines?: string[]; }

	let profiles = $state<ApiProfile[]>([]);
	let loading = $state(true);
	let expanded = $state<string | null>(null);

	async function loadProfiles() {
		loading = true;
		try {
			const res = await fetch(`${getApiBase()}/api-profiles`);
			const data = (await res.json()) as { profiles: ApiProfile[] };
			profiles = data.profiles;
		} catch { /* */ }
		loading = false;
	}

	$effect(() => { loadProfiles(); });
</script>

<div class="p-6 max-w-4xl mx-auto">
	<a href="/app/settings" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('settings.back')}</a>
	<h1 class="text-xl font-light tracking-tight mb-4 mt-2">{t('apis.title')}</h1>

	{#if loading}
		<p class="text-text-subtle text-sm">{t('common.loading')}</p>
	{:else if profiles.length === 0}
		<p class="text-text-subtle text-sm">{t('apis.no_profiles')}</p>
	{:else}
		<div class="space-y-2">
			{#each profiles as profile}
				<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle overflow-hidden">
					<button onclick={() => expanded = expanded === profile.id ? null : profile.id}
						class="w-full px-4 py-3 text-left hover:bg-bg-muted transition-colors">
						<div class="flex items-center justify-between">
							<span class="text-sm font-medium">{profile.name}</span>
							{#if profile.auth}<span class="text-xs rounded-[var(--radius-sm)] bg-bg-muted px-1.5 py-0.5 text-text-muted">{profile.auth.type}</span>{/if}
						</div>
						<p class="text-xs text-text-subtle mt-1 font-mono">{profile.base_url}</p>
						{#if profile.description}<p class="text-xs text-text-muted mt-1">{profile.description}</p>{/if}
					</button>
					{#if expanded === profile.id && profile.endpoints && profile.endpoints.length > 0}
						<div class="border-t border-border px-4 py-3 space-y-1">
							<p class="text-xs font-mono uppercase tracking-widest text-text-subtle mb-2">{t('apis.endpoints')} ({profile.endpoints.length})</p>
							{#each profile.endpoints as ep}
								<div class="flex gap-2 text-xs">
									<span class="rounded-[var(--radius-sm)] bg-accent/10 text-accent-text px-1.5 py-0.5 font-mono">{ep.method}</span>
									<span class="font-mono text-text-muted">{ep.path}</span>
									<span class="text-text-subtle">{ep.description}</span>
								</div>
							{/each}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>
