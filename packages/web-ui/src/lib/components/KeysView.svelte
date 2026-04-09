<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { clearError } from '../stores/chat.svelte.js';

	let names = $state<string[]>([]);
	let newName = $state('ANTHROPIC_API_KEY');
	let newValue = $state('');
	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');

	// Inline edit state
	let editingName = $state<string | null>(null);
	let editValue = $state('');
	let editSaving = $state(false);

	async function loadSecrets() {
		loading = true;
		error = '';
		try {
			const res = await fetch(`${getApiBase()}/secrets`);
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { names: string[] };
			names = data.names;
		} catch {
			error = t('common.load_failed');
		}
		loading = false;
	}

	async function saveSecret() {
		if (!newValue.trim()) return;
		saving = true;
		error = '';
		try {
			const res = await fetch(`${getApiBase()}/secrets/${encodeURIComponent(newName)}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: newValue })
			});
			if (!res.ok) throw new Error();
			newValue = '';
			clearError();
			await loadSecrets();
		} catch {
			error = t('common.save_failed');
		}
		saving = false;
	}

	function startEdit(name: string) {
		editingName = name;
		editValue = '';
	}

	function cancelEdit() {
		editingName = null;
		editValue = '';
	}

	async function commitEdit(name: string) {
		if (!editValue.trim()) return;
		editSaving = true;
		error = '';
		try {
			const res = await fetch(`${getApiBase()}/secrets/${encodeURIComponent(name)}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: editValue })
			});
			if (!res.ok) throw new Error();
			clearError();
			editingName = null;
			editValue = '';
		} catch {
			error = t('common.save_failed');
		}
		editSaving = false;
	}

	function onEditKeydown(e: KeyboardEvent, name: string) {
		if (e.key === 'Enter' && editValue.trim()) commitEdit(name);
		if (e.key === 'Escape') cancelEdit();
	}

	async function deleteSecret(name: string) {
		try {
			const res = await fetch(`${getApiBase()}/secrets/${encodeURIComponent(name)}`, { method: 'DELETE' });
			if (!res.ok) throw new Error();
			if (editingName === name) cancelEdit();
			await loadSecrets();
		} catch {
			error = t('common.save_failed');
		}
	}

	$effect(() => {
		loadSecrets();
	});
</script>

<div class="p-6 max-w-4xl mx-auto">
	<a href="/app/settings" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('settings.back')}</a>
	<h1 class="text-xl font-light tracking-tight mb-4 mt-2">{t('keys.title')}</h1>

	{#if error}
		<div class="rounded-[var(--radius-md)] bg-danger/10 border border-danger/20 px-4 py-3 text-sm text-danger mb-4">{error}</div>
	{/if}

	{#if loading}
		<p class="text-text-subtle text-sm mb-4">{t('common.loading')}</p>
	{:else if names.length > 0}
		<div class="space-y-2 mb-6">
			{#each names as name}
				<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle px-4 py-3">
					<div class="flex items-center justify-between">
						<span class="font-mono text-sm">{name}</span>
						<div class="flex items-center gap-2">
							{#if editingName !== name}
								<button
									onclick={() => startEdit(name)}
									class="text-xs text-accent-text hover:underline"
								>
									{t('keys.edit')}
								</button>
							{/if}
							<button
								onclick={() => deleteSecret(name)}
								class="text-xs text-danger hover:underline"
							>
								{t('settings.delete')}
							</button>
						</div>
					</div>
					{#if editingName === name}
						<div class="flex items-center gap-2 mt-2">
							<input
								type="password"
								bind:value={editValue}
								onkeydown={(e) => onEditKeydown(e, name)}
								placeholder={t('keys.new_value')}
								autocomplete="off"
								class="flex-1 rounded-[var(--radius-md)] border border-border bg-bg px-3 py-1.5 font-mono text-sm focus:border-accent focus:outline-none"
							/>
							<button
								onclick={() => commitEdit(name)}
								disabled={editSaving || !editValue.trim()}
								class="rounded-[var(--radius-sm)] bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
							>
								{editSaving ? t('settings.saving') : t('settings.save')}
							</button>
							<button
								onclick={cancelEdit}
								class="text-xs text-text-subtle hover:text-text"
							>
								{t('common.cancel')}
							</button>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{:else}
		<p class="text-text-subtle text-sm mb-4">{t('keys.no_keys')}</p>
	{/if}

	<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4 space-y-3">
		<h2 class="text-sm font-medium">{t('keys.add_title')}</h2>
		<div>
			<label for="name" class="block text-xs text-text-muted">{t('keys.name_label')}</label>
			<input
				id="name"
				bind:value={newName}
				class="mt-1 w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 font-mono text-sm focus:border-accent focus:outline-none"
			/>
		</div>
		<div>
			<label for="value" class="block text-xs text-text-muted">{t('keys.value_label')}</label>
			<input
				id="value"
				bind:value={newValue}
				type="password"
				placeholder="sk-ant-..."
				class="mt-1 w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 font-mono text-sm focus:border-accent focus:outline-none"
			/>
		</div>
		<button
			onclick={saveSecret}
			disabled={saving || !newValue.trim()}
			class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm font-medium text-text hover:opacity-90 disabled:opacity-50"
		>
			{saving ? t('settings.saving') : t('settings.save')}
		</button>
	</div>
</div>
