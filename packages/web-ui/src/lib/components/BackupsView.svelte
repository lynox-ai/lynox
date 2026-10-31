<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { saveFailedText, throwIfRefused } from '../api/save-refusal.js';
	import { t, tf, getLocale } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';
	import { pickBackupConfig, fetchBackupConfig, requestRestore, retentionChangeFromNever, type BackupConfigFields } from '../backup-config.js';
	import { backupCoverageNotice, type BackupCoverageFields } from '../backup-coverage.js';
	import { isManaged, loadManagedStatus } from '../stores/integrations/managed.svelte.js';

	interface Backup extends BackupCoverageFields { backup_id: string; version: string; created_at: string; encrypted: boolean; files: { path: string; size_bytes: number }[]; checksum: string; }

	type Config = BackupConfigFields;

	let backups = $state<Backup[]>([]);
	let loading = $state(true);
	let creating = $state(false);
	let restoring = $state<string | null>(null);
	let confirmRestore = $state<string | null>(null);
	/** A restore the engine refused for want of a proof of origin, with its reason, awaiting a second yes. */
	let unverified = $state<{ id: string; reason: string; mismatch: boolean } | null>(null);
	let error = $state('');

	// Backup settings (loaded from config)
	let config = $state<Config>({});
	let configLoading = $state(true);
	let configError = $state('');
	let saving = $state(false);
	let saved = $state(false);
	// A stored retention of 0 ("never delete") can no longer be chosen, but stays until the user
	// picks a number of days (see retentionChangeFromNever). While it is stored, the view says so
	// and offers an empty field for days; the stored 0 itself is re-sent unchanged on every save.
	let neverDelete = $state(false);
	let newDays = $state<number | null>(null);
	/** Days the user entered from "never delete", awaiting the yes that older backups go. */
	let confirmDays = $state<number | null>(null);
	let retentionInput = $state<HTMLInputElement>();

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
		configError = '';
		// Both directions go through pickBackupConfig (see backup-config.ts). On a failed read the
		// form stays hidden: shown with defaults, a save would overwrite the real settings.
		const loaded = await fetchBackupConfig(getApiBase());
		if (loaded) {
			config = loaded;
			neverDelete = loaded.backup_retention_days === 0;
		} else configError = t('common.load_failed');
		configLoading = false;
	}

	async function saveConfig(): Promise<boolean> {
		let ok = false;
		saving = true;
		try {
			// Send ONLY the three backup fields — schema is `.strict()`, so any
			// stray response-only field from GET would 400 the whole save.
			const payload: Config = pickBackupConfig(config);
			const res = await fetch(`${getApiBase()}/config`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});
			await throwIfRefused(res);
			ok = true;
			saved = true;
			setTimeout(() => (saved = false), 2000);
		} catch (e) {
			addToast(saveFailedText(e, t('common.save_failed')), 'error');
		}
		saving = false;
		return ok;
	}

	function onSave() {
		if (neverDelete) {
			const change = retentionChangeFromNever(newDays, retentionInput?.validity.badInput === true);
			if (change.kind === 'invalid') { retentionInput?.reportValidity(); return; }
			if (change.kind === 'confirm') { confirmDays = change.days; return; }
		}
		void saveConfig();
	}

	async function applyRetention() {
		if (confirmDays === null) return;
		config.backup_retention_days = confirmDays;
		if (await saveConfig()) {
			neverDelete = false;
			newDays = null;
			confirmDays = null;
		} else {
			// Not saved: the engine still holds 0, so the view goes on showing it.
			config.backup_retention_days = 0;
		}
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

	async function restoreBackup(backupId: string, allowUnverified = false) {
		restoring = backupId;
		try {
			const outcome = await requestRestore(getApiBase(), backupId, allowUnverified);
			unverified = null;
			if (outcome.kind === 'restored') {
				addToast(t('backups.restore_success'), 'success', 6000);
			} else if (outcome.kind === 'ask') {
				unverified = { id: backupId, reason: outcome.reason, mismatch: outcome.mismatch };
			} else {
				addToast(outcome.error ?? t('backups.restore_failed'), 'error', 6000);
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

	$effect(() => { void loadBackups(); /* catches and sets its error */ void loadConfig(); /* never rejects; a failed read hides the settings and shows an error */ void loadManagedStatus(); /* never rejects; picks the way out a coverage notice names */ });

	const inputClass = 'w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm focus:border-accent focus:outline-none';
	const cardClass = 'rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4';
</script>

<div class="p-6 max-w-4xl mx-auto">
	<a href="/app/settings" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('settings.back')}</a>
	<div class="flex items-center justify-between mb-4 mt-2">
		<h1 class="text-xl font-light tracking-tight">{t('backups.title')}</h1>
		<button onclick={createBackup} disabled={creating}
			class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90 disabled:opacity-50">
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
				{@const coverage = backupCoverageNotice(backup, isManaged())}
				<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle px-4 py-3">
					<div class="flex items-center justify-between">
						<span class="text-sm font-mono">{new Date(backup.created_at).toLocaleString(getLocale() === 'de' ? 'de-CH' : 'en-US', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
						<div class="flex items-center gap-2">
							{#if backup.encrypted}
								<span class="text-xs rounded-[var(--radius-sm)] bg-success/15 text-success px-1.5 py-0.5">{t('backups.encrypted')}</span>
							{/if}
							{#if coverage}
								<span data-testid="backup-coverage-badge" class="text-xs rounded-[var(--radius-sm)] px-1.5 py-0.5 {coverage.tone === 'warning' ? 'bg-warning/15 text-warning' : 'bg-border text-text-muted'}">{t(coverage.badge)}</span>
							{/if}
							<span class="text-xs text-text-muted">{backup.files.length} {t('backups.files')}</span>
						</div>
					</div>
					{#if coverage}
						<p data-testid="backup-coverage-line" class="mt-1.5 text-xs {coverage.tone === 'warning' ? 'text-warning' : 'text-text-muted'}">{coverage.lines.map((key) => t(key)).join(' ')}</p>
					{/if}
					<div class="flex items-center justify-between mt-1.5">
						<div class="flex gap-2 text-xs text-text-subtle">
							<span>v{backup.version}</span>
							<span>{formatSize(backup.files.reduce((s, f) => s + (f.size_bytes ?? 0), 0))}</span>
						</div>
						{#if unverified?.id === backup.backup_id}
							<div class="flex flex-col items-end gap-1.5">
								<span class="text-xs text-warning">{t(unverified.mismatch ? 'backups.restore_mismatch' : 'backups.restore_unverified')}</span>
								<div class="flex items-center gap-2">
									<button
										onclick={() => restoreBackup(backup.backup_id, true)}
										disabled={restoring !== null}
										class="rounded-[var(--radius-sm)] bg-warning/15 border border-warning/30 px-2 py-0.5 text-xs text-warning hover:bg-warning/25 disabled:opacity-50"
									>
										{restoring === backup.backup_id ? t('backups.restoring') : t(unverified.mismatch ? 'backups.restore_anyway' : 'backups.restore_unverified_confirm')}
									</button>
									<button
										onclick={() => unverified = null}
										class="rounded-[var(--radius-sm)] border border-border px-2 py-0.5 text-xs text-text-muted hover:text-text"
									>
										{t('backups.cancel')}
									</button>
								</div>
							</div>
						{:else if confirmRestore === backup.backup_id}
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
	{#if configError}
		<p role="alert" class="mt-8 text-sm text-danger">{configError}</p>
	{:else if !configLoading}
		<h2 class="text-xs font-mono uppercase tracking-widest text-text-subtle mt-8 mb-3">{t('backups.settings')}</h2>

		<div class="space-y-4">

			<div class={cardClass}>
				<label for="backup-retention" class="block text-sm font-medium mb-1">{t('config.backup_retention')}</label>
				{#if neverDelete}
					<p id="backup-retention-never" class="text-xs text-text-muted mb-2">{t('backups.retention_never')}</p>
					<input id="backup-retention" type="number" min="1" max="365" step="1" placeholder="30" aria-describedby="backup-retention-never"
						bind:this={retentionInput} bind:value={newDays} oninput={() => (confirmDays = null)} class="{inputClass} font-mono" />
					<!-- Present for as long as the field is, so the confirmation is announced when its text
					     appears: a live region inserted together with its text often is not. -->
					<span role="status" class="block text-xs text-warning">{#if confirmDays !== null}<span class="block mt-2">{tf('backups.retention_confirm', { days: String(confirmDays) })}</span>{/if}</span>
					{#if confirmDays !== null}
						<div class="mt-2 flex flex-col gap-2">
							<div class="flex items-center gap-2">
								<button
									onclick={applyRetention}
									disabled={saving}
									class="rounded-[var(--radius-sm)] bg-warning/15 border border-warning/30 px-2 py-0.5 text-xs text-warning hover:bg-warning/25 disabled:opacity-50"
								>
									{t('backups.retention_apply')}
								</button>
								<button
									onclick={() => (confirmDays = null)}
									class="rounded-[var(--radius-sm)] border border-border px-2 py-0.5 text-xs text-text-muted hover:text-text"
								>
									{t('backups.cancel')}
								</button>
							</div>
						</div>
					{/if}
				{:else}
					<input id="backup-retention" type="number" min="1" placeholder="30"
						bind:value={config.backup_retention_days} class="{inputClass} font-mono" />
				{/if}
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
					onclick={onSave}
					disabled={saving}
					class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm font-medium text-accent-fg hover:opacity-90 disabled:opacity-50"
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
