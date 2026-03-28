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
		created_at: string;
	}

	interface ToolCall {
		tool_name: string;
		input_json: string;
		output_json: string;
		duration_ms: number;
	}

	let runs = $state<RunRecord[]>([]);
	let loading = $state(true);
	let expandedRun = $state<string | null>(null);
	let toolCalls = $state<ToolCall[]>([]);
	let stats = $state<{ total_runs?: number; total_cost_usd?: number } | null>(null);

	async function loadRuns() {
		loading = true;
		const [runsRes, statsRes] = await Promise.all([
			fetch(`${getApiBase()}/history/runs?limit=50`),
			fetch(`${getApiBase()}/history/stats`)
		]);
		const runsData = (await runsRes.json()) as { runs: RunRecord[] };
		runs = runsData.runs;
		stats = (await statsRes.json()) as typeof stats;
		loading = false;
	}

	async function toggleRun(id: string) {
		if (expandedRun === id) {
			expandedRun = null;
			toolCalls = [];
			return;
		}
		expandedRun = id;
		const res = await fetch(`${getApiBase()}/history/runs/${id}/tool-calls`);
		const data = (await res.json()) as { toolCalls: ToolCall[] };
		toolCalls = data.toolCalls;
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
						<div class="flex gap-3 mt-1 text-xs text-text-muted">
							<span class="rounded bg-bg-muted px-1.5 py-0.5 {run.status === 'completed' ? 'text-success' : run.status === 'failed' ? 'text-danger' : ''}">{run.status}</span>
							<span>{run.model_id}</span>
							<span>${run.cost_usd.toFixed(4)}</span>
							<span>{(run.duration_ms / 1000).toFixed(1)}s</span>
							<span>{run.tokens_in + run.tokens_out} tokens</span>
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
		</div>
	{/if}
</div>
