<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';

	interface ApiEndpoint { method: string; path: string; description: string; }
	interface ApiProfile { id: string; name: string; base_url: string; description: string; auth?: { type: string }; endpoints?: ApiEndpoint[]; guidelines?: string[]; }

	let profiles = $state<ApiProfile[]>([]);
	let loading = $state(true);
	let expanded = $state<string | null>(null);
	let deleting = $state<string | null>(null);
	let error = $state('');

	async function loadProfiles() {
		loading = true;
		error = '';
		try {
			const res = await fetch(`${getApiBase()}/api-profiles`);
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { profiles: ApiProfile[] };
			profiles = data.profiles;
		} catch {
			error = t('common.load_failed');
		}
		loading = false;
	}

	async function deleteProfile(profile: ApiProfile) {
		// Native confirm keeps the surface small; matches the rest of the
		// destructive-action UX in this app (HistoryView, ArtifactsView).
		const msg = t('apis.delete_confirm').replace('{name}', profile.name);
		if (!confirm(msg)) return;
		deleting = profile.id;
		error = '';
		try {
			const res = await fetch(`${getApiBase()}/api-profiles/${encodeURIComponent(profile.id)}`, { method: 'DELETE' });
			if (!res.ok) throw new Error();
			profiles = profiles.filter(p => p.id !== profile.id);
			if (expanded === profile.id) expanded = null;
		} catch {
			error = t('apis.delete_failed');
		}
		deleting = null;
	}

	$effect(() => { loadProfiles(); });
</script>

<div class="p-6 max-w-4xl mx-auto">
	<h1 class="text-xl font-light tracking-tight mb-4">{t('apis.title')}</h1>

	{#if error}
		<div class="rounded-[var(--radius-md)] bg-danger/10 border border-danger/20 px-4 py-3 text-sm text-danger mb-4">{error}</div>
	{/if}

	{#if loading}
		<p class="text-text-subtle text-sm">{t('common.loading')}</p>
	{:else if profiles.length === 0}
		<p class="text-text-subtle text-sm">{t('apis.no_profiles')}</p>
	{:else}
		<div class="space-y-2">
			{#each profiles as profile}
				<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle overflow-hidden">
					<div class="flex items-stretch">
						<button onclick={() => expanded = expanded === profile.id ? null : profile.id}
							class="flex-1 px-4 py-3 text-left hover:bg-bg-muted transition-colors">
							<div class="flex items-center gap-2">
								<span class="text-sm font-medium">{profile.name}</span>
								{#if profile.auth}<span class="text-xs rounded-[var(--radius-sm)] bg-bg-muted px-1.5 py-0.5 text-text-muted">{profile.auth.type}</span>{/if}
							</div>
							<p class="text-xs text-text-subtle mt-1 font-mono">{profile.base_url}</p>
							{#if profile.description}<p class="text-xs text-text-muted mt-1">{profile.description}</p>{/if}
						</button>
						<button onclick={() => deleteProfile(profile)}
							disabled={deleting === profile.id}
							aria-label={t('apis.delete')}
							class="px-3 text-xs text-text-subtle hover:text-danger hover:bg-danger/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed border-l border-border">
							{t('apis.delete')}
						</button>
					</div>
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
