<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';

	interface Metric { metricName: string; value: number; sampleCount: number; }
	interface Pattern { id: string; patternType: string; description: string; evidenceCount: number; confidence: number; }
	interface Episode { id: string; task: string; outcomeSignal: string; toolsUsed: string[]; durationMs: number | null; tokenCost: number | null; createdAt: string; }

	let metrics = $state<Metric[]>([]);
	let patterns = $state<Pattern[]>([]);
	let episodes = $state<Episode[]>([]);
	let loading = $state(true);

	async function loadData() {
		loading = true;
		try {
			const [mRes, pRes, eRes] = await Promise.all([
				fetch(`${getApiBase()}/metrics`),
				fetch(`${getApiBase()}/patterns`),
				fetch(`${getApiBase()}/episodes?limit=20`),
			]);
			metrics = ((await mRes.json()) as { metrics: Metric[] }).metrics;
			patterns = ((await pRes.json()) as { patterns: Pattern[] }).patterns;
			episodes = ((await eRes.json()) as { episodes: Episode[] }).episodes;
		} catch { /* ignore */ }
		loading = false;
	}

	$effect(() => { loadData(); });

	function getMetric(name: string): number | null {
		const m = metrics.find(m => m.metricName === name);
		return m ? m.value : null;
	}

	function formatDuration(ms: number | null): string {
		if (ms === null) return '-';
		if (ms < 1000) return `${ms}ms`;
		return `${(ms / 1000).toFixed(1)}s`;
	}

	function formatCost(usd: number | null): string {
		if (usd === null) return '-';
		if (usd < 0.01) return `$${(usd * 100).toFixed(1)}c`;
		return `$${usd.toFixed(2)}`;
	}

	const signalIcon: Record<string, string> = {
		success: '\u2713',
		failed: '\u2717',
		partial: '\u25CB',
		abandoned: '\u2014',
		unknown: '?',
	};

	const signalColor: Record<string, string> = {
		success: 'text-success',
		failed: 'text-danger',
		partial: 'text-warning',
		abandoned: 'text-text-subtle',
		unknown: 'text-text-muted',
	};

	const patternTypeColor: Record<string, string> = {
		sequence: 'bg-accent/15 text-accent-text',
		preference: 'bg-success/15 text-success',
		'anti-pattern': 'bg-danger/15 text-danger',
		schedule: 'bg-warning/15 text-warning',
	};
</script>

<div class="p-6 max-w-5xl mx-auto space-y-6">
	<h1 class="text-xl font-light tracking-tight">{t('insights.title')}</h1>

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
				<p class="text-2xl font-light mt-1">{getMetric('total_runs') ?? episodes.length}</p>
			</div>
		</div>

		<!-- Patterns + Episodes -->
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

			<!-- Episodes -->
			<div class="flex-1 min-w-0">
				<h2 class="text-sm font-medium mb-3">{t('insights.episodes')}</h2>
				{#if episodes.length === 0}
					<p class="text-text-subtle text-sm">{t('insights.no_episodes')}</p>
				{:else}
					<div class="space-y-1">
						{#each episodes as ep}
							<div class="rounded-[var(--radius-sm)] border border-border px-3 py-2 flex items-center gap-3">
								<span class="text-lg {signalColor[ep.outcomeSignal] ?? 'text-text-muted'}">{signalIcon[ep.outcomeSignal] ?? '?'}</span>
								<div class="flex-1 min-w-0">
									<p class="text-sm truncate">{ep.task.slice(0, 80)}</p>
									<div class="flex gap-2 text-[10px] text-text-subtle mt-0.5">
										{#each ep.toolsUsed.slice(0, 3) as tool}
											<span class="bg-bg-muted px-1.5 py-0.5 rounded">{tool}</span>
										{/each}
										{#if ep.toolsUsed.length > 3}
											<span>+{ep.toolsUsed.length - 3}</span>
										{/if}
									</div>
								</div>
								<div class="text-right shrink-0 text-xs text-text-subtle tabular-nums">
									<p>{formatDuration(ep.durationMs)}</p>
									<p>{formatCost(ep.tokenCost)}</p>
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</div>
	{/if}
</div>
