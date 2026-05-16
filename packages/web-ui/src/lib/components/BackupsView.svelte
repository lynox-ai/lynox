<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t, getLocale } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';

	interface Backup { backup_id: string; version: string; created_at: string; encrypted: boolean; files: { path: string; size_bytes: number }[]; checksum: string; }

	interface Config {
		backup_schedule?: string | undefined;
		backup_encrypt?: boolean;
		backup_retention_days?: number | undefined;
	}

	let backups = $state<Backup[]>([]);
	let loading = $state(true);
	let creating = $state(false);
	let restoring = $state<string | null>(null);
	let confirmRestore = $state<string | null>(null);
	let error = $state('');

	// Backup settings (loaded from config)
	let config = $state<Config>({});
	let configLoading = $state(true);
	let saving = $state(false);
	let saved = $state(false);

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

	async function loadConfig() {
		configLoading = true;
		try {
			const res = await fetch(`${getApiBase()}/config`);
			if (!res.ok) throw new Error();
			// GET /api/config returns the user config plus response-only fields
			// (managed, capabilities, locks, bugsink_dsn_configured, *_configured).
			// We only need the three backup fields — projecting here keeps a future
			// `JSON.stringify(config)` save from re-sending those response-only keys
			// (the schema is `.strict()` since PRD-IA-V2 P1-PR-A2, would 400).
			const body = (await res.json()) as Config;
			config = {
				backup_schedule: body.backup_schedule,
				backup_encrypt: body.backup_encrypt,
				backup_retention_days: body.backup_retention_days,
			};
		} catch { /* ignore — settings just won't be editable */ }
		configLoading = false;
	}

	async function saveConfig() {
		saving = true;
		try {
			// Send ONLY the three backup fields — schema is `.strict()`, so any
			// stray response-only field from GET would 400 the whole save.
			const payload: Config = {
				backup_schedule: config.backup_schedule,
				backup_encrypt: config.backup_encrypt,
				backup_retention_days: config.backup_retention_days,
			};
			const res = await fetch(`${getApiBase()}/config`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});
			if (!res.ok) throw new Error();
			saved = true;
			setTimeout(() => (saved = false), 2000);
		} catch {
			addToast(t('common.save_failed'), 'error');
		}
		saving = false;
	}

	async function createBackup() {
		creating = true;
		try {
			const res = await fetch(`${getApiBase()}/backups`, { method: 'POST' });
			if (!res.ok) throw new Error();
			addToast(t('backups.create'), 'success');
			await loadBackups();
		} catch { addToast(t('common.error'), 'error'); }
		creating = false;
	}

	async function restoreBackup(backupId: string) {
		restoring = backupId;
		try {
			const res = await fetch(`${getApiBase()}/backups/${encodeURIComponent(backupId)}/restore`, { method: 'POST' });
			const data = (await res.json()) as { success: boolean; error?: string };
			if (data.success) {
				addToast(t('backups.restore_success'), 'success', 6000);
			} else {
				addToast(data.error ?? t('backups.restore_failed'), 'error', 6000);
			}
			await loadBackups();
		} catch {
			addToast(t('backups.restore_failed'), 'error');
		}
		restoring = null;
		confirmRestore = null;
	}

	function formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / 1048576).toFixed(1)} MB`;
	}

	$effect(() => { loadBackups(); loadConfig(); });

	const inputClass = 'w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm focus:border-accent focus:outline-none';
	const cardClass = 'rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4';
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

	<!-- Backup List -->
	{#if loading}
		<p class="text-text-subtle text-sm">{t('common.loading')}</p>
	{:else if backups.length === 0}
		<p class="text-text-subtle text-sm">{t('backups.no_backups')}</p>
	{:else}
		<div class="space-y-2 mb-8">
			{#each backups as backup}
				<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle px-4 py-3">
					<div class="flex items-center justify-between">
						<span class="text-sm font-mono">{new Date(backup.created_at).toLocaleString(getLocale() === 'de' ? 'de-CH' : 'en-US', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
						<div class="flex items-center gap-2">
							{#if backup.encrypted}
								<span class="text-xs rounded-[var(--radius-sm)] bg-success/15 text-success px-1.5 py-0.5">{t('backups.encrypted')}</span>
							{/if}
							<span class="text-xs text-text-muted">{backup.files.length} {t('backups.files')}</span>
						</div>
					</div>
					<div class="flex items-center justify-between mt-1.5">
						<div class="flex gap-2 text-xs text-text-subtle">
							<span>v{backup.version}</span>
							<span>{formatSize(backup.files.reduce((s, f) => s + (f.size_bytes ?? 0), 0))}</span>
						</div>
						{#if confirmRestore === backup.backup_id}
							<div class="flex items-center gap-2">
								<span class="text-xs text-warning">{t('backups.restore_confirm')}</span>
								<button
									onclick={() => restoreBackup(backup.backup_id)}
									disabled={restoring !== null}
									class="rounded-[var(--radius-sm)] bg-warning/15 border border-warning/30 px-2 py-0.5 text-xs text-warning hover:bg-warning/25 disabled:opacity-50"
								>
									{restoring === backup.backup_id ? t('backups.restoring') : t('backups.restore')}
								</button>
								<button
									onclick={() => confirmRestore = null}
									class="rounded-[var(--radius-sm)] border border-border px-2 py-0.5 text-xs text-text-muted hover:text-text"
								>
									{t('backups.cancel')}
								</button>
							</div>
						{:else}
							<button
								onclick={() => confirmRestore = backup.backup_id}
								disabled={restoring !== null}
								class="rounded-[var(--radius-sm)] border border-border px-2 py-0.5 text-xs text-text-muted hover:text-text hover:border-border-hover transition-all disabled:opacity-50"
							>
								{t('backups.restore')}
							</button>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}

	<!-- Backup Settings -->
	{#if !configLoading}
		<h2 class="text-xs font-mono uppercase tracking-widest text-text-subtle mt-8 mb-3">{t('backups.settings')}</h2>

		<div class="space-y-4">
			<div class={cardClass}>
				<label for="backup-schedule" class="block text-sm font-medium mb-1">{t('config.backup_schedule')}</label>
				<p class="text-xs text-text-muted mb-2">{t('config.backup_schedule_desc')}</p>
				<select id="backup-schedule"
					value={config.backup_schedule ?? ''}
					onchange={(e) => config.backup_schedule = (e.target as HTMLSelectElement).value || undefined}
					class={inputClass}>
					<option value="">{t('config.backup_off')}</option>
					<option value="0 3 * * *">{t('config.backup_daily')}</option>
					<option value="0 3 * * 1">{t('config.backup_weekly')}</option>
					<option value="0 3 1 * *">{t('config.backup_monthly')}</option>
				</select>
			</div>

			<div class={cardClass}>
				<label for="backup-retention" class="block text-sm font-medium mb-1">{t('config.backup_retention')}</label>
				<input id="backup-retention" type="number" min="1" placeholder="30"
					bind:value={config.backup_retention_days} class="{inputClass} font-mono" />
			</div>

			<div class="{cardClass} flex items-center justify-between">
				<div>
					<p class="text-sm font-medium">{t('config.backup_encrypt')}</p>
					<p class="text-xs text-text-muted mt-1">{t('config.backup_encrypt_desc')}</p>
				</div>
				<button onclick={() => config.backup_encrypt = !config.backup_encrypt} class="relative w-10 h-6 rounded-full transition-colors shrink-0 {config.backup_encrypt ? 'bg-accent' : 'bg-border'}" aria-label="Toggle"><span class="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform {config.backup_encrypt ? 'translate-x-4' : ''}"></span></button>
			</div>

			<div class="flex items-center gap-3 pt-2">
				<button
					onclick={saveConfig}
					disabled={saving}
					class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm font-medium text-text hover:opacity-90 disabled:opacity-50"
				>
					{saving ? t('settings.saving') : t('settings.save')}
				</button>
				{#if saved}
					<span class="text-sm text-success">{t('settings.saved')}</span>
				{/if}
			</div>
		</div>
	{/if}
</div>
