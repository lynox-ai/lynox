<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { formatCost } from '../format.js';
	import MarkdownRenderer from './MarkdownRenderer.svelte';
	import { t, getLocale } from '../i18n.svelte.js';
	import { unarchiveThread } from '../stores/threads.svelte.js';

	interface RunRecord {
		id: string;
		session_id: string;
		task_text: string;
		response_text: string;
		status: string;
		cost_usd: number;
		duration_ms: number;
		model_id: string;
		tokens_in: number;
		tokens_out: number;
		tokens_cache_read: number;
		tokens_cache_write: number;
		user_wait_ms: number;
		created_at: string;
		run_type?: string;
		spawn_depth?: number;
		batch_parent_id?: string;
		spawn_parent_id?: string;
	}

	interface ThreadInfo {
		id: string;
		title: string;
		is_archived: number;
		updated_at: string;
	}

	interface ToolCall {
		tool_name: string;
		input_json: string;
		output_json: string;
		duration_ms: number;
	}

	interface CostDay {
		day: string;
		cost_usd: number;
		run_count: number;
	}

	let { onrerun }: { onrerun?: (task: string) => void } = $props();

	let runs = $state<RunRecord[]>([]);
	let loading = $state(true);
	let loadingMore = $state(false);
	let expandedRun = $state<string | null>(null);
	let toolCalls = $state<ToolCall[]>([]);
	let toolCallsLoading = $state(false);
	let toolCallsError = $state(false);
	let expandedInputs = $state<Set<number>>(new Set());
	let writtenFiles = $derived(
		toolCalls
			.filter((tc) => tc.tool_name === 'write_file')
			.map((tc) => {
				try {
					const p = JSON.parse(tc.input_json) as Record<string, unknown>;
					return String(p['path'] ?? p['file_path'] ?? '');
				} catch {
					return '';
				}
			})
			.filter(Boolean)
	);
	interface ModelBreakdownEntry {
		model_id: string;
		cost_usd: number;
		run_count: number;
		tokens_in: number;
		tokens_out: number;
		tokens_cache_read: number;
		tokens_cache_write: number;
	}
	let stats = $state<{
		total_runs?: number;
		total_cost_usd?: number;
		avg_duration_ms?: number;
		cost_by_model?: ModelBreakdownEntry[];
	} | null>(null);
	let hasMore = $state(true);
	let error = $state('');
	const PAGE_SIZE = 50;

	// Search & filters
	let searchQuery = $state('');
	let searchDebounce: ReturnType<typeof setTimeout> | undefined;
	let filterStatus = $state('');
	let filterModel = $state('');
	let filterDateFrom = $state('');
	let filterDateTo = $state('');

	// Threads (for grouping)
	let threads = $state<ThreadInfo[]>([]);
	let hasMoreThreads = $state(true);
	let expandedThreads = $state<Set<string>>(new Set());

	// Cost chart
	let costData = $state<CostDay[]>([]);
	let showCostChart = $state(false);

	// Model breakdown panel
	let showModelBreakdown = $state(false);

	/** Map a raw model_id to a display label and provider tag. */
	function prettyModel(id: string): { label: string; provider: string; tone: 'anthropic' | 'mistral' | 'openai' | 'other' } {
		const lower = id.toLowerCase();
		if (lower.startsWith('claude-opus'))   return { label: id.replace(/claude-opus-(\d)-(\d).*/, 'Claude Opus $1.$2'), provider: 'Anthropic', tone: 'anthropic' };
		if (lower.startsWith('claude-sonnet')) return { label: id.replace(/claude-sonnet-(\d)-(\d).*/, 'Claude Sonnet $1.$2'), provider: 'Anthropic', tone: 'anthropic' };
		if (lower.startsWith('claude-haiku'))  return { label: id.replace(/claude-haiku-(\d)-(\d).*/, 'Claude Haiku $1.$2'), provider: 'Anthropic', tone: 'anthropic' };
		if (lower.startsWith('claude-'))       return { label: id, provider: 'Anthropic', tone: 'anthropic' };
		if (lower.startsWith('mistral'))       return { label: id.replace(/^mistral-/, 'Mistral ').replace(/-latest$/, ''), provider: 'Mistral', tone: 'mistral' };
		if (lower.includes('gpt-'))            return { label: id, provider: 'OpenAI-compatible', tone: 'openai' };
		return { label: id || 'unknown', provider: '—', tone: 'other' };
	}

	function toneClasses(tone: 'anthropic' | 'mistral' | 'openai' | 'other'): string {
		switch (tone) {
			case 'anthropic': return 'bg-accent/15 text-accent-text border-accent/30';
			case 'mistral':   return 'bg-warning/15 text-warning border-warning/30';
			case 'openai':    return 'bg-success/15 text-success border-success/30';
			default:          return 'bg-text-subtle/15 text-text-subtle border-border';
		}
	}

	// Available models for filter (derived from stats)
	let availableModels = $derived(stats?.cost_by_model?.map((m) => m.model_id) ?? []);

	// Group runs by thread
	interface ThreadGroup {
		threadId: string;
		title: string;
		isArchived: boolean;
		runs: RunRecord[];
		totalCost: number;
		lastActivity: string;
	}

	const groupedRuns = $derived.by(() => {
		if (searchQuery.trim()) return null; // flat list during search
		const threadMap = new Map<string, ThreadInfo>();
		for (const th of threads) threadMap.set(th.id, th);

		const groups = new Map<string, RunRecord[]>();
		for (const run of runs) {
			const key = run.session_id || '_orphan';
			const arr = groups.get(key);
			if (arr) arr.push(run);
			else groups.set(key, [run]);
		}

		const result: ThreadGroup[] = [];
		for (const [threadId, threadRuns] of groups) {
			const th = threadMap.get(threadId);
			result.push({
				threadId,
				title: th?.title || (threadId === '_orphan' ? t('history.ungrouped') : threadRuns[0]?.task_text?.slice(0, 50) || threadId.slice(0, 8)),
				isArchived: (th?.is_archived ?? 0) === 1,
				runs: threadRuns,
				totalCost: threadRuns.reduce((s, r) => s + r.cost_usd, 0),
				lastActivity: threadRuns[0]?.created_at ?? '',
			});
		}
		return result;
	});

	function buildQueryParams(offset = 0): string {
		const params = new URLSearchParams();
		params.set('limit', String(PAGE_SIZE));
		params.set('offset', String(offset));
		if (searchQuery.trim()) params.set('q', searchQuery.trim());
		if (!searchQuery.trim()) {
			if (filterStatus) params.set('status', filterStatus);
			if (filterModel) params.set('model', filterModel);
			if (filterDateFrom) params.set('dateFrom', filterDateFrom);
			if (filterDateTo) params.set('dateTo', filterDateTo);
		}
		return params.toString();
	}

	async function loadRuns() {
		loading = true;
		error = '';
		try {
			const [runsRes, statsRes, threadsRes] = await Promise.all([
				fetch(`${getApiBase()}/history/runs?${buildQueryParams()}`),
				fetch(`${getApiBase()}/history/stats`),
				fetch(`${getApiBase()}/threads?limit=50&includeArchived=true`),
			]);
			if (!runsRes.ok) throw new Error();
			const runsData = (await runsRes.json()) as { runs: RunRecord[] };
			runs = runsData.runs;
			hasMore = runsData.runs.length >= PAGE_SIZE;
			stats = (await statsRes.json()) as typeof stats;
			if (threadsRes.ok) {
				const td = (await threadsRes.json()) as { threads: ThreadInfo[] };
				threads = td.threads;
				hasMoreThreads = td.threads.length >= 50;
			}
		} catch {
			error = t('common.load_failed');
		}
		loading = false;
	}

	async function loadMore() {
		if (!hasMore || loadingMore) return;
		loadingMore = true;
		try {
			const offset = runs.length;
			const res = await fetch(`${getApiBase()}/history/runs?${buildQueryParams(offset)}`);
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { runs: RunRecord[] };
			runs = [...runs, ...data.runs];
			hasMore = data.runs.length >= PAGE_SIZE;
		} catch {
			error = t('common.load_failed');
		}
		loadingMore = false;
	}

	async function loadMoreThreads() {
		if (!hasMoreThreads) return;
		try {
			const res = await fetch(`${getApiBase()}/threads?limit=50&offset=${threads.length}&includeArchived=true`);
			if (!res.ok) return;
			const data = (await res.json()) as { threads: ThreadInfo[] };
			threads = [...threads, ...data.threads];
			hasMoreThreads = data.threads.length >= 50;
		} catch { /* silently fail */ }
	}

	async function toggleRun(id: string) {
		if (expandedRun === id) {
			expandedRun = null;
			toolCalls = [];
			toolCallsError = false;
			expandedInputs = new Set();
			return;
		}
		expandedRun = id;
		toolCallsLoading = true;
		toolCallsError = false;
		expandedInputs = new Set();
		try {
			const res = await fetch(`${getApiBase()}/history/runs/${id}/tool-calls`);
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { toolCalls: ToolCall[] };
			toolCalls = data.toolCalls;
		} catch {
			toolCalls = [];
			toolCallsError = true;
		}
		toolCallsLoading = false;
	}

	async function loadCostChart() {
		showCostChart = !showCostChart;
		if (!showCostChart || costData.length > 0) return;
		try {
			const res = await fetch(`${getApiBase()}/history/cost/daily?days=30`);
			if (res.ok) costData = ((await res.json()) as CostDay[]);
		} catch {
			/* silently fail */
		}
	}

	function scrollToRun(id: string) {
		expandedRun = null;
		toolCalls = [];
		// Find run in list, if loaded
		const el = document.getElementById(`run-${id}`);
		if (el) {
			el.scrollIntoView({ behavior: 'smooth', block: 'center' });
			el.classList.add('ring-2', 'ring-accent');
			setTimeout(() => el.classList.remove('ring-2', 'ring-accent'), 2000);
		}
	}

	function handleSearch() {
		clearTimeout(searchDebounce);
		searchDebounce = setTimeout(() => loadRuns(), 300);
	}

	function handleFilterChange() {
		loadRuns();
	}

	function exportCSV() {
		const headers = ['Date', 'Task', 'Status', 'Model', 'Cost (USD)', 'Duration (s)', 'AI Time (s)', 'User Wait (s)', 'Tokens In', 'Tokens Out', 'Cache Read', 'Cache Write'];
		const csvRows = [headers.join(',')];
		for (const run of runs) {
			const userWait = run.user_wait_ms ?? 0;
			csvRows.push(
				[
					run.created_at,
					'"' + run.task_text.replace(/"/g, '""') + '"',
					run.status,
					run.model_id,
					run.cost_usd.toFixed(6),
					(run.duration_ms / 1000).toFixed(1),
					((run.duration_ms - userWait) / 1000).toFixed(1),
					(userWait / 1000).toFixed(1),
					run.tokens_in,
					run.tokens_out,
					run.tokens_cache_read ?? 0,
					run.tokens_cache_write ?? 0
				].join(',')
			);
		}
		const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `lynox-runs-${new Date().toISOString().slice(0, 10)}.csv`;
		a.click();
		URL.revokeObjectURL(url);
	}

	function highlightMatch(text: string, query: string): string {
		if (!query.trim()) return escapeHtml(text);
		const safeText = escapeHtml(text);
		const safeQuery = escapeHtml(query);
		const escaped = safeQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		return safeText.replace(new RegExp(`(${escaped})`, 'gi'), '<mark class="bg-accent/30 text-inherit rounded-sm px-0.5">$1</mark>');
	}

	function escapeHtml(str: string): string {
		return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	function formatDateTime(iso: string): string {
		const locale = getLocale() === 'de' ? 'de-CH' : 'en-US';
		return new Date(iso).toLocaleString(locale, {
			day: 'numeric',
			month: 'numeric',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function cachePercent(run: RunRecord): number {
		const cacheRead = run.tokens_cache_read ?? 0;
		const totalIn = run.tokens_in + cacheRead + (run.tokens_cache_write ?? 0);
		return totalIn > 0 ? Math.round((cacheRead / totalIn) * 100) : 0;
	}

	function costBarMax(data: CostDay[]): number {
		return Math.max(...data.map((d) => d.cost_usd), 0.01);
	}

	$effect(() => {
		loadRuns();
	});
</script>

<div class="p-6 max-w-4xl mx-auto">
	<!-- Header -->
	<div class="flex items-center justify-between mb-4">
		<h1 class="text-xl font-light tracking-tight">{t('history.title')}</h1>
		<div class="flex items-center gap-4">
			{#if stats}
				<div class="flex gap-4 text-xs text-text-muted">
					<span>{stats.total_runs ?? 0} {t('history.runs')}</span>
					<span>{formatCost(stats.total_cost_usd ?? 0)} {t('history.total')}</span>
					<span>{t('history.avg_duration')} {((stats.avg_duration_ms ?? 0) / 1000).toFixed(1)}s</span>
				</div>
			{/if}
			<div class="flex gap-2">
				<button
					onclick={loadCostChart}
					class="rounded-[var(--radius-md)] border border-border px-2.5 py-1 text-xs hover:text-text hover:border-border-hover transition-all {showCostChart ? 'bg-accent/10 text-accent-text' : 'text-text-muted'}"
				>
					{t('history.cost_chart')}
				</button>
				<button
					onclick={() => (showModelBreakdown = !showModelBreakdown)}
					class="rounded-[var(--radius-md)] border border-border px-2.5 py-1 text-xs hover:text-text hover:border-border-hover transition-all {showModelBreakdown ? 'bg-accent/10 text-accent-text' : 'text-text-muted'}"
				>
					{t('history.model_breakdown')}
				</button>
				<button
					onclick={exportCSV}
					class="rounded-[var(--radius-md)] border border-border px-2.5 py-1 text-xs text-text-muted hover:text-text hover:border-border-hover transition-all"
				>
					{t('history.export_csv')}
				</button>
			</div>
		</div>
	</div>

	<!-- Cost Chart -->
	{#if showCostChart}
		<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4 mb-4">
			{#if costData.length === 0}
				<p class="text-xs text-text-subtle">{t('history.no_cost_data')}</p>
			{:else}
				<div class="flex items-end gap-1 h-24">
					{#each costData.slice().reverse() as day (day.day)}
						{@const pct = (day.cost_usd / costBarMax(costData)) * 100}
						<div class="group flex-1 flex flex-col items-center justify-end h-full relative">
							<div
								class="w-full rounded-t-sm bg-accent/60 hover:bg-accent transition-colors min-h-[2px]"
								style="height: {Math.max(pct, 1)}%"
							></div>
							<div class="absolute bottom-full mb-1 hidden group-hover:block z-10 rounded bg-bg border border-border px-2 py-1 text-xs text-text whitespace-nowrap shadow-lg">
								{day.day}<br />{formatCost(day.cost_usd)} &middot; {day.run_count} runs
							</div>
						</div>
					{/each}
				</div>
				<div class="flex justify-between mt-1 text-xs md:text-[10px] text-text-subtle">
					<span>{costData[costData.length - 1]?.day}</span>
					<span>{costData[0]?.day}</span>
				</div>
			{/if}
		</div>
	{/if}

	<!-- Model Breakdown -->
	{#if showModelBreakdown}
		{@const breakdown = stats?.cost_by_model ?? []}
		{@const totalCost = breakdown.reduce((s, m) => s + m.cost_usd, 0)}
		<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4 mb-4">
			{#if breakdown.length === 0}
				<p class="text-xs text-text-subtle">{t('history.no_model_data')}</p>
			{:else}
				<div class="space-y-2">
					{#each breakdown as m (m.model_id)}
						{@const pretty = prettyModel(m.model_id)}
						{@const share = totalCost > 0 ? (m.cost_usd / totalCost) * 100 : 0}
						<div class="group">
							<div class="flex items-center justify-between gap-2 text-sm">
								<div class="flex items-center gap-2 min-w-0">
									<span class="inline-block text-[10px] px-1.5 py-0.5 rounded border {toneClasses(pretty.tone)} shrink-0">{pretty.provider}</span>
									<span class="text-text truncate" title={m.model_id}>{pretty.label}</span>
								</div>
								<div class="flex items-center gap-3 text-xs text-text-muted shrink-0 font-mono">
									<span>{m.run_count} {t('history.runs')}</span>
									<span class="text-text">{formatCost(m.cost_usd)}</span>
									<span class="w-10 text-right">{share.toFixed(1)}%</span>
								</div>
							</div>
							<div class="mt-1 h-1 rounded-full bg-border overflow-hidden">
								<div class="h-full bg-accent/60 rounded-full transition-all duration-500" style="width: {share}%"></div>
							</div>
							<div class="mt-1 flex gap-3 text-[10px] text-text-subtle font-mono">
								<span title={t('history.tokens_in')}>↓ {m.tokens_in.toLocaleString()}</span>
								<span title={t('history.tokens_out')}>↑ {m.tokens_out.toLocaleString()}</span>
								{#if m.tokens_cache_read > 0}
									<span title={t('history.tokens_cache_read')}>⚡ {m.tokens_cache_read.toLocaleString()}</span>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{/if}

	<!-- Search & Filters -->
	<div class="mb-4 space-y-2">
		<input
			type="text"
			placeholder={t('history.search')}
			bind:value={searchQuery}
			oninput={handleSearch}
			class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-1.5 text-sm text-text placeholder:text-text-subtle focus:outline-none focus:border-accent"
		/>
		<div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
			<div class="flex flex-col gap-1 min-w-0">
				<label for="history-filter-status" class="text-[10px] font-mono uppercase tracking-widest text-text-subtle">{t('history.filter_status')}</label>
				<select
					id="history-filter-status"
					bind:value={filterStatus}
					onchange={handleFilterChange}
					class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-2 py-1.5 text-xs text-text-muted focus:outline-none focus:border-accent"
				>
					<option value="">{t('history.all_statuses')}</option>
					<option value="completed">completed</option>
					<option value="failed">failed</option>
					<option value="running">running</option>
				</select>
			</div>
			{#if availableModels.length > 1}
				<div class="flex flex-col gap-1 min-w-0">
					<label for="history-filter-model" class="text-[10px] font-mono uppercase tracking-widest text-text-subtle">{t('history.filter_model')}</label>
					<select
						id="history-filter-model"
						bind:value={filterModel}
						onchange={handleFilterChange}
						class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-2 py-1.5 text-xs text-text-muted focus:outline-none focus:border-accent"
					>
						<option value="">{t('history.all_models')}</option>
						{#each availableModels as model}
							<option value={model}>{model}</option>
						{/each}
					</select>
				</div>
			{/if}
			<div class="flex flex-col gap-1 min-w-0">
				<label for="history-filter-from" class="text-[10px] font-mono uppercase tracking-widest text-text-subtle">{t('history.from')}</label>
				<input
					id="history-filter-from"
					type="date"
					bind:value={filterDateFrom}
					onchange={handleFilterChange}
					class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-2 py-1.5 text-xs text-text-muted focus:outline-none focus:border-accent"
				/>
			</div>
			<div class="flex flex-col gap-1 min-w-0">
				<label for="history-filter-to" class="text-[10px] font-mono uppercase tracking-widest text-text-subtle">{t('history.to')}</label>
				<input
					id="history-filter-to"
					type="date"
					bind:value={filterDateTo}
					onchange={handleFilterChange}
					class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-2 py-1.5 text-xs text-text-muted focus:outline-none focus:border-accent"
				/>
			</div>
		</div>
	</div>

	{#if error}
		<div class="rounded-[var(--radius-md)] bg-danger/10 border border-danger/20 px-4 py-3 text-sm text-danger mb-4">
			{error}
		</div>
	{/if}

	{#if loading}
		<p class="text-text-subtle text-sm">{t('common.loading')}</p>
	{:else if runs.length === 0}
		<p class="text-text-subtle text-sm">{t('history.no_runs')}</p>
	{:else if groupedRuns}
		<!-- Grouped by thread -->
		<div class="space-y-3">
			{#each groupedRuns as group (group.threadId)}
				<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle overflow-hidden">
					<!-- Thread header -->
					<div class="flex items-center">
						<button
							onclick={() => {
								const next = new Set(expandedThreads);
								if (next.has(group.threadId)) next.delete(group.threadId);
								else next.add(group.threadId);
								expandedThreads = next;
							}}
							class="flex-1 min-w-0 px-4 py-3 text-left hover:bg-bg-muted transition-colors flex items-center gap-3"
						>
							<span class="text-text-subtle text-xs shrink-0">{expandedThreads.has(group.threadId) ? '▾' : '▸'}</span>
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2">
									<span class="text-sm font-medium text-text truncate">{group.title}</span>
									{#if group.isArchived}
										<span class="text-[9px] uppercase tracking-widest text-text-subtle bg-bg-muted rounded px-1.5 py-0.5">{t('history.archived')}</span>
									{/if}
								</div>
								<div class="flex gap-3 mt-0.5 text-xs text-text-muted">
									<span>{group.runs.length} {group.runs.length === 1 ? 'Run' : 'Runs'}</span>
									<span>{formatCost(group.totalCost)}</span>
									<span>{formatDateTime(group.lastActivity)}</span>
								</div>
							</div>
						</button>
						{#if group.isArchived}
							<button
								onclick={async () => {
									await unarchiveThread(group.threadId);
									const th = threads.find((t) => t.id === group.threadId);
									if (th) th.is_archived = 0;
								}}
								class="shrink-0 mr-3 text-[9px] uppercase tracking-widest text-accent-text bg-accent/10 hover:bg-accent/20 rounded px-1.5 py-0.5 transition-colors"
							>
								{t('threads.unarchive')}
							</button>
						{/if}
					</div>

					<!-- Expanded runs -->
					{#if expandedThreads.has(group.threadId)}
						<div class="border-t border-border">
							{#each group.runs as run}
								{@render runItem(run)}
							{/each}
						</div>
					{/if}
				</div>
			{/each}
		</div>
		{#if hasMore}
			<button
				onclick={loadMore}
				disabled={loadingMore}
				class="w-full rounded-[var(--radius-md)] border border-border bg-bg-subtle px-4 py-2.5 text-sm text-text-muted hover:text-text hover:border-border-hover transition-all disabled:opacity-50 mt-3"
			>
				{loadingMore ? t('common.loading') : t('history.load_more')}
			</button>
		{/if}
	{:else}
		<!-- Flat list (search mode) -->
		<div class="space-y-2">
			{#each runs as run}
				{@render runItem(run)}
			{/each}
			{#if hasMore}
				<button
					onclick={loadMore}
					disabled={loadingMore}
					class="w-full rounded-[var(--radius-md)] border border-border bg-bg-subtle px-4 py-2.5 text-sm text-text-muted hover:text-text hover:border-border-hover transition-all disabled:opacity-50"
				>
					{loadingMore ? t('common.loading') : t('history.load_more')}
				</button>
			{/if}
		</div>
	{/if}
</div>

{#snippet runItem(run: RunRecord)}
		<div id="run-{run.id}" class="flex gap-1.5">
			{#if run.status === 'failed'}
				<div class="w-[3px] shrink-0 rounded-full bg-danger"></div>
			{/if}
			<div
				class="flex-1 rounded-[var(--radius-md)] border border-border bg-bg-subtle overflow-hidden transition-all"
			>
					<button
						onclick={() => toggleRun(run.id)}
						class="w-full p-3 text-left hover:bg-bg-muted transition-colors"
					>
						<div class="flex items-center justify-between gap-2">
							<p class="text-sm font-medium truncate max-w-[60%]">
								{#if searchQuery.trim()}
									{@html highlightMatch(run.task_text, searchQuery)}
								{:else}
									{run.task_text}
								{/if}
							</p>
							<span class="text-xs text-text-subtle whitespace-nowrap">{formatDateTime(run.created_at)}</span>
						</div>
						<div class="flex gap-3 mt-1 text-xs text-text-muted flex-wrap items-center">
							<span
								class="rounded-[var(--radius-sm)] px-1.5 py-0.5 {run.status === 'completed'
									? 'bg-success/15 text-success'
									: run.status === 'failed'
										? 'bg-danger/15 text-danger font-medium'
										: 'bg-bg-muted'}">{run.status}</span>
							{#if run.run_type === 'batch_parent'}
								<span class="rounded-[var(--radius-sm)] bg-accent/10 text-accent-text px-1.5 py-0.5"
									>{t('history.pipeline')}</span>
							{:else if run.spawn_depth && run.spawn_depth > 0}
								<span class="rounded-[var(--radius-sm)] bg-bg-muted px-1.5 py-0.5">{t('history.spawned')}</span>
							{/if}
							<span>{run.model_id}</span>
							<span>{formatCost(run.cost_usd)}</span>
							{#if (run.user_wait_ms ?? 0) > 0}
								<span title="AI: {((run.duration_ms - (run.user_wait_ms ?? 0)) / 1000).toFixed(1)}s / Total: {(run.duration_ms / 1000).toFixed(1)}s">{((run.duration_ms - (run.user_wait_ms ?? 0)) / 1000).toFixed(1)}s AI</span>
							{:else}
								<span>{(run.duration_ms / 1000).toFixed(1)}s</span>
							{/if}
							<span
								>{(
									run.tokens_in +
									run.tokens_out +
									(run.tokens_cache_read ?? 0) +
									(run.tokens_cache_write ?? 0)
								).toLocaleString()} tokens</span>
							{#if (run.tokens_cache_read ?? 0) > 0}
								<span class="text-success">{cachePercent(run)}% cache</span>
							{/if}
						</div>
					</button>

					{#if expandedRun === run.id}
						<div class="border-t border-border p-4 space-y-3">
							<!-- Action buttons -->
							<div class="flex gap-2 flex-wrap">
								{#if onrerun}
									<button
										onclick={() => onrerun?.(run.task_text)}
										class="rounded-[var(--radius-sm)] border border-accent/30 bg-accent/10 px-2.5 py-1 text-xs text-accent-text hover:bg-accent/20 transition-colors"
									>
										&#x21bb; {t('history.rerun')}
									</button>
								{/if}
								{#if (run.spawn_parent_id ?? run.batch_parent_id)}
									<button
										onclick={() => scrollToRun((run.spawn_parent_id ?? run.batch_parent_id)!)}
										class="rounded-[var(--radius-sm)] border border-border bg-bg-muted px-2.5 py-1 text-xs text-text-muted hover:text-text transition-colors"
									>
										&uarr; {t('history.parent_run')}
									</button>
								{/if}
							</div>

							<!-- Tool calls -->
							{#if toolCallsLoading}
								<p class="text-xs text-text-subtle animate-pulse">{t('history.loading_details')}</p>
							{:else if toolCallsError}
								<p class="text-xs text-danger">{t('history.load_details_failed')}</p>
							{:else if toolCalls.length > 0}
								<div>
									<p class="text-xs font-medium text-text-muted mb-2">
										{t('history.tool_calls')} ({toolCalls.length})
									</p>
									{#each toolCalls as tc, idx}
										<details class="mb-1.5 md:mb-1 rounded border border-border bg-bg text-sm md:text-xs">
											<summary class="px-3 md:px-2 py-1.5 md:py-1 cursor-pointer text-text-muted hover:text-text">
												<span class="font-mono">{tc.tool_name}</span>
												<span class="ml-2 text-text-subtle">{tc.duration_ms}ms</span>
											</summary>
											<div class="px-2 py-1 border-t border-border">
												{#if tc.input_json.length > 500 && !expandedInputs.has(idx)}
													<pre class="whitespace-pre-wrap font-mono text-text-subtle">{tc.input_json.slice(0, 500)}</pre>
													<button
														onclick={() => { expandedInputs = new Set([...expandedInputs, idx]); }}
														class="text-accent-text text-[13px] md:text-[11px] hover:underline mt-1"
													>
														{t('history.show_more')} ({tc.input_json.length.toLocaleString()} chars)
													</button>
												{:else}
													<pre class="whitespace-pre-wrap font-mono text-text-subtle">{tc.input_json}</pre>
													{#if tc.input_json.length > 500}
														<button
															onclick={() => { const next = new Set(expandedInputs); next.delete(idx); expandedInputs = next; }}
															class="text-accent-text text-[13px] md:text-[11px] hover:underline mt-1"
														>
															{t('history.show_less')}
														</button>
													{/if}
												{/if}
											</div>
										</details>
									{/each}
								</div>
							{/if}

							{#if writtenFiles.length > 0}
								<div>
									<p class="text-xs font-medium text-text-muted mb-2">
										{t('history.files_written')} ({writtenFiles.length})
									</p>
									<div class="space-y-1">
										{#each writtenFiles as filePath}
											<a
												href="{getApiBase()}/files/download?path={encodeURIComponent(filePath)}"
												download
												class="block rounded-[var(--radius-sm)] bg-bg-muted px-2 py-1 text-xs font-mono text-accent-text hover:underline"
												>{filePath}</a>
										{/each}
									</div>
								</div>
							{/if}

							{#if run.response_text}
								<div>
									<p class="text-xs font-medium text-text-muted mb-2">{t('history.response')}</p>
									<MarkdownRenderer content={run.response_text} />
								</div>
							{/if}
						</div>
					{/if}
					</div>
				</div>
{/snippet}
