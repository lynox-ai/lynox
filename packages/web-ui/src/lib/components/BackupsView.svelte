<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t, getLocale } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';

	interface Backup { version: string; created_at: string; encrypted: boolean; files: { path: string; size: number }[]; checksum: string; }

	let backups = $state<Backup[]>([]);
	let loading = $state(true);
	let creating = $state(false);
	let error = $state('');

	async function loadBackups() {
		loading = true; error = '';
		try {
			const res = await fetch(`${getApiBase()}/backups`);
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { backups: Backup[] };
			backups = data.backups;
		} catch { error = t('common.load_failed'); }
		loading = false;
	}

	async function createBackup() {
		creating = true;
		try {
			const res = await fetch(`${getApiBase()}/backups`, { method: 'POST' });
			if (!res.ok) throw new Error();
			addToast('Backup created', 'success');
			await loadBackups();
		} catch { addToast(t('common.error'), 'error'); }
		creating = false;
	}

	function formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / 1048576).toFixed(1)} MB`;
	}

	$effect(() => { loadBackups(); });
</script>

<div class="p-6 max-w-4xl mx-auto">
	<a href="/app/settings" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('settings.back')}</a>
	<div class="flex items-center justify-between mb-4 mt-2">
		<h1 class="text-xl font-light tracking-tight">{t('backups.title')}</h1>
		<button onclick={createBackup} disabled={creating}
			class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm font-medium text-text hover:opacity-90 disabled:opacity-50">
			{creating ? t('backups.creating') : t('backups.create')}
		</button>
	</div>

	{#if error}
		<div class="rounded-[var(--radius-md)] bg-danger/10 border border-danger/20 px-4 py-3 text-sm text-danger mb-4">{error}</div>
	{/if}

	{#if loading}
		<p class="text-text-subtle text-sm">{t('common.loading')}</p>
	{:else if backups.length === 0}
		<p class="text-text-subtle text-sm">{t('backups.no_backups')}</p>
	{:else}
		<div class="space-y-2">
			{#each backups as backup}
				<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle px-4 py-3">
					<div class="flex items-center justify-between">
						<span class="text-sm font-mono">{new Date(backup.created_at).toLocaleString(getLocale() === 'de' ? 'de-CH' : 'en-US')}</span>
						<div class="flex items-center gap-2">
							{#if backup.encrypted}
								<span class="text-xs rounded-[var(--radius-sm)] bg-success/15 text-success px-1.5 py-0.5">{t('backups.encrypted')}</span>
							{/if}
							<span class="text-xs text-text-muted">{backup.files.length} {t('backups.files')}</span>
						</div>
					</div>
					<div class="flex gap-2 mt-1.5 text-xs text-text-subtle">
						<span>v{backup.version}</span>
						<span>{formatSize(backup.files.reduce((s, f) => s + f.size, 0))}</span>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>
