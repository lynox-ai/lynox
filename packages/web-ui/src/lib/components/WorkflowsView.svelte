<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t, getLocale } from '../i18n.svelte.js';
	import { timeAgo } from '../utils/time.js';

	interface PipelineRun {
		id: string;
		manifest_name: string;
		status: string;
		total_duration_ms: number;
		total_cost_usd: number;
		step_count: number;
		error: string | null;
		started_at: string;
	}

	interface PipelineRunDetail extends PipelineRun {
		manifest_json: string;
		total_tokens_in: number;
		total_tokens_out: number;
		parent_run_id: string | null;
		completed_at: string | null;
	}

	interface StepResult {
		id: number;
		pipeline_run_id: string;
		step_id: string;
		status: string;
		result: string;
		error: string | null;
		duration_ms: number;
		tokens_in: number;
		tokens_out: number;
		cost_usd: number;
	}

	let runs = $state<PipelineRun[]>([]);
	let loading = $state(true);
	let error = $state('');

	let selectedRun = $state<PipelineRunDetail | null>(null);
	let selectedSteps = $state<StepResult[]>([]);
	let detailLoading = $state(false);
	let expandedSteps = $state<Set<string>>(new Set());

	async function loadRuns() {
		loading = true;
		error = '';
		try {
			const res = await fetch(`${getApiBase()}/pipelines?limit=50`);
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { runs: PipelineRun[] };
			runs = data.runs;
		} catch {
			error = t('common.load_failed');
		}
		loading = false;
	}

	async function selectRun(id: string) {
		if (selectedRun?.id === id) { selectedRun = null; selectedSteps = []; return; }
		detailLoading = true;
		expandedSteps = new Set();
		try {
			const [runRes, stepsRes] = await Promise.all([
				fetch(`${getApiBase()}/pipelines/${id}`),
				fetch(`${getApiBase()}/pipelines/${id}/steps`),
			]);
			if (!runRes.ok || !stepsRes.ok) throw new Error();
			selectedRun = (await runRes.json()) as PipelineRunDetail;
			const stepsData = (await stepsRes.json()) as { steps: StepResult[] };
			selectedSteps = stepsData.steps;
		} catch {
			error = t('workflow.load_detail_failed');
		}
		detailLoading = false;
	}

	function toggleStep(stepId: string) {
		const next = new Set(expandedSteps);
		if (next.has(stepId)) next.delete(stepId); else next.add(stepId);
		expandedSteps = next;
	}

	function formatDuration(ms: number): string {
		if (ms < 1000) return `${ms}ms`;
		if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
		return `${(ms / 60_000).toFixed(1)}m`;
	}

	function formatCost(usd: number): string {
		return `$${usd.toFixed(4)}`;
	}

	function wfTimeAgo(iso: string): string {
		return timeAgo(iso, t('workflow.just_now'));
	}

	function parseManifestSteps(json: string): Array<{ id: string; task: string; input_from?: string[]; model?: string }> {
		try {
			const manifest = JSON.parse(json) as { agents?: Array<{ id: string; task: string; input_from?: string[]; model?: string }>; steps?: Array<{ id: string; task: string; input_from?: string[]; model?: string }> };
			return manifest.agents ?? manifest.steps ?? [];
		} catch { return []; }
	}

	const statusColor: Record<string, string> = {
		completed: 'bg-success/15 text-success',
		failed: 'bg-danger/10 text-danger',
		running: 'bg-warning/15 text-warning',
		planned: 'bg-accent/10 text-accent-text',
	};

	const statusIcon: Record<string, string> = {
		completed: '\u2713',
		failed: '\u2717',
		running: '\u25CE',
		planned: '\u25CB',
		pending: '\u25CB',
	};

	$effect(() => { loadRuns(); });
</script>

<div class="p-6 max-w-4xl mx-auto">
	<h1 class="text-xl font-light tracking-tight mb-4">{t('workflow.title')}</h1>

	{#if error}
		<div class="rounded-[var(--radius-md)] bg-danger/10 border border-danger/20 px-4 py-3 text-sm text-danger mb-4">{error}</div>
	{/if}

	{#if loading}
		<p class="text-text-subtle text-sm">{t('common.loading')}</p>
	{:else if !error && runs.length === 0}
		<div class="text-center py-12 text-text-subtle">
			<svg xmlns="http://www.w3.org/2000/svg" class="h-10 w-10 mx-auto mb-3 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
				<path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6z" />
			</svg>
			<p class="text-sm">{t('workflow.empty')}</p>
			<p class="text-xs mt-2">{t('workflow.empty_hint')}</p>
		</div>
	{:else}
		<div class="space-y-2">
			{#each runs as run}
				<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle transition-colors {selectedRun?.id === run.id ? 'border-accent/40' : ''}">
					<!-- Run header row -->
					<button
						class="w-full px-4 py-3 text-left flex items-center gap-3"
						onclick={() => selectRun(run.id)}
					>
						<!-- Status icon -->
						<span class="text-sm font-mono {statusColor[run.status] ?? 'text-text-muted'} w-5 text-center shrink-0">
							{statusIcon[run.status] ?? '\u25CB'}
						</span>

						<!-- Name + meta -->
						<div class="flex-1 min-w-0">
							<p class="text-sm font-medium truncate">{run.manifest_name}</p>
							<div class="flex flex-wrap gap-3 mt-1 text-xs text-text-subtle">
								<span>{run.step_count} {t('workflow.steps')}</span>
								<span>{formatDuration(run.total_duration_ms)}</span>
								<span>{formatCost(run.total_cost_usd)}</span>
								<span>{wfTimeAgo(run.started_at)}</span>
							</div>
						</div>

						<!-- Status badge -->
						<span class="text-xs rounded-full px-2.5 py-0.5 shrink-0 {statusColor[run.status] ?? 'bg-bg-muted text-text-muted'}">
							{run.status}
						</span>

						<!-- Expand indicator -->
						<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0 text-text-subtle transition-transform {selectedRun?.id === run.id ? 'rotate-180' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
							<path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
						</svg>
					</button>

					<!-- Expanded detail panel -->
					{#if selectedRun?.id === run.id}
						<div class="border-t border-border px-4 py-4 space-y-4">
							{#if detailLoading}
								<p class="text-text-subtle text-xs">{t('common.loading')}</p>
							{:else}
								<!-- Stats row -->
								<div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
									<div class="rounded-[var(--radius-sm)] bg-bg px-3 py-2">
										<p class="text-[10px] uppercase tracking-widest text-text-subtle">{t('workflow.duration')}</p>
										<p class="text-sm font-mono">{formatDuration(selectedRun.total_duration_ms)}</p>
									</div>
									<div class="rounded-[var(--radius-sm)] bg-bg px-3 py-2">
										<p class="text-[10px] uppercase tracking-widest text-text-subtle">{t('workflow.cost')}</p>
										<p class="text-sm font-mono">{formatCost(selectedRun.total_cost_usd)}</p>
									</div>
									<div class="rounded-[var(--radius-sm)] bg-bg px-3 py-2">
										<p class="text-[10px] uppercase tracking-widest text-text-subtle">{t('workflow.tokens_in')}</p>
										<p class="text-sm font-mono">{selectedRun.total_tokens_in.toLocaleString()}</p>
									</div>
									<div class="rounded-[var(--radius-sm)] bg-bg px-3 py-2">
										<p class="text-[10px] uppercase tracking-widest text-text-subtle">{t('workflow.tokens_out')}</p>
										<p class="text-sm font-mono">{selectedRun.total_tokens_out.toLocaleString()}</p>
									</div>
								</div>

								<!-- Error message -->
								{#if selectedRun.error}
									<div class="rounded-[var(--radius-md)] bg-danger/10 border border-danger/20 px-3 py-2 text-xs text-danger font-mono break-all">
										{selectedRun.error}
									</div>
								{/if}

								<!-- DAG visualization -->
								{#if selectedSteps.length > 0}
									{@const manifestSteps = parseManifestSteps(selectedRun.manifest_json)}
									<div>
										<h3 class="text-xs font-medium uppercase tracking-widest text-text-subtle mb-2">{t('workflow.step_results')}</h3>
										<div class="space-y-1">
											{#each selectedSteps as step}
												{@const mStep = manifestSteps.find(s => s.id === step.step_id)}
												<div class="rounded-[var(--radius-sm)] border border-border bg-bg">
													<button
														class="w-full px-3 py-2 text-left flex items-center gap-2 text-sm"
														onclick={() => toggleStep(step.step_id)}
													>
														<span class="font-mono text-xs w-5 text-center shrink-0 {statusColor[step.status] ?? 'text-text-muted'}">
															{statusIcon[step.status] ?? '\u25CB'}
														</span>
														<span class="flex-1 min-w-0 truncate font-medium text-xs">{step.step_id}</span>
														{#if mStep?.input_from && mStep.input_from.length > 0}
															<span class="text-[10px] text-text-subtle shrink-0">
																← {mStep.input_from.join(', ')}
															</span>
														{/if}
														{#if mStep?.model}
															<span class="text-[10px] font-mono text-text-subtle shrink-0">{mStep.model}</span>
														{/if}
														<span class="text-[10px] text-text-subtle shrink-0">{formatDuration(step.duration_ms)}</span>
														<span class="text-[10px] text-text-subtle shrink-0">{formatCost(step.cost_usd)}</span>
													</button>

													{#if expandedSteps.has(step.step_id)}
														{@const durationPct = selectedRun.total_duration_ms > 0 ? Math.round((step.duration_ms / selectedRun.total_duration_ms) * 100) : 0}
														{@const totalTokens = step.tokens_in + step.tokens_out}
														<div class="border-t border-border px-3 py-3 space-y-3">
															<!-- Meta row: model + dependencies -->
															<div class="flex flex-wrap items-center gap-2">
																{#if mStep?.model}
																	<span class="text-[10px] font-mono rounded-full px-2 py-0.5 bg-accent/10 text-accent-text">{mStep.model}</span>
																{/if}
																{#if mStep?.input_from && mStep.input_from.length > 0}
																	<span class="text-[10px] text-text-subtle">
																		{t('workflow.depends_on')}: <span class="font-mono text-text-muted">{mStep.input_from.join(', ')}</span>
																	</span>
																{/if}
																<span class="text-[10px] rounded-full px-2 py-0.5 {statusColor[step.status] ?? 'bg-bg-muted text-text-muted'}">{step.status}</span>
															</div>

															<!-- Task -->
															{#if mStep?.task}
																<div>
																	<p class="text-[10px] uppercase tracking-widest text-text-subtle mb-0.5">{t('workflow.task')}</p>
																	<p class="text-xs text-text">{mStep.task}</p>
																</div>
															{/if}

															<!-- Timing bar -->
															<div>
																<div class="flex items-center justify-between mb-1">
																	<p class="text-[10px] uppercase tracking-widest text-text-subtle">{t('workflow.duration')}</p>
																	<span class="text-[10px] font-mono text-text-muted">{formatDuration(step.duration_ms)} ({durationPct}%)</span>
																</div>
																<div class="w-full h-1.5 rounded-full bg-border overflow-hidden">
																	<div class="h-full rounded-full transition-all duration-300
																		{step.status === 'failed' ? 'bg-danger/60' : 'bg-accent/60'}"
																		style="width: {Math.max(durationPct, 2)}%"></div>
																</div>
															</div>

															<!-- Token + Cost breakdown -->
															<div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
																<div class="rounded-[var(--radius-sm)] bg-bg-muted px-2.5 py-1.5">
																	<p class="text-[10px] uppercase tracking-widest text-text-subtle">Tokens In</p>
																	<p class="text-xs font-mono text-text-muted">{step.tokens_in.toLocaleString()}</p>
																</div>
																<div class="rounded-[var(--radius-sm)] bg-bg-muted px-2.5 py-1.5">
																	<p class="text-[10px] uppercase tracking-widest text-text-subtle">Tokens Out</p>
																	<p class="text-xs font-mono text-text-muted">{step.tokens_out.toLocaleString()}</p>
																</div>
																<div class="rounded-[var(--radius-sm)] bg-bg-muted px-2.5 py-1.5">
																	<p class="text-[10px] uppercase tracking-widest text-text-subtle">{t('workflow.total_tokens')}</p>
																	<p class="text-xs font-mono text-text-muted">{totalTokens.toLocaleString()}</p>
																</div>
																<div class="rounded-[var(--radius-sm)] bg-bg-muted px-2.5 py-1.5">
																	<p class="text-[10px] uppercase tracking-widest text-text-subtle">{t('workflow.cost')}</p>
																	<p class="text-xs font-mono text-text-muted">{formatCost(step.cost_usd)}</p>
																</div>
															</div>

															<!-- Result -->
															{#if step.result}
																<div>
																	<p class="text-[10px] uppercase tracking-widest text-text-subtle mb-0.5">{t('workflow.result')}</p>
																	<pre class="text-xs text-text-muted font-mono bg-bg-muted rounded-[var(--radius-sm)] p-2 overflow-x-auto max-h-40 whitespace-pre-wrap">{step.result}</pre>
																</div>
															{/if}

															<!-- Error -->
															{#if step.error}
																<div>
																	<p class="text-[10px] uppercase tracking-widest text-text-subtle mb-0.5">{t('workflow.error')}</p>
																	<pre class="text-xs text-danger font-mono bg-danger/5 rounded-[var(--radius-sm)] p-2 overflow-x-auto whitespace-pre-wrap">{step.error}</pre>
																</div>
															{/if}
														</div>
													{/if}
												</div>
											{/each}
										</div>
									</div>
								{/if}

								<!-- Timestamp -->
								<div class="flex justify-between text-[10px] text-text-subtle">
									<span>{t('workflow.started')}: {new Date(selectedRun.started_at).toLocaleString(getLocale() === 'de' ? 'de-CH' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' })}</span>
									{#if selectedRun.completed_at}
										<span>{t('workflow.completed')}: {new Date(selectedRun.completed_at).toLocaleString(getLocale() === 'de' ? 'de-CH' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' })}</span>
									{/if}
								</div>
							{/if}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>
