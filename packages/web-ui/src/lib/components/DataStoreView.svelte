<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';

	interface Collection { name: string; columns: { name: string; type: string }[]; recordCount: number; createdAt: string; updatedAt: string; }

	let collections = $state<Collection[]>([]);
	let loading = $state(true);
	let selectedCollection = $state<string | null>(null);
	let rows = $state<Record<string, unknown>[]>([]);
	let rowsLoading = $state(false);
	let total = $state(0);

	async function loadCollections() {
		loading = true;
		try {
			const res = await fetch(`${getApiBase()}/datastore/collections`);
			const data = (await res.json()) as { collections: Collection[] };
			collections = data.collections;
		} catch { /* */ }
		loading = false;
	}

	async function loadRows(collection: string) {
		selectedCollection = collection;
		rowsLoading = true;
		try {
			const res = await fetch(`${getApiBase()}/datastore/${encodeURIComponent(collection)}?limit=20`);
			const data = (await res.json()) as { rows: Record<string, unknown>[]; total: number };
			rows = data.rows;
			total = data.total;
		} catch { rows = []; total = 0; }
		rowsLoading = false;
	}

	$effect(() => { loadCollections(); });

	const selectedInfo = $derived(collections.find(c => c.name === selectedCollection));
	const columnNames = $derived(selectedInfo?.columns.map(c => c.name).filter(n => !n.startsWith('_')) ?? []);
</script>

<div class="p-6 max-w-5xl mx-auto">
	<a href="/app/settings" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('settings.back')}</a>
	<h1 class="text-xl font-light tracking-tight mb-4 mt-2">{t('data.title')}</h1>

	{#if loading}
		<p class="text-text-subtle text-sm">{t('common.loading')}</p>
	{:else if collections.length === 0}
		<p class="text-text-subtle text-sm">{t('data.no_collections')}</p>
	{:else}
		<!-- Collection tabs -->
		<div class="flex gap-2 mb-4 flex-wrap">
			{#each collections as col}
				<button onclick={() => loadRows(col.name)}
					class="rounded-[var(--radius-sm)] px-3 py-1.5 text-sm transition-all {selectedCollection === col.name ? 'bg-accent/10 text-accent-text border border-accent/30' : 'text-text-muted hover:text-text border border-transparent'}">
					{col.name} <span class="text-text-subtle">({col.recordCount} {t('data.rows')})</span>
				</button>
			{/each}
		</div>

		<!-- Table -->
		{#if selectedCollection}
			{#if rowsLoading}
				<p class="text-text-subtle text-sm">{t('common.loading')}</p>
			{:else if rows.length === 0}
				<p class="text-text-subtle text-sm">0 {t('data.rows')}</p>
			{:else}
				<div class="overflow-x-auto rounded-[var(--radius-md)] border border-border">
					<table class="w-full text-sm">
						<thead class="bg-bg-subtle border-b border-border">
							<tr>
								{#each columnNames as col}
									<th class="px-3 py-2 text-left text-xs font-mono text-text-subtle">{col}</th>
								{/each}
							</tr>
						</thead>
						<tbody>
							{#each rows as row}
								<tr class="border-b border-border hover:bg-bg-subtle/50">
									{#each columnNames as col}
										<td class="px-3 py-2 text-xs text-text-muted max-w-48 truncate">{String(row[col] ?? '')}</td>
									{/each}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				<p class="text-xs text-text-subtle mt-2">{rows.length} / {total} {t('data.rows')}</p>
			{/if}
		{/if}
	{/if}
</div>
