<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import MarkdownRenderer from './MarkdownRenderer.svelte';
	import { t, getLocale } from '../i18n.svelte.js';

	interface RunRecord {
		id: string;
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
		created_at: string;
		run_type?: string;
		spawn_depth?: number;
		batch_parent_id?: string;
	}

	interface ToolCall {
		tool_name: string;
		input_json: string;
		output_json: string;
		duration_ms: number;
	}

	let runs = $state<RunRecord[]>([]);
	let loading = $state(true);
	let loadingMore = $state(false);
	let expandedRun = $state<string | null>(null);
	let toolCalls = $state<ToolCall[]>([]);
	let writtenFiles = $derived(toolCalls.filter((tc) => tc.tool_name === 'write_file').map((tc) => { try { const p = JSON.parse(tc.input_json) as Record<string, unknown>; return String(p['path'] ?? p['file_path'] ?? ''); } catch { return ''; } }).filter(Boolean));
	let stats = $state<{ total_runs?: number; total_cost_usd?: number } | null>(null);
	let hasMore = $state(true);
	let error = $state('');
	const PAGE_SIZE = 50;

	async function loadRuns() {
		loading = true; error = '';
		try {
			const [runsRes, statsRes] = await Promise.all([
				fetch(`${getApiBase()}/history/runs?limit=${PAGE_SIZE}`),
				fetch(`${getApiBase()}/history/stats`)
			]);
			if (!runsRes.ok) throw new Error();
			const runsData = (await runsRes.json()) as { runs: RunRecord[] };
			runs = runsData.runs;
			hasMore = runsData.runs.length >= PAGE_SIZE;
			stats = (await statsRes.json()) as typeof stats;
		} catch { error = t('common.load_failed'); }
		loading = false;
	}

	async function loadMore() {
		if (!hasMore || loadingMore) return;
		loadingMore = true;
		try {
			const offset = runs.length;
			const res = await fetch(`${getApiBase()}/history/runs?limit=${PAGE_SIZE}&offset=${offset}`);
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { runs: RunRecord[] };
			runs = [...runs, ...data.runs];
			hasMore = data.runs.length >= PAGE_SIZE;
		} catch {
			error = t('common.load_failed');
		}
		loadingMore = false;
	}

	async function toggleRun(id: string) {
		if (expandedRun === id) {
			expandedRun = null;
			toolCalls = [];
			return;
		}
		expandedRun = id;
		try {
			const res = await fetch(`${getApiBase()}/history/runs/${id}/tool-calls`);
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { toolCalls: ToolCall[] };
			toolCalls = data.toolCalls;
		} catch {
			toolCalls = [];
		}
	}

	$effect(() => {
		loadRuns();
	});
</script>

<div class="p-6 max-w-4xl mx-auto">
	<div class="flex items-center justify-between mb-4">
		<h1 class="text-xl font-light tracking-tight">{t('history.title')}</h1>
		{#if stats}
			<div class="flex gap-4 text-xs text-text-muted">
				<span>{stats.total_runs ?? 0} {t('history.runs')}</span>
				<span>${(stats.total_cost_usd ?? 0).toFixed(2)} {t('history.total')}</span>
			</div>
		{/if}
	</div>

	{#if error}
		<div class="rounded-[var(--radius-md)] bg-danger/10 border border-danger/20 px-4 py-3 text-sm text-danger mb-4">{error}</div>
	{/if}

	{#if loading}
		<p class="text-text-subtle text-sm">{t('common.loading')}</p>
	{:else if runs.length === 0}
		<p class="text-text-subtle text-sm">{t('history.no_runs')}</p>
	{:else}
		<div class="space-y-2">
			{#each runs as run}
				<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle overflow-hidden">
					<button
						onclick={() => toggleRun(run.id)}
						class="w-full p-3 text-left hover:bg-bg-muted transition-colors"
					>
						<div class="flex items-center justify-between">
							<p class="text-sm font-medium truncate max-w-[60%]">{run.task_text}</p>
							<span class="text-xs text-text-subtle">{new Date(run.created_at).toLocaleDateString(getLocale() === 'de' ? 'de-CH' : 'en-US')}</span>
						</div>
						<div class="flex gap-3 mt-1 text-xs text-text-muted flex-wrap">
							<span class="rounded-[var(--radius-sm)] px-1.5 py-0.5 {run.status === 'completed' ? 'bg-success/15 text-success' : run.status === 'failed' ? 'bg-danger/15 text-danger' : 'bg-bg-muted'}">{run.status}</span>
							{#if run.run_type === 'batch_parent'}
								<span class="rounded-[var(--radius-sm)] bg-accent/10 text-accent-text px-1.5 py-0.5">{t('history.pipeline')}</span>
							{:else if run.spawn_depth && run.spawn_depth > 0}
								<span class="rounded-[var(--radius-sm)] bg-bg-muted px-1.5 py-0.5">{t('history.spawned')}</span>
							{/if}
							<span>{run.model_id}</span>
							<span>${run.cost_usd.toFixed(4)}</span>
							<span>{(run.duration_ms / 1000).toFixed(1)}s</span>
							<span>{(run.tokens_in + run.tokens_out + (run.tokens_cache_read ?? 0) + (run.tokens_cache_write ?? 0)).toLocaleString()} tokens</span>
							{#if (run.tokens_cache_read ?? 0) > 0}
								{@const totalIn = run.tokens_in + (run.tokens_cache_read ?? 0) + (run.tokens_cache_write ?? 0)}
								<span class="text-success">{Math.round(((run.tokens_cache_read ?? 0) / (totalIn || 1)) * 100)}% cache</span>
							{/if}
						</div>
					</button>

					{#if expandedRun === run.id}
						<div class="border-t border-border p-4 space-y-3">
							{#if toolCalls.length > 0}
								<div>
									<p class="text-xs font-medium text-text-muted mb-2">{t('history.tool_calls')} ({toolCalls.length})</p>
									{#each toolCalls as tc}
										<details class="mb-1 rounded border border-border bg-bg text-xs">
											<summary class="px-2 py-1 cursor-pointer text-text-muted hover:text-text">
												<span class="font-mono">{tc.tool_name}</span>
												<span class="ml-2 text-text-subtle">{tc.duration_ms}ms</span>
											</summary>
											<div class="px-2 py-1 border-t border-border">
												<pre class="whitespace-pre-wrap font-mono text-text-subtle">{tc.input_json.slice(0, 500)}</pre>
											</div>
										</details>
									{/each}
								</div>
							{/if}

							{#if writtenFiles.length > 0}
								<div>
									<p class="text-xs font-medium text-text-muted mb-2">{t('history.files_written')} ({writtenFiles.length})</p>
									<div class="space-y-1">
										{#each writtenFiles as filePath}
											<div class="rounded-[var(--radius-sm)] bg-bg-muted px-2 py-1 text-xs font-mono text-text-muted">{filePath}</div>
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
