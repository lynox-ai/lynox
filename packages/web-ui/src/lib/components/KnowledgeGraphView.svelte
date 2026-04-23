<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t, getLocale } from '../i18n.svelte.js';

	interface Entity { id: string; canonicalName: string; entityType: string; aliases: string[]; description: string; mentionCount: number; firstSeenAt: string; lastSeenAt: string; }
	interface Relation { fromEntityId: string; toEntityId: string; relationType: string; description: string; confidence: number; }
	interface GraphNode { entity: Entity; x: number; y: number; vx: number; vy: number; }
	interface GraphEdge { source: string; target: string; label: string; }

	const PAGE_SIZE = 50;

	let entities = $state<Entity[]>([]);
	let loading = $state(true);
	let loadingMore = $state(false);
	let hasMore = $state(false);
	let query = $state('');
	let typeFilter = $state('');
	let selected = $state<Entity | null>(null);
	let relations = $state<Relation[]>([]);
	let error = $state('');

	// Graph state
	let viewMode = $state<'list' | 'graph'>('list');
	let graphNodes = $state<GraphNode[]>([]);
	let graphEdges = $state<GraphEdge[]>([]);
	let graphLoading = $state(false);
	let hoveredNode = $state<string | null>(null);
	let svgEl: SVGSVGElement | undefined = $state(undefined);

	// Graph viewport
	const GRAPH_W = 800;
	const GRAPH_H = 600;
	const NODE_R = 24;

	// Escape closes the entity detail panel — matches the close button (line ~420).
	// Mobile audit flagged this as the one missing keyboard shortcut after
	// AppShell/MarkdownRenderer already got escape handlers.
	$effect(() => {
		function handleEscape(e: KeyboardEvent) {
			if (e.key === 'Escape' && selected) selected = null;
		}
		window.addEventListener('keydown', handleEscape);
		return () => window.removeEventListener('keydown', handleEscape);
	});

	async function loadEntities(append = false) {
		if (append) { loadingMore = true; } else { loading = true; }
		error = '';
		try {
			const offset = append ? entities.length : 0;
			const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
			if (offset > 0) params.set('offset', String(offset));
			if (query) params.set('q', query);
			if (typeFilter) params.set('type', typeFilter);
			const res = await fetch(`${getApiBase()}/kg/entities?${params}`);
			if (!res.ok) throw new Error(`${res.status}`);
			const data = (await res.json()) as { entities: Entity[] };
			if (append) {
				entities = [...entities, ...data.entities];
			} else {
				entities = data.entities;
			}
			hasMore = data.entities.length >= PAGE_SIZE;
		} catch { error = t('common.load_failed'); }
		loading = false;
		loadingMore = false;
	}

	async function selectEntity(e: Entity) {
		selected = e;
		try {
			const res = await fetch(`${getApiBase()}/kg/entities/${e.id}`);
			if (!res.ok) throw new Error(`${res.status}`);
			const data = (await res.json()) as { entity: Entity; relations: Relation[] };
			relations = data.relations;
		} catch { relations = []; }
	}

	async function loadGraph() {
		graphLoading = true;
		try {
			// Load top entities (by mention count)
			const res = await fetch(`${getApiBase()}/kg/entities?limit=30`);
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { entities: Entity[] };
			const ents = data.entities;

			// Fetch relations for each entity in parallel
			const relResults = await Promise.allSettled(
				ents.map(e => fetch(`${getApiBase()}/kg/entities/${e.id}`).then(r => r.ok ? r.json() as Promise<{ entity: Entity; relations: Relation[] }> : { entity: e, relations: [] }))
			);

			const allEdges = new Map<string, GraphEdge>();
			const entityIds = new Set(ents.map(e => e.id));

			for (const result of relResults) {
				if (result.status !== 'fulfilled') continue;
				const { relations: rels } = result.value;
				for (const rel of rels) {
					if (entityIds.has(rel.fromEntityId) && entityIds.has(rel.toEntityId)) {
						const key = `${rel.fromEntityId}-${rel.toEntityId}-${rel.relationType}`;
						if (!allEdges.has(key)) {
							allEdges.set(key, { source: rel.fromEntityId, target: rel.toEntityId, label: rel.relationType });
						}
					}
				}
			}

			// Layout: position nodes using simple force simulation
			const nodes: GraphNode[] = ents.map((entity, i) => {
				const angle = (2 * Math.PI * i) / ents.length;
				const radius = Math.min(GRAPH_W, GRAPH_H) * 0.35;
				return {
					entity,
					x: GRAPH_W / 2 + radius * Math.cos(angle),
					y: GRAPH_H / 2 + radius * Math.sin(angle),
					vx: 0,
					vy: 0,
				};
			});

			// Run a few iterations of force simulation for better layout
			const edges = [...allEdges.values()];
			for (let iter = 0; iter < 80; iter++) {
				const alpha = 0.3 * (1 - iter / 80);

				// Repulsion between all nodes
				for (let i = 0; i < nodes.length; i++) {
					for (let j = i + 1; j < nodes.length; j++) {
						const a = nodes[i]!;
						const b = nodes[j]!;
						let dx = b.x - a.x;
						let dy = b.y - a.y;
						const dist = Math.sqrt(dx * dx + dy * dy) || 1;
						const force = 2000 / (dist * dist);
						dx = (dx / dist) * force * alpha;
						dy = (dy / dist) * force * alpha;
						a.vx -= dx; a.vy -= dy;
						b.vx += dx; b.vy += dy;
					}
				}

				// Attraction along edges
				for (const edge of edges) {
					const a = nodes.find(n => n.entity.id === edge.source);
					const b = nodes.find(n => n.entity.id === edge.target);
					if (!a || !b) continue;
					let dx = b.x - a.x;
					let dy = b.y - a.y;
					const dist = Math.sqrt(dx * dx + dy * dy) || 1;
					const force = (dist - 120) * 0.01 * alpha;
					dx = (dx / dist) * force;
					dy = (dy / dist) * force;
					a.vx += dx; a.vy += dy;
					b.vx -= dx; b.vy -= dy;
				}

				// Center gravity
				for (const node of nodes) {
					node.vx += (GRAPH_W / 2 - node.x) * 0.005 * alpha;
					node.vy += (GRAPH_H / 2 - node.y) * 0.005 * alpha;
				}

				// Apply velocities with damping
				for (const node of nodes) {
					node.x += node.vx;
					node.y += node.vy;
					node.vx *= 0.7;
					node.vy *= 0.7;
					// Keep in bounds
					node.x = Math.max(NODE_R + 10, Math.min(GRAPH_W - NODE_R - 10, node.x));
					node.y = Math.max(NODE_R + 10, Math.min(GRAPH_H - NODE_R - 10, node.y));
				}
			}

			graphNodes = nodes;
			graphEdges = edges;
		} catch { error = t('common.load_failed'); }
		graphLoading = false;
	}

	function handleGraphNodeClick(entity: Entity) {
		selectEntity(entity);
	}

	// Dynamic type filters — derived from actual entities
	const availableTypes = $derived(() => {
		const typeCounts = new Map<string, number>();
		for (const e of entities) {
			typeCounts.set(e.entityType, (typeCounts.get(e.entityType) ?? 0) + 1);
		}
		return [...typeCounts.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([type]) => type);
	});

	const typeColors: Record<string, string> = {
		person: 'bg-accent/15 text-accent-text',
		organization: 'bg-success/15 text-success',
		project: 'bg-warning/15 text-warning',
		product: 'bg-[#f0abfc]/15 text-[#f0abfc]',
		concept: 'bg-bg-muted text-text-subtle',
		location: 'bg-[#67e8f9]/15 text-[#67e8f9]',
		collection: 'bg-bg-muted text-text-subtle',
	};

	const svgTypeColors: Record<string, string> = {
		person: '#818cf8',
		organization: '#34d399',
		project: '#fbbf24',
		product: '#f0abfc',
		concept: '#6b7280',
		location: '#67e8f9',
		collection: '#6b7280',
	};

	function typeColor(t: string): string {
		return typeColors[t] ?? 'bg-bg-muted text-text-muted';
	}

	function svgColor(t: string): string {
		return svgTypeColors[t] ?? '#6b7280';
	}

	$effect(() => { loadEntities(); });

	$effect(() => {
		if (viewMode === 'graph' && graphNodes.length === 0) loadGraph();
	});

	function handleSearch() { loadEntities(); }
</script>

<div class="p-6 max-w-5xl mx-auto">
	<div class="flex items-center justify-between mb-4">
		<h1 class="text-xl font-light tracking-tight">{t('kg.title')}</h1>
		<div class="flex gap-1 rounded-[var(--radius-sm)] border border-border p-0.5">
			<button
				class="px-2.5 py-1 text-xs rounded-[var(--radius-sm)] transition-colors {viewMode === 'list' ? 'bg-accent/10 text-accent-text' : 'text-text-muted hover:text-text'}"
				onclick={() => viewMode = 'list'}
			>
				{t('kg.list_view')}
			</button>
			<button
				class="px-2.5 py-1 text-xs rounded-[var(--radius-sm)] transition-colors {viewMode === 'graph' ? 'bg-accent/10 text-accent-text' : 'text-text-muted hover:text-text'}"
				onclick={() => viewMode = 'graph'}
			>
				{t('kg.graph_view')}
			</button>
		</div>
	</div>

	{#if error}
		<div class="rounded-[var(--radius-md)] bg-danger/10 border border-danger/20 px-4 py-3 text-sm text-danger mb-4">{error}</div>
	{/if}

	{#if viewMode === 'graph'}
		<!-- Graph Visualization -->
		{#if graphLoading}
			<div class="flex items-center justify-center h-[500px] text-text-subtle text-sm">{t('common.loading')}</div>
		{:else if graphNodes.length === 0}
			<div class="flex items-center justify-center h-[500px] text-text-subtle text-sm">{t('kg.no_entities')}</div>
		{:else}
			<div class="flex gap-4 relative">
				<div class="flex-1 min-w-0 rounded-[var(--radius-md)] border border-border bg-bg-subtle overflow-hidden">
					<svg
						bind:this={svgEl}
						viewBox="0 0 {GRAPH_W} {GRAPH_H}"
						class="w-full h-auto"
						style="max-height: 70vh;"
					>
						<!-- Edges -->
						{#each graphEdges as edge}
							{@const source = graphNodes.find(n => n.entity.id === edge.source)}
							{@const target = graphNodes.find(n => n.entity.id === edge.target)}
							{#if source && target}
								{@const isHighlighted = hoveredNode === edge.source || hoveredNode === edge.target}
								<line
									x1={source.x} y1={source.y}
									x2={target.x} y2={target.y}
									stroke={isHighlighted ? '#818cf8' : '#333'}
									stroke-width={isHighlighted ? 2 : 1}
									stroke-opacity={hoveredNode ? (isHighlighted ? 0.8 : 0.15) : 0.4}
								/>
								<!-- Edge label -->
								{#if isHighlighted}
									<text
										x={(source.x + target.x) / 2}
										y={(source.y + target.y) / 2 - 6}
										text-anchor="middle"
										fill="#818cf8"
										font-size="9"
										font-family="monospace"
									>{edge.label}</text>
								{/if}
							{/if}
						{/each}

						<!-- Nodes -->
						{#each graphNodes as node}
							{@const isHovered = hoveredNode === node.entity.id}
							{@const isConnected = hoveredNode && graphEdges.some(e => (e.source === hoveredNode && e.target === node.entity.id) || (e.target === hoveredNode && e.source === node.entity.id))}
							{@const dimmed = hoveredNode && !isHovered && !isConnected}
							<g
								class="cursor-pointer"
								role="button"
								tabindex="0"
								onclick={() => handleGraphNodeClick(node.entity)}
								onkeydown={(e) => { if (e.key === 'Enter') handleGraphNodeClick(node.entity); }}
								onmouseenter={() => hoveredNode = node.entity.id}
								onmouseleave={() => hoveredNode = null}
								onfocus={() => hoveredNode = node.entity.id}
								onblur={() => hoveredNode = null}
								opacity={dimmed ? 0.2 : 1}
							>
								<circle
									cx={node.x} cy={node.y}
									r={NODE_R * (isHovered ? 1.15 : 1)}
									fill={svgColor(node.entity.entityType)}
									fill-opacity={isHovered ? 0.3 : 0.15}
									stroke={svgColor(node.entity.entityType)}
									stroke-width={isHovered || selected?.id === node.entity.id ? 2 : 1}
									stroke-opacity={isHovered ? 1 : 0.5}
								/>
								<text
									x={node.x} y={node.y + 1}
									text-anchor="middle"
									dominant-baseline="middle"
									fill={svgColor(node.entity.entityType)}
									font-size={node.entity.canonicalName.length > 10 ? 8 : 10}
									font-weight="500"
								>
									{node.entity.canonicalName.length > 14 ? node.entity.canonicalName.slice(0, 12) + '...' : node.entity.canonicalName}
								</text>
								<text
									x={node.x} y={node.y + 14}
									text-anchor="middle"
									fill="#666"
									font-size="7"
									font-family="monospace"
								>{node.entity.entityType}</text>
							</g>
						{/each}
					</svg>
				</div>

				<!-- Detail panel (reused) -->
				{#if selected}
					{@render detailPanel()}
				{/if}
			</div>
		{/if}
	{:else}
		<!-- List View -->
		<!-- Search -->
		<div class="mb-3">
			<input bind:value={query} onkeydown={(e) => e.key === 'Enter' && handleSearch()} placeholder={t('kg.search')}
				class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-border-hover" />
		</div>

		<!-- Dynamic type filters -->
		<div class="flex gap-1.5 mb-4 flex-wrap">
			<button onclick={() => { typeFilter = ''; loadEntities(); }}
				class="rounded-full px-3 py-1 text-xs transition-all {typeFilter === '' ? 'bg-accent/10 text-accent-text border border-accent/30' : 'text-text-muted hover:text-text border border-transparent'}">
				{t('kg.all')}
			</button>
			{#each availableTypes() as typ}
				<button onclick={() => { typeFilter = typ; loadEntities(); }}
					class="rounded-full px-3 py-1 text-xs transition-all {typeFilter === typ ? typeColor(typ).replace(/\/15/g, '/20') + ' border border-current/30' : 'text-text-muted hover:text-text border border-transparent'}">
					<span class="inline-block h-1.5 w-1.5 rounded-full mr-1 {typeColor(typ).split(' ')[0] ?? 'bg-text-subtle'}"></span>{typ}
				</button>
			{/each}
		</div>

		{#if loading}
			<p class="text-text-subtle text-sm">{t('common.loading')}</p>
		{:else if entities.length === 0}
			<p class="text-text-subtle text-sm">{t('kg.no_entities')}</p>
		{:else}
			<div class="flex gap-4">
				<!-- Entity List -->
				<div class="flex-1 min-w-0">
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

					<!-- Load more + count -->
					<div class="mt-3 flex items-center justify-between">
						<span class="text-xs text-text-subtle">{t('kg.showing')} {entities.length}</span>
						{#if hasMore}
							<button onclick={() => loadEntities(true)} disabled={loadingMore}
								class="text-xs text-accent-text hover:underline disabled:opacity-50">
								{loadingMore ? t('common.loading') : t('kg.load_more')}
							</button>
						{/if}
					</div>
				</div>

				<!-- Entity Detail Panel -->
				{#if selected}
					{@render detailPanel()}
				{/if}
			</div>
		{/if}
	{/if}
</div>

{#snippet detailPanel()}
	<!-- Mobile: full-width overlay; Desktop: sticky sidebar -->
	<div class="fixed inset-0 z-40 bg-bg/95 p-4 overflow-y-auto md:static md:inset-auto md:z-auto md:bg-bg-subtle md:w-80 md:shrink-0 md:rounded-[var(--radius-md)] md:border md:border-border md:p-4 md:self-start md:sticky md:top-4 md:max-h-[calc(100vh-12rem)] md:overflow-y-auto scrollbar-thin" style="padding-top: calc(1rem + env(safe-area-inset-top, 0px));">
		<!-- Header -->
		<div class="flex items-start justify-between gap-2">
			<div>
				<h2 class="text-lg font-medium mb-1">{selected!.canonicalName}</h2>
				<span class="text-xs rounded-full px-2.5 py-0.5 font-mono {typeColor(selected!.entityType)}">{selected!.entityType}</span>
			</div>
			<button onclick={() => { selected = null; }} class="shrink-0 p-1.5 rounded text-text-subtle hover:text-text hover:bg-bg-muted transition-colors" aria-label="Close">
				<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
			</button>
		</div>

		{#if selected!.description}
			<p class="text-sm text-text-muted leading-relaxed">{selected!.description}</p>
		{/if}

		<!-- Aliases -->
		{#if selected!.aliases.length > 0}
			<div>
				<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle mb-1.5">{t('kg.aliases')}</p>
				<div class="flex flex-wrap gap-1">
					{#each selected!.aliases as alias}
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
			<p>{t('kg.first_seen')}: {new Date(selected!.firstSeenAt).toLocaleDateString(getLocale() === 'de' ? 'de-CH' : 'en-US')}</p>
			<p>{selected!.mentionCount}× {t('kg.mentions')}</p>
		</div>
	</div>
{/snippet}
