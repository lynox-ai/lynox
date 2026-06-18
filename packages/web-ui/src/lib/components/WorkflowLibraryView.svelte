<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import Icon from '../primitives/Icon.svelte';

	// A "saved workflow" — a planned pipeline with manifest_json.template===true.
	// Surfaced by GET /api/workflows/library (PRD-WORKFLOW-UX D13).
	interface WorkflowParam {
		name: string;
		description: string;
		type: string;
	}

	interface SavedWorkflow {
		id: string;
		name: string;
		description: string;
		step_count: number;
		steps: { id: string; task: string }[];
		parameters: WorkflowParam[];
		created_at: string;
	}

	let workflows = $state<SavedWorkflow[]>([]);
	let loading = $state(true);
	let error = $state('');
	let notice = $state('');

	// Per-row transient state.
	let runningId = $state<string | null>(null);
	let editingId = $state<string | null>(null);
	let editName = $state('');
	let expandedCards = $state<Set<string>>(new Set());

	// Parameter-form state: which workflow's re-run form is open + the values.
	let paramFormId = $state<string | null>(null);
	let paramValues = $state<Record<string, string>>({});

	function requestRun(wf: SavedWorkflow): void {
		if (runningId) return;
		if (wf.parameters.length > 0) {
			// Open the form so the user supplies + reviews values before the run.
			paramValues = Object.fromEntries(wf.parameters.map((p) => [p.name, '']));
			paramFormId = wf.id;
		} else {
			void runWorkflow(wf.id);
		}
	}

	function cancelParamForm(): void {
		paramFormId = null;
		paramValues = {};
	}

	function toggleCard(id: string): void {
		const next = new Set(expandedCards);
		if (next.has(id)) next.delete(id); else next.add(id);
		expandedCards = next;
	}

	async function loadWorkflows(): Promise<void> {
		loading = true;
		error = '';
		try {
			const res = await fetch(`${getApiBase()}/workflows/library?limit=100`);
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { workflows: SavedWorkflow[] };
			workflows = data.workflows;
		} catch {
			error = t('common.load_failed');
		}
		loading = false;
	}

	async function runWorkflow(id: string, params?: Record<string, string>): Promise<void> {
		if (runningId) return;
		runningId = id;
		error = '';
		notice = t('workflow_library.run_started');
		try {
			const res = await fetch(`${getApiBase()}/workflows/${id}/run`, {
				method: 'POST',
				...(params ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ params }) } : {}),
			});
			if (!res.ok) {
				const msg = (await res.json().catch(() => null)) as { error?: string } | null;
				error = msg?.error ?? t('workflow_library.run_failed');
				notice = '';
				return;
			}
			const data = (await res.json()) as { status?: string; failedStep?: { id: string; error: string } };
			if (data.status === 'completed') {
				notice = t('workflow_library.run_done');
				paramFormId = null; // close the form on a successful run
			} else {
				notice = '';
				error = data.failedStep
					? `${t('workflow_library.step_failed')} ${data.failedStep.id}: ${data.failedStep.error}`
					: t('workflow_library.run_failed');
			}
		} catch {
			error = t('workflow_library.run_failed');
			notice = '';
		} finally {
			runningId = null;
		}
	}

	function startRename(wf: SavedWorkflow): void {
		editingId = wf.id;
		editName = wf.name;
	}

	function cancelRename(): void {
		editingId = null;
		editName = '';
	}

	async function saveRename(id: string): Promise<void> {
		const name = editName.trim();
		if (!name) return;
		error = '';
		try {
			const res = await fetch(`${getApiBase()}/workflows/${id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name })
			});
			if (!res.ok) { error = t('common.save_failed'); return; }
			editingId = null;
			editName = '';
			await loadWorkflows();
		} catch {
			error = t('common.save_failed');
		}
	}

	async function deleteWorkflow(id: string): Promise<void> {
		if (!confirm(t('workflow_library.delete_confirm'))) return;
		error = '';
		try {
			const res = await fetch(`${getApiBase()}/workflows/${id}`, { method: 'DELETE' });
			if (!res.ok) { error = t('common.save_failed'); return; }
			await loadWorkflows();
		} catch {
			error = t('common.save_failed');
		}
	}

	$effect(() => { loadWorkflows(); });
</script>

<div class="p-6 max-w-4xl mx-auto">
	<h1 class="text-xl font-light tracking-tight mb-4">{t('workflow_library.title')}</h1>

	{#if error}
		<div class="rounded-[var(--radius-md)] bg-danger/10 border border-danger/20 px-4 py-3 text-sm text-danger mb-4">{error}</div>
	{/if}
	{#if notice}
		<div class="rounded-[var(--radius-md)] bg-success/10 border border-success/20 px-4 py-3 text-sm text-success mb-4">{notice}</div>
	{/if}

	{#if loading}
		<p class="text-text-subtle text-sm">{t('common.loading')}</p>
	{:else if workflows.length > 0}
		<div class="space-y-2">
			{#each workflows as wf (wf.id)}
				<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle px-4 py-3 group">
					<div class="flex items-start justify-between gap-3">
						<div class="flex-1 min-w-0">
							{#if editingId === wf.id}
								<input
									bind:value={editName}
									onkeydown={(e) => { if (e.key === 'Enter') void saveRename(wf.id); if (e.key === 'Escape') cancelRename(); }}
									aria-label={t('workflow_library.rename')}
									class="w-full rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1 text-[16px] md:text-sm focus:border-accent focus:outline-none"
								/>
							{:else}
								<p class="text-sm font-medium line-clamp-2 break-words">{wf.name}</p>
								{#if wf.description}
									<p class="text-xs text-text-subtle mt-1 line-clamp-2 break-words">{wf.description}</p>
								{/if}
								<div class="flex flex-wrap gap-2 mt-1.5 text-xs text-text-subtle">
									{#if wf.steps.length > 0}
										<button
											onclick={() => toggleCard(wf.id)}
											aria-expanded={expandedCards.has(wf.id)}
											class="flex items-center gap-1 rounded-[var(--radius-sm)] hover:text-text transition-colors"
										>
											<Icon name="workflow" size="xs" />
											{t(wf.step_count === 1 ? 'workflow_library.steps_one' : 'workflow_library.steps_many').replace('{count}', String(wf.step_count))}
											<Icon name="chevron_down" size="xs" class="transition-transform {expandedCards.has(wf.id) ? 'rotate-180' : ''}" />
										</button>
									{:else}
										<span class="flex items-center gap-1">
											<Icon name="workflow" size="xs" />
											{t(wf.step_count === 1 ? 'workflow_library.steps_one' : 'workflow_library.steps_many').replace('{count}', String(wf.step_count))}
										</span>
									{/if}
								</div>
								{#if expandedCards.has(wf.id)}
									<div class="space-y-1 mt-2">
										{#each wf.steps as step (step.id)}
											<div class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-2">
												<p class="font-mono text-xs text-text-subtle truncate">{step.id}</p>
												<p class="text-[10px] uppercase tracking-widest text-text-subtle mt-1 mb-0.5">{t('workflow.task')}</p>
												<p class="text-xs text-text break-words">{step.task}</p>
											</div>
										{/each}
									</div>
								{/if}
							{/if}
						</div>
						<div class="flex items-center gap-2 shrink-0 mt-0.5">
							{#if editingId === wf.id}
								<button onclick={() => void saveRename(wf.id)} class="rounded-[var(--radius-sm)] border border-success/30 bg-success/10 px-2 py-0.5 text-[10px] text-success hover:bg-success/20 transition-colors">{t('workflow_library.save')}</button>
								<button onclick={cancelRename} class="rounded-[var(--radius-sm)] border border-border bg-bg-muted px-2 py-0.5 text-[10px] text-text-muted hover:bg-bg transition-colors">{t('workflow_library.cancel')}</button>
							{:else}
								<button
									onclick={() => requestRun(wf)}
									disabled={runningId !== null}
									class="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 rounded-[var(--radius-sm)] border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] text-accent-text hover:bg-accent/20 transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
								>
									<Icon name="bolt" size="xs" />
									{runningId === wf.id ? t('workflow_library.running') : t('workflow_library.run')}
								</button>
								<button onclick={() => startRename(wf)} class="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 rounded-[var(--radius-sm)] border border-border bg-bg-muted px-2 py-0.5 text-[10px] text-text-muted hover:bg-bg transition-opacity">
									<Icon name="pencil" size="xs" />
									{t('workflow_library.rename')}
								</button>
								<button onclick={() => void deleteWorkflow(wf.id)} class="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 rounded-[var(--radius-sm)] border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10px] text-danger hover:bg-danger/20 transition-opacity">
									<Icon name="trash" size="xs" />
									{t('workflow_library.delete')}
								</button>
							{/if}
						</div>
						{#if paramFormId === wf.id}
							<div class="mt-2 space-y-2 rounded-[var(--radius-sm)] border border-border bg-bg-muted/50 p-2">
								<p class="text-[10px] text-text-muted">{t('workflow_library.params_hint')}</p>
								{#each wf.parameters as p (p.name)}
									<label class="block text-[10px] text-text-muted">
										{p.description || p.name}
										<input
											type={p.type === 'number' ? 'number' : p.type === 'date' ? 'date' : 'text'}
											bind:value={paramValues[p.name]}
											placeholder={p.name}
											class="mt-0.5 w-full rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1 text-xs text-text"
										/>
									</label>
								{/each}
								<div class="flex gap-1">
									<button onclick={() => void runWorkflow(wf.id, paramValues)} disabled={runningId !== null} class="rounded-[var(--radius-sm)] border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] text-accent-text hover:bg-accent/20 disabled:opacity-50">{t('workflow_library.run')}</button>
									<button onclick={cancelParamForm} class="rounded-[var(--radius-sm)] border border-border bg-bg-muted px-2 py-0.5 text-[10px] text-text-muted hover:bg-bg">{t('workflow_library.cancel')}</button>
								</div>
							</div>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{:else}
		<div class="text-center py-12 text-text-subtle">
			<p class="text-sm">{t('workflow_library.empty')}</p>
			<p class="text-xs mt-2">{t('workflow_library.empty_hint')}</p>
		</div>
	{/if}
</div>
