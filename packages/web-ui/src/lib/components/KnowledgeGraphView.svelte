<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t, getLocale } from '../i18n.svelte.js';

	interface Entity { id: string; canonicalName: string; entityType: string; aliases: string[]; description: string; mentionCount: number; firstSeenAt: string; lastSeenAt: string; }
	interface Relation { fromEntityId: string; toEntityId: string; relationType: string; description: string; confidence: number; }

	let entities = $state<Entity[]>([]);
	let loading = $state(true);
	let query = $state('');
	let typeFilter = $state('');
	let selected = $state<Entity | null>(null);
	let relations = $state<Relation[]>([]);
	let error = $state('');

	async function loadEntities() {
		loading = true; error = '';
		try {
			const params = new URLSearchParams({ limit: '50' });
			if (query) params.set('q', query);
			if (typeFilter) params.set('type', typeFilter);
			const res = await fetch(`${getApiBase()}/kg/entities?${params}`);
			const data = (await res.json()) as { entities: Entity[] };
			entities = data.entities;
		} catch { error = t('common.load_failed'); }
		loading = false;
	}

	async function selectEntity(e: Entity) {
		selected = e;
		try {
			const res = await fetch(`${getApiBase()}/kg/entities/${e.id}`);
			const data = (await res.json()) as { entity: Entity; relations: Relation[] };
			relations = data.relations;
		} catch { relations = []; }
	}

	const types = [
		{ value: '', labelKey: 'kg.all' },
		{ value: 'person', labelKey: 'kg.people' },
		{ value: 'organization', labelKey: 'kg.orgs' },
		{ value: 'project', labelKey: 'kg.projects' },
	];

	const typeColors: Record<string, string> = {
		person: 'bg-accent/15 text-accent-text',
		organization: 'bg-success/15 text-success',
		project: 'bg-warning/15 text-warning',
		product: 'bg-[#f0abfc]/15 text-[#f0abfc]',
		concept: 'bg-bg-muted text-text-subtle',
		location: 'bg-[#67e8f9]/15 text-[#67e8f9]',
		collection: 'bg-bg-muted text-text-subtle',
	};

	function typeColor(t: string): string {
		return typeColors[t] ?? 'bg-bg-muted text-text-muted';
	}

	$effect(() => { loadEntities(); });

	function handleSearch() { loadEntities(); }
</script>

<div class="p-6 max-w-5xl mx-auto">
	<h1 class="text-xl font-light tracking-tight mb-4">{t('kg.title')}</h1>

	<!-- Search + Filters -->
	<div class="flex gap-2 mb-4 flex-wrap">
		<input bind:value={query} onkeydown={(e) => e.key === 'Enter' && handleSearch()} placeholder={t('kg.search')}
			class="flex-1 min-w-48 rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-border-hover" />
		{#each types as tp}
			<button onclick={() => { typeFilter = tp.value; loadEntities(); }}
				class="rounded-[var(--radius-sm)] px-3 py-1.5 text-sm transition-all {typeFilter === tp.value ? 'bg-accent/10 text-accent-text border border-accent/30' : 'text-text-muted hover:text-text border border-transparent'}">
				{t(tp.labelKey)}
			</button>
		{/each}
	</div>

	{#if error}
		<div class="rounded-[var(--radius-md)] bg-danger/10 border border-danger/20 px-4 py-3 text-sm text-danger mb-4">{error}</div>
	{/if}

	<div class="flex gap-4">
		<!-- Entity List -->
		<div class="flex-1 min-w-0">
			{#if loading}
				<p class="text-text-subtle text-sm">{t('common.loading')}</p>
			{:else if entities.length === 0}
				<p class="text-text-subtle text-sm">{t('kg.no_entities')}</p>
			{:else}
				<div class="space-y-1">
					{#each entities as entity}
						<button onclick={() => selectEntity(entity)}
							class="w-full text-left rounded-[var(--radius-md)] border px-4 py-2.5 transition-all flex items-center gap-3 {selected?.id === entity.id ? 'border-accent/30 bg-accent/5' : 'border-border bg-bg-subtle hover:border-border-hover'}">
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2">
									<span class="text-sm font-medium truncate">{entity.canonicalName}</span>
									<span class="shrink-0 text-[10px] rounded-full px-2 py-0.5 font-mono {typeColor(entity.entityType)}">{entity.entityType}</span>
								</div>
								{#if entity.description}
									<p class="text-xs text-text-muted mt-0.5 truncate">{entity.description}</p>
								{/if}
							</div>
							<span class="shrink-0 text-xs text-text-subtle tabular-nums">{entity.mentionCount}×</span>
						</button>
					{/each}
				</div>
			{/if}
		</div>

		<!-- Entity Detail Panel -->
		{#if selected}
			<div class="w-80 shrink-0 rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4 space-y-4 self-start sticky top-4 max-h-[calc(100vh-12rem)] overflow-y-auto scrollbar-thin">
				<!-- Header -->
				<div>
					<h2 class="text-lg font-medium mb-1">{selected.canonicalName}</h2>
					<span class="text-xs rounded-full px-2.5 py-0.5 font-mono {typeColor(selected.entityType)}">{selected.entityType}</span>
				</div>

				{#if selected.description}
					<p class="text-sm text-text-muted leading-relaxed">{selected.description}</p>
				{/if}

				<!-- Aliases -->
				{#if selected.aliases.length > 0}
					<div>
						<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle mb-1.5">{t('kg.aliases')}</p>
						<div class="flex flex-wrap gap-1">
							{#each selected.aliases as alias}
								<span class="rounded-[var(--radius-sm)] bg-bg-muted px-2 py-0.5 text-xs text-text-muted">{alias}</span>
							{/each}
						</div>
					</div>
				{/if}

				<!-- Relations -->
				{#if relations.length > 0}
					<div>
						<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle mb-1.5">{t('kg.relations')} ({relations.length})</p>
						<div class="space-y-1.5">
							{#each relations as rel}
								<div class="rounded-[var(--radius-sm)] bg-bg-muted px-2.5 py-1.5 text-xs">
									<span class="text-accent-text font-medium">{rel.relationType}</span>
									{#if rel.description}
										<span class="text-text-muted"> — {rel.description}</span>
									{/if}
								</div>
							{/each}
						</div>
					</div>
				{/if}

				<!-- Meta -->
				<div class="border-t border-border pt-3 space-y-1 text-xs text-text-subtle">
					<p>{t('kg.first_seen')}: {new Date(selected.firstSeenAt).toLocaleDateString(getLocale() === 'de' ? 'de-CH' : 'en-US')}</p>
					<p>{selected.mentionCount}× {t('kg.mentions')}</p>
				</div>
			</div>
		{/if}
	</div>
</div>
