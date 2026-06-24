<script lang="ts">
	import { goto } from '$app/navigation';
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { newChat, sendMessage } from '../stores/chat.svelte.js';
	import Icon from '../primitives/Icon.svelte';

	// A "saved workflow" — a planned pipeline with manifest_json.template===true.
	// Surfaced by GET /api/workflows/library (PRD-WORKFLOW-UX D13).
	interface WorkflowParam {
		name: string;
		description: string;
		type: string;
	}
	// The resolved capability-contract (Slice B2) — the outbound writes a scheduled
	// run is allowed to perform. Shown read-only in the consent surface.
	interface WorkflowContract {
		grantedTools?: string[];
		httpMethods?: string[];
		hostPatterns?: string[];
		pathPatterns?: string[];
	}
	interface SavedWorkflow {
		id: string;
		name: string;
		description: string;
		step_count: number;
		steps: { id: string; task: string }[];
		// Re-target schema — present (possibly empty) since the deterministic-replay
		// slice. Optional in the type so a pre-upgrade engine response still parses.
		parameters?: WorkflowParam[];
		created_at: string;
		// Slice B2: only `autonomous` workflows are cron-eligible; `capabilityContract`
		// (if any) is rendered in the consent surface. All optional for back-compat.
		mode?: string;
		confirmedAt?: string;
		capabilityContract?: WorkflowContract;
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

	// Run-time parameter modal (only opened for workflows that declare params).
	let paramModalWf = $state<SavedWorkflow | null>(null);
	let paramValues = $state<Record<string, string>>({});

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

	// "💬 Bearbeiten" (§4.6): editing is chat-with-context, not a bespoke step
	// form. Open a FRESH chat seeded with a typed reference to this workflow; the
	// server resolves it into a context preamble (the steps + id) so the agent
	// has the workflow loaded and can call update_workflow_steps. The user just
	// says what to change.
	function onEditInChat(wf: SavedWorkflow): void {
		newChat();
		const framing = `${t('workflow_library.edit_in_chat_prompt')} „${wf.name}".`;
		void sendMessage(framing, undefined, undefined, { context: { kind: 'workflow', id: wf.id } });
		void goto('/app');
	}

	// Run button: a workflow with parameters opens the value modal first; one
	// without runs immediately (the legacy no-arg behaviour).
	function onRunClick(wf: SavedWorkflow): void {
		if (runningId) return;
		if (wf.parameters && wf.parameters.length > 0) {
			paramValues = Object.fromEntries(wf.parameters.map((p) => [p.name, '']));
			paramModalWf = wf;
			return;
		}
		void runWorkflow(wf.id);
	}

	function submitParamModal(): void {
		const wf = paramModalWf;
		if (!wf || !wf.parameters) return;
		// Require every declared param — the engine would 400 on a missing one;
		// catch it client-side for a cleaner message.
		if (wf.parameters.some((p) => !paramValues[p.name]?.trim())) {
			error = t('workflow_library.params_required');
			return;
		}
		const params = { ...paramValues };
		paramModalWf = null;
		void runWorkflow(wf.id, params);
	}

	function cancelParamModal(): void {
		paramModalWf = null;
		error = '';
	}

	// Schedule (promote-to-cron) consent flow — the one bespoke consent gate
	// (PRD §4.6): shows the resolved capability-contract, collects the cron
	// schedule + the param values the unattended run will use, and the single
	// POST /api/tasks stamps the first-run-confirm + creates the cron task.
	let scheduleModalWf = $state<SavedWorkflow | null>(null);
	let scheduleCron = $state('0 9 * * *');
	let scheduling = $state(false);

	function onScheduleClick(wf: SavedWorkflow): void {
		paramValues = Object.fromEntries((wf.parameters ?? []).map((p) => [p.name, '']));
		scheduleCron = '0 9 * * *';
		error = '';
		scheduleModalWf = wf;
	}

	function cancelScheduleModal(): void {
		scheduleModalWf = null;
		error = '';
	}

	// True only when the contract has at least one displayable outbound action —
	// avoids rendering a scary-but-empty "may perform these actions" panel.
	function contractHasRows(c: WorkflowContract): boolean {
		return (
			(c.httpMethods?.length ?? 0) > 0 ||
			(c.hostPatterns?.length ?? 0) > 0 ||
			(c.grantedTools ?? []).some((tool) => tool !== 'http_request')
		);
	}

	function onScheduleKey(e: KeyboardEvent): void {
		if (e.key === 'Enter') void submitSchedule();
		if (e.key === 'Escape') cancelScheduleModal();
	}

	async function submitSchedule(): Promise<void> {
		const wf = scheduleModalWf;
		if (!wf || scheduling) return;
		if (!scheduleCron.trim()) { error = t('workflow_library.schedule_cron_required'); return; }
		if ((wf.parameters ?? []).some((p) => !paramValues[p.name]?.trim())) {
			error = t('workflow_library.params_required');
			return;
		}
		scheduling = true;
		error = '';
		try {
			const res = await fetch(`${getApiBase()}/tasks`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					pipelineId: wf.id,
					scheduleCron: scheduleCron.trim(),
					...(wf.parameters && wf.parameters.length > 0 ? { params: { ...paramValues } } : {}),
				}),
			});
			if (!res.ok) {
				const msg = (await res.json().catch(() => null)) as { error?: string } | null;
				error = msg?.error ?? t('workflow_library.schedule_failed');
				return;
			}
			scheduleModalWf = null;
			notice = t('workflow_library.scheduled');
			await loadWorkflows();
		} catch {
			error = t('workflow_library.schedule_failed');
		} finally {
			scheduling = false;
		}
	}

	async function runWorkflow(id: string, params?: Record<string, string>): Promise<void> {
		if (runningId) return;
		runningId = id;
		error = '';
		notice = t('workflow_library.run_started');
		try {
			const res = await fetch(`${getApiBase()}/workflows/${id}/run`, {
				method: 'POST',
				...(params
					? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ params }) }
					: {})
			});
			if (!res.ok) {
				const msg = (await res.json().catch(() => null)) as { error?: string } | null;
				error = msg?.error ?? t('workflow_library.run_failed');
				notice = '';
				return;
			}
			// A2: the run endpoint now returns cost + per-step failures, so the
			// library shows WHICH step failed and the spend right where the run was
			// triggered — not just a terminal status.
			const data = (await res.json()) as {
				status?: string;
				costUsd?: number;
				error?: string;
				stepErrors?: Array<{ stepId: string; error?: string; costUsd: number }>;
			};
			const failedSteps = (data.stepErrors ?? []).filter((s) => s.error);
			const cost =
				typeof data.costUsd === 'number' && data.costUsd > 0
					? ` ($${data.costUsd.toFixed(4)})`
					: '';
			const stepDetail = failedSteps.map((s) => `${s.stepId}: ${s.error}`).join('; ');
			if (data.status === 'completed') {
				// The run finished successfully. Non-fatal step errors (on_failure:
				// 'continue'/'notify') are appended as a caveat — they did NOT fail
				// the run, so they belong in the success notice, not a red error box.
				notice = `${t('workflow_library.run_done')}${cost}${stepDetail ? ` — ${stepDetail}` : ''}`;
				error = '';
			} else {
				const detail = stepDetail || (data.error ?? '');
				error = detail ? `${t('workflow_library.run_failed')} — ${detail}` : t('workflow_library.run_failed');
				notice = '';
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
									onclick={() => onRunClick(wf)}
									disabled={runningId !== null}
									class="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 rounded-[var(--radius-sm)] border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] text-accent-text hover:bg-accent/20 transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
								>
									<Icon name="bolt" size="xs" />
									{runningId === wf.id ? t('workflow_library.running') : t('workflow_library.run')}
								</button>
								{#if wf.mode === 'autonomous'}
									<button
										onclick={() => onScheduleClick(wf)}
										class="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 rounded-[var(--radius-sm)] border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] text-accent-text hover:bg-accent/20 transition-opacity"
									>
										<Icon name="clock" size="xs" />
										{t('workflow_library.schedule')}
									</button>
								{/if}
								<button
									onclick={() => onEditInChat(wf)}
									class="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 rounded-[var(--radius-sm)] border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] text-accent-text hover:bg-accent/20 transition-opacity"
								>
									<Icon name="chat" size="xs" />
									{t('workflow_library.edit_in_chat')}
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

{#if paramModalWf}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
		role="dialog"
		aria-modal="true"
		aria-label={t('workflow_library.params_title')}
	>
		<div class="w-full max-w-md rounded-[var(--radius-md)] border border-border bg-bg p-5 shadow-lg">
			<h2 class="text-sm font-medium mb-1">{paramModalWf.name}</h2>
			<p class="text-xs text-text-subtle mb-4">{t('workflow_library.params_hint')}</p>
			<div class="space-y-3">
				{#each paramModalWf.parameters ?? [] as param (param.name)}
					<label class="block">
						<span class="block text-xs font-medium mb-1">{param.name}</span>
						{#if param.description}
							<span class="block text-[10px] text-text-subtle mb-1">{param.description}</span>
						{/if}
						<input
							bind:value={paramValues[param.name]}
							type={param.type === 'date' ? 'date' : 'text'}
							inputmode={param.type === 'number' ? 'decimal' : undefined}
							onkeydown={(e) => { if (e.key === 'Enter') submitParamModal(); if (e.key === 'Escape') cancelParamModal(); }}
							class="w-full rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1 text-[16px] md:text-sm focus:border-accent focus:outline-none"
						/>
					</label>
				{/each}
			</div>
			<div class="flex items-center justify-end gap-2 mt-5">
				<button
					onclick={cancelParamModal}
					class="rounded-[var(--radius-sm)] border border-border bg-bg-muted px-3 py-1 text-xs text-text-muted hover:bg-bg transition-colors"
				>{t('workflow_library.cancel')}</button>
				<button
					onclick={submitParamModal}
					class="flex items-center gap-1 rounded-[var(--radius-sm)] border border-accent/30 bg-accent/10 px-3 py-1 text-xs text-accent-text hover:bg-accent/20 transition-colors"
				>
					<Icon name="bolt" size="xs" />
					{t('workflow_library.run')}
				</button>
			</div>
		</div>
	</div>
{/if}

{#if scheduleModalWf}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
		role="dialog"
		aria-modal="true"
		aria-label={t('workflow_library.schedule_title')}
	>
		<div class="w-full max-w-md rounded-[var(--radius-md)] border border-border bg-bg p-5 shadow-lg max-h-[85vh] overflow-y-auto">
			<h2 class="text-sm font-medium mb-1">{t('workflow_library.schedule_title')}: {scheduleModalWf.name}</h2>
			<p class="text-xs text-text-subtle mb-4">{t('workflow_library.schedule_hint')}</p>

			{#if scheduleModalWf.capabilityContract && contractHasRows(scheduleModalWf.capabilityContract)}
				{@const c = scheduleModalWf.capabilityContract}
				<div class="rounded-[var(--radius-sm)] border border-warning/30 bg-warning/10 p-3 mb-4 text-xs">
					<p class="font-medium mb-1 flex items-center gap-1"><Icon name="warning" size="xs" />{t('workflow_library.schedule_contract_title')}</p>
					<ul class="space-y-0.5 text-text-subtle">
						{#if c.httpMethods?.length || c.hostPatterns?.length}
							<li>{(c.httpMethods ?? []).join(', ')} → {(c.hostPatterns ?? []).join(', ')}{(c.pathPatterns ?? []).map((p) => ` ${p}`).join('')}</li>
						{/if}
						{#each (c.grantedTools ?? []).filter((tool) => tool !== 'http_request') as tool (tool)}
							<li>{tool}</li>
						{/each}
					</ul>
				</div>
			{/if}

			<label class="block mb-3">
				<span class="block text-xs font-medium mb-1">{t('workflow_library.schedule_cron_label')}</span>
				<span class="block text-[10px] text-text-subtle mb-1">{t('workflow_library.schedule_cron_hint')}</span>
				<input
					bind:value={scheduleCron}
					placeholder="0 9 * * *"
					onkeydown={onScheduleKey}
					class="w-full rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1 font-mono text-[16px] md:text-sm focus:border-accent focus:outline-none"
				/>
			</label>

			{#if (scheduleModalWf.parameters ?? []).length > 0}
				<div class="space-y-3 mb-1">
					<p class="text-[10px] uppercase tracking-widest text-text-subtle">{t('workflow_library.params_title')}</p>
					{#each scheduleModalWf.parameters ?? [] as param (param.name)}
						<label class="block">
							<span class="block text-xs font-medium mb-1">{param.name}</span>
							{#if param.description}
								<span class="block text-[10px] text-text-subtle mb-1">{param.description}</span>
							{/if}
							<input
								bind:value={paramValues[param.name]}
								type={param.type === 'date' ? 'date' : 'text'}
								inputmode={param.type === 'number' ? 'decimal' : undefined}
								onkeydown={onScheduleKey}
								class="w-full rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1 text-[16px] md:text-sm focus:border-accent focus:outline-none"
							/>
						</label>
					{/each}
				</div>
			{/if}

			<div class="flex items-center justify-end gap-2 mt-5">
				<button
					onclick={cancelScheduleModal}
					class="rounded-[var(--radius-sm)] border border-border bg-bg-muted px-3 py-1 text-xs text-text-muted hover:bg-bg transition-colors"
				>{t('workflow_library.cancel')}</button>
				<button
					onclick={submitSchedule}
					disabled={scheduling}
					class="flex items-center gap-1 rounded-[var(--radius-sm)] border border-accent/30 bg-accent/10 px-3 py-1 text-xs text-accent-text hover:bg-accent/20 transition-colors disabled:opacity-50"
				>
					<Icon name="clock" size="xs" />
					{t('workflow_library.schedule_confirm')}
				</button>
			</div>
		</div>
	</div>
{/if}
