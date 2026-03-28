<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.js';

	let names = $state<string[]>([]);
	let newName = $state('ANTHROPIC_API_KEY');
	let newValue = $state('');
	let loading = $state(true);
	let saving = $state(false);

	async function loadSecrets() {
		loading = true;
		const res = await fetch(`${getApiBase()}/secrets`);
		const data = (await res.json()) as { names: string[] };
		names = data.names;
		loading = false;
	}

	async function saveSecret() {
		if (!newValue.trim()) return;
		saving = true;
		await fetch(`${getApiBase()}/secrets/${encodeURIComponent(newName)}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ value: newValue })
		});
		newValue = '';
		saving = false;
		await new Promise((r) => setTimeout(r, 3000));
		await loadSecrets();
	}

	async function deleteSecret(name: string) {
		await fetch(`${getApiBase()}/secrets/${encodeURIComponent(name)}`, { method: 'DELETE' });
		await new Promise((r) => setTimeout(r, 3000));
		await loadSecrets();
	}

	$effect(() => {
		loadSecrets();
	});
</script>

<div class="p-6 max-w-4xl mx-auto">
	<h1 class="text-xl font-bold mb-4">{t('keys.title')}</h1>

	{#if loading}
		<p class="text-text-subtle text-sm mb-4">{t('common.loading')}</p>
	{:else if names.length > 0}
		<div class="space-y-2 mb-6">
			{#each names as name}
				<div class="flex items-center justify-between rounded-lg border border-border bg-bg-subtle px-4 py-3">
					<span class="font-mono text-sm">{name}</span>
					<button
						onclick={() => deleteSecret(name)}
						class="text-xs text-danger hover:underline"
					>
						{t('settings.delete')}
					</button>
				</div>
			{/each}
		</div>
	{:else}
		<p class="text-text-subtle text-sm mb-4">{t('keys.no_keys')}</p>
	{/if}

	<div class="rounded-lg border border-border bg-bg-subtle p-4 space-y-3">
		<h2 class="text-sm font-medium">{t('keys.add_title')}</h2>
		<div>
			<label for="name" class="block text-xs text-text-muted">{t('keys.name_label')}</label>
			<input
				id="name"
				bind:value={newName}
				class="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 font-mono text-sm focus:border-accent focus:outline-none"
			/>
		</div>
		<div>
			<label for="value" class="block text-xs text-text-muted">{t('keys.value_label')}</label>
			<input
				id="value"
				bind:value={newValue}
				type="password"
				placeholder="sk-ant-..."
				class="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 font-mono text-sm focus:border-accent focus:outline-none"
			/>
		</div>
		<button
			onclick={saveSecret}
			disabled={saving || !newValue.trim()}
			class="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
		>
			{saving ? t('settings.saving') : t('settings.save')}
		</button>
	</div>
</div>
