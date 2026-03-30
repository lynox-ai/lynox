<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';

	interface Metric { metricName: string; value: number; sampleCount: number; window: string; computedAt: string; }
	interface Pattern { id: string; patternType: string; description: string; evidenceCount: number; confidence: number; }
	interface ThreadInsight {
		sessionId: string;
		title: string;
		runCount: number;
		successCount: number;
		failedCount: number;
		totalDurationMs: number;
		totalCostUsd: number;
		lastRunAt: string;
		toolCounts: Record<string, number>;
	}

	let metrics = $state<Metric[]>([]);
	let patterns = $state<Pattern[]>([]);
	let threadInsights = $state<ThreadInsight[]>([]);
	let loading = $state(true);
	let error = $state('');
	let threadLimit = $state(20);
	let hasMoreThreads = $state(false);

	async function loadData() {
		loading = true; error = '';
		try {
			const [mRes, pRes, tRes] = await Promise.all([
				fetch(`${getApiBase()}/metrics`),
				fetch(`${getApiBase()}/patterns`),
				fetch(`${getApiBase()}/thread-insights?limit=${threadLimit}`),
			]);
			if (!mRes.ok || !pRes.ok || !tRes.ok) throw new Error('API error');
			metrics = ((await mRes.json()) as { metrics: Metric[] }).metrics;
			patterns = ((await pRes.json()) as { patterns: Pattern[] }).patterns;
			const tiData = (await tRes.json()) as { threadInsights: ThreadInsight[] };
			threadInsights = tiData.threadInsights;
			hasMoreThreads = tiData.threadInsights.length >= threadLimit;
		} catch { error = t('insights.error'); }
		loading = false;
	}

	async function loadMoreThreads() {
		threadLimit += 20;
		try {
			const res = await fetch(`${getApiBase()}/thread-insights?limit=${threadLimit}`);
			if (!res.ok) return;
			const data = (await res.json()) as { threadInsights: ThreadInsight[] };
			threadInsights = data.threadInsights;
			hasMoreThreads = data.threadInsights.length >= threadLimit;
		} catch { /* keep existing data */ }
	}

	$effect(() => { loadData(); });

	// Get the latest all_time metric by name
	function getMetric(name: string): number | null {
		const m = metrics.find(m => m.metricName === name && m.window === 'all_time');
		return m ? m.value : null;
	}

	// Get daily time series for a metric (sorted chronologically)
	function getDailySeries(name: string): Metric[] {
		return metrics
			.filter(m => m.metricName === name && m.window === 'daily')
			.sort((a, b) => a.computedAt.localeCompare(b.computedAt));
	}

	function formatDuration(ms: number | null): string {
		if (ms === null || ms === 0) return '-';
		if (ms < 1000) return `${Math.round(ms)}ms`;
		return `${(ms / 1000).toFixed(1)}s`;
	}

	function formatCost(usd: number | null): string {
		if (usd === null || usd === 0) return '-';
		if (usd < 0.01) return `${(usd * 100).toFixed(1)}c`;
		return `$${usd.toFixed(2)}`;
	}

	function topTools(toolMap: Record<string, number> | undefined | null, max = 3): string[] {
		if (!toolMap) return [];
		return Object.entries(toolMap)
			.sort((a, b) => b[1] - a[1])
			.slice(0, max)
			.map(([k]) => k);
	}

	function successRate(t: ThreadInsight): number {
		return t.runCount > 0 ? t.successCount / t.runCount : 0;
	}

	const patternTypeColor: Record<string, string> = {
		sequence: 'bg-accent/15 text-accent-text',
		preference: 'bg-success/15 text-success',
		'anti-pattern': 'bg-danger/15 text-danger',
		schedule: 'bg-warning/15 text-warning',
	};

	// Sparkline: render an inline SVG bar chart for a daily metric series
	function sparklinePath(series: Metric[], isPercent = false): { bars: Array<{ x: number; h: number; val: string }>; width: number; height: number } {
		const height = 32;
		const width = Math.min(series.length * 8, 240);
		if (series.length === 0) return { bars: [], width, height };

		const values = series.map(m => m.value);
		const max = Math.max(...values);
		const min = isPercent ? 0 : Math.min(...values) * 0.8;
		const range = (max - min) || 1;
		const barW = Math.max(2, (width / series.length) - 1);

		return {
			bars: values.map((v, i) => ({
				x: i * (width / series.length),
				h: ((v - min) / range) * (height - 2),
				val: isPercent ? `${(v * 100).toFixed(0)}%` : v > 1000 ? `${(v / 1000).toFixed(1)}s` : `$${v.toFixed(2)}`,
			})),
			width,
			height,
		};
	}
</script>

<div class="p-6 max-w-5xl mx-auto space-y-6">
	<h1 class="text-xl font-light tracking-tight">{t('insights.title')}</h1>

	{#if error}
		<div class="rounded-[var(--radius-md)] bg-danger/10 border border-danger/20 px-4 py-3 text-sm text-danger">{error}</div>
	{/if}

	{#if loading}
		<p class="text-text-subtle text-sm">{t('common.loading')}</p>
	{:else}
		<!-- KPI Cards -->
		<div class="grid grid-cols-2 md:grid-cols-4 gap-3">
			<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4">
				<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle">{t('insights.success_rate')}</p>
				<p class="text-2xl font-light mt-1">
					{#if getMetric('success_rate') !== null}
						{(getMetric('success_rate')! * 100).toFixed(0)}%
					{:else}
						-
					{/if}
				</p>
			</div>
			<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4">
				<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle">{t('insights.avg_duration')}</p>
				<p class="text-2xl font-light mt-1">{formatDuration(getMetric('avg_duration_ms'))}</p>
			</div>
			<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4">
				<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle">{t('insights.total_cost')}</p>
				<p class="text-2xl font-light mt-1">{formatCost(getMetric('total_cost_usd'))}</p>
			</div>
			<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4">
				<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle">{t('insights.total_runs')}</p>
				<p class="text-2xl font-light mt-1">{getMetric('total_runs') ?? threadInsights.reduce((s, ti) => s + ti.runCount, 0)}</p>
			</div>
		</div>

		<!-- Trend Charts (daily sparklines) -->
		{@const successSeries = getDailySeries('success_rate')}
		{@const durationSeries = getDailySeries('avg_duration_ms')}
		{@const costSeries = getDailySeries('total_cost_usd')}
		{#if successSeries.length > 2 || durationSeries.length > 2 || costSeries.length > 2}
			<div>
				<h2 class="text-sm font-medium mb-3">{t('insights.trend')}</h2>
				<div class="grid grid-cols-1 md:grid-cols-3 gap-3">
					{#if successSeries.length > 2}
						{@const spark = sparklinePath(successSeries, true)}
						<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-3">
							<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle mb-2">{t('insights.success_rate')}</p>
							<svg width={spark.width} height={spark.height} class="w-full" viewBox="0 0 {spark.width} {spark.height}" preserveAspectRatio="none">
								{#each spark.bars as bar}
									<rect x={bar.x} y={spark.height - bar.h} width={Math.max(2, spark.width / successSeries.length - 1)} height={bar.h}
										class="fill-success/60" rx="1" />
								{/each}
							</svg>
							<div class="flex justify-between text-[10px] text-text-subtle mt-1">
								<span>{successSeries[0]?.computedAt.slice(5, 10)}</span>
								<span>{successSeries[successSeries.length - 1]?.computedAt.slice(5, 10)}</span>
							</div>
						</div>
					{/if}
					{#if durationSeries.length > 2}
						{@const spark = sparklinePath(durationSeries)}
						<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-3">
							<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle mb-2">{t('insights.avg_duration')}</p>
							<svg width={spark.width} height={spark.height} class="w-full" viewBox="0 0 {spark.width} {spark.height}" preserveAspectRatio="none">
								{#each spark.bars as bar}
									<rect x={bar.x} y={spark.height - bar.h} width={Math.max(2, spark.width / durationSeries.length - 1)} height={bar.h}
										class="fill-accent/60" rx="1" />
								{/each}
							</svg>
							<div class="flex justify-between text-[10px] text-text-subtle mt-1">
								<span>{durationSeries[0]?.computedAt.slice(5, 10)}</span>
								<span>{durationSeries[durationSeries.length - 1]?.computedAt.slice(5, 10)}</span>
							</div>
						</div>
					{/if}
					{#if costSeries.length > 2}
						{@const spark = sparklinePath(costSeries)}
						<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-3">
							<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle mb-2">{t('insights.total_cost')}</p>
							<svg width={spark.width} height={spark.height} class="w-full" viewBox="0 0 {spark.width} {spark.height}" preserveAspectRatio="none">
								{#each spark.bars as bar}
									<rect x={bar.x} y={spark.height - bar.h} width={Math.max(2, spark.width / costSeries.length - 1)} height={bar.h}
										class="fill-warning/60" rx="1" />
								{/each}
							</svg>
							<div class="flex justify-between text-[10px] text-text-subtle mt-1">
								<span>{costSeries[0]?.computedAt.slice(5, 10)}</span>
								<span>{costSeries[costSeries.length - 1]?.computedAt.slice(5, 10)}</span>
							</div>
						</div>
					{/if}
				</div>
			</div>
		{/if}

		<!-- Patterns + Thread Insights -->
		<div class="flex gap-4 flex-col md:flex-row">
			<!-- Patterns -->
			<div class="flex-1 min-w-0">
				<h2 class="text-sm font-medium mb-3">{t('insights.patterns')}</h2>
				{#if patterns.length === 0}
					<p class="text-text-subtle text-sm">{t('insights.no_patterns')}</p>
				{:else}
					<div class="space-y-2">
						{#each patterns as pattern}
							<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle px-4 py-3">
								<div class="flex items-center gap-2 mb-1">
									<span class="text-[10px] rounded-full px-2 py-0.5 font-mono {patternTypeColor[pattern.patternType] ?? 'bg-bg-muted text-text-muted'}">{pattern.patternType}</span>
									<span class="text-xs text-text-subtle">{t('insights.confidence')}: {(pattern.confidence * 100).toFixed(0)}%</span>
									<span class="text-xs text-text-subtle">{t('insights.evidence')}: {pattern.evidenceCount}x</span>
								</div>
								<p class="text-sm text-text-muted">{pattern.description}</p>
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Thread Insights -->
			<div class="flex-1 min-w-0">
				<h2 class="text-sm font-medium mb-3">{t('insights.threads')}</h2>
				{#if threadInsights.length === 0}
					<p class="text-text-subtle text-sm">{t('insights.no_threads')}</p>
				{:else}
					<div class="space-y-1">
						{#each threadInsights as ti}
							<div class="rounded-[var(--radius-sm)] border border-border px-3 py-2 flex items-center gap-3">
								<!-- Success rate indicator -->
								<div class="shrink-0 w-8 text-center">
									<span class="text-xs font-mono {successRate(ti) >= 0.6 ? 'text-success' : successRate(ti) >= 0.3 ? 'text-warning' : 'text-danger'}">
										{(successRate(ti) * 100).toFixed(0)}%
									</span>
								</div>
								<div class="flex-1 min-w-0">
									<p class="text-sm truncate">{(ti.title || 'Untitled').slice(0, 80)}</p>
									<div class="flex gap-2 text-[10px] text-text-subtle mt-0.5">
										<span class="font-mono">{ti.runCount} runs</span>
										{#each topTools(ti.toolCounts) as tool}
											<span class="bg-bg-muted px-1.5 py-0.5 rounded">{tool}</span>
										{/each}
									</div>
								</div>
								<div class="text-right shrink-0 text-xs text-text-subtle tabular-nums">
									<p>{formatDuration(ti.totalDurationMs)}</p>
									<p>{formatCost(ti.totalCostUsd)}</p>
								</div>
							</div>
						{/each}
					</div>
					{#if hasMoreThreads}
						<button onclick={() => loadMoreThreads()} class="mt-2 text-xs text-accent-text hover:underline">
							{t('insights.load_all')}
						</button>
					{/if}
				{/if}
			</div>
		</div>
	{/if}
</div>
