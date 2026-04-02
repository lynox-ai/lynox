<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { formatCost, formatDuration } from '../format.js';
	import { t } from '../i18n.svelte.js';

	interface Metric { metricName: string; value: number; sampleCount: number; window: string; computedAt: string; }
	interface Pattern { id: string; patternType: string; description: string; evidenceCount: number; confidence: number; }

	let metrics = $state<Metric[]>([]);
	let patterns = $state<Pattern[]>([]);
	let loading = $state(true);
	let error = $state('');

	async function loadData() {
		loading = true; error = '';
		try {
			const [mRes, pRes] = await Promise.all([
				fetch(`${getApiBase()}/metrics`),
				fetch(`${getApiBase()}/patterns`),
			]);
			if (!mRes.ok || !pRes.ok) throw new Error('API error');
			metrics = ((await mRes.json()) as { metrics: Metric[] }).metrics;
			patterns = ((await pRes.json()) as { patterns: Pattern[] }).patterns;
		} catch { error = t('insights.error'); }
		loading = false;
	}

	$effect(() => { loadData(); });

	// Get daily time series for a metric (sorted chronologically)
	function getDailySeries(name: string): Metric[] {
		return metrics
			.filter(m => m.metricName === name && m.window === 'daily')
			.sort((a, b) => a.computedAt.localeCompare(b.computedAt));
	}

	const patternTypeColor: Record<string, string> = {
		sequence: 'bg-accent/15 text-accent-text',
		preference: 'bg-success/15 text-success',
		'anti-pattern': 'bg-danger/15 text-danger',
		schedule: 'bg-warning/15 text-warning',
	};

	// Sparkline: render inline bar chart data for a daily metric series
	function sparklinePath(series: Metric[], isPercent = false): { bars: Array<{ x: number; h: number; val: string }>; width: number; height: number } {
		const height = 32;
		const width = Math.min(series.length * 8, 240);
		if (series.length === 0) return { bars: [], width, height };

		const values = series.map(m => m.value);
		const max = Math.max(...values);
		const min = isPercent ? 0 : Math.min(...values) * 0.8;
		const range = (max - min) || 1;

		return {
			bars: values.map((v, i) => ({
				x: i * (width / series.length),
				h: ((v - min) / range) * (height - 2),
				val: isPercent ? `${(v * 100).toFixed(0)}%` : v > 1000 ? formatDuration(v) : formatCost(v),
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

		<!-- Patterns -->
		<div>
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
	{/if}
</div>
