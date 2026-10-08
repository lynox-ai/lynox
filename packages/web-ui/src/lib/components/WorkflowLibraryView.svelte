<script lang="ts">
	import { goto } from '$app/navigation';
	import { getApiBase } from '../config.svelte.js';
	import { t, tf } from '../i18n.svelte.js';
	import { newChat, sendMessage } from '../stores/chat.svelte.js';
	import Icon from '../primitives/Icon.svelte';
	import { attemptKey, clearAttemptKey, clearAllAttemptKeys, attemptIsOver } from '../utils/run-attempt-key.js';
	import { composeRunNotice, refusalBanner } from '../utils/run-notice.js';

	// The card actions show on hover only where there is room beside the name AND a pointer that
	// hovers. Below `md` they sit under the name and stay visible, and on a device without hover
	// (a phone, a tablet) they stay visible at any width — otherwise Run is unreachable there.
	// Keyboard focus reveals them everywhere.
	const revealOnHover = 'opacity-100 md:[@media(hover:hover)]:opacity-0 group-hover:opacity-100 focus-visible:opacity-100';
	// The same condition sizes them: a fingertip target (44 px) unless there is a mouse at md and
	// up, where they keep their compact desktop size.
	const actionSize = 'min-h-11 px-3 text-[12px] md:[@media(hover:hover)]:min-h-0 md:[@media(hover:hover)]:px-2 md:[@media(hover:hover)]:py-0.5 md:[@media(hover:hover)]:text-[10px]';

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
	// Whether this instance lets a person grant a workflow unattended writes (engine feature
	// switch, reported by GET /workflows/library). Off: the dialog offers no grant fields.
	let grantEnabled = $state(false);
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
			const data = (await res.json()) as { workflows: SavedWorkflow[]; grantEnabled?: boolean };
			workflows = data.workflows;
			grantEnabled = data.grantEnabled === true;
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

	// The write grant (engine `workflow-grant.ts`): what the person types, and the preview the
	// engine returned for exactly that. Any change to an input drops the preview, so what is
	// accepted is always what was shown last; the engine checks the same with the checksum.
	let grantOpen = $state(false);
	let grantMethod = $state('POST');
	let grantHost = $state('');
	let grantPaths = $state('');
	let grantName = $state('');
	let grantAfterUntrusted = $state(false);
	interface GrantPreview { tuples: string[]; boundParams: Record<string, unknown>; binding: 'keyed' | 'unkeyed'; checksum: string }
	let grantPreview = $state<GrantPreview | null>(null);
	let previewing = $state(false);

	function grantPathList(): string[] {
		return grantPaths.split('\n').map((p) => p.trim()).filter((p) => p !== '');
	}

	function dropGrantPreview(): void {
		grantPreview = null;
	}

	function onScheduleClick(wf: SavedWorkflow): void {
		paramValues = Object.fromEntries((wf.parameters ?? []).map((p) => [p.name, '']));
		scheduleCron = '0 9 * * *';
		error = '';
		grantOpen = false;
		grantMethod = 'POST';
		grantHost = '';
		grantPaths = '';
		grantName = '';
		grantAfterUntrusted = false;
		grantPreview = null;
		scheduleModalWf = wf;
	}

	async function previewGrant(): Promise<void> {
		const wf = scheduleModalWf;
		if (!wf || previewing) return;
		previewing = true;
		error = '';
		try {
			const res = await fetch(`${getApiBase()}/workflows/${wf.id}/grant-preview`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					method: grantMethod,
					host: grantHost,
					paths: grantPathList(),
					scheduleCron: scheduleCron.trim(),
					afterUntrusted: grantAfterUntrusted,
					...(wf.parameters && wf.parameters.length > 0 ? { params: { ...paramValues } } : {}),
				}),
			});
			const data = (await res.json().catch(() => null)) as (GrantPreview & { error?: string }) | null;
			if (!res.ok || !data || !Array.isArray(data.tuples)) {
				grantPreview = null;
				error = data?.error ?? t('workflow_library.grant_preview_failed');
				return;
			}
			grantPreview = data;
		} catch {
			error = t('workflow_library.grant_preview_failed');
		} finally {
			previewing = false;
		}
	}

	/** One line per (method, URL) a stored contract enforces — the cross product, listed. */
	function contractTuples(c: WorkflowContract): string[] {
		const hosts = c.hostPatterns ?? [];
		const paths = (c.pathPatterns ?? []).length > 0 ? c.pathPatterns ?? [] : [''];
		return (c.httpMethods ?? []).flatMap((m) => hosts.flatMap((h) => paths.map((p) => `${m} https://${h}${p}`)));
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
		if (grantOpen && !grantPreview) { error = t('workflow_library.grant_preview_required'); return; }
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
					...(grantOpen && grantPreview
						? {
							grant: {
								method: grantMethod,
								host: grantHost,
								paths: grantPathList(),
								afterUntrusted: grantAfterUntrusted,
								checksum: grantPreview.checksum,
								...(grantName.trim() ? { name: grantName.trim() } : {}),
							},
						}
						: {}),
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

	/**
	 * The attempt's key travels in the body; whether it SURVIVES the answer is decided by
	 * `attemptIsOver` in the utils module beside it — not by a flag here. A refuter killed
	 * nothing with the flag version: "never clear" and "keep on every 409" both survived,
	 * because the only witness was a regex over this file's text. The rule is a function of
	 * the answer, so it can be driven exhaustively.
	 *
	 * A thrown fetch is the one case with no answer to pass, and it is the case the key
	 * exists for: the request may have reached the engine and started spending.
	 */
	async function runWorkflow(id: string, params?: Record<string, string>): Promise<void> {
		if (runningId) return;
		runningId = id;
		error = '';
		notice = t('workflow_library.run_started');
		// Keyed on the INPUTS too: a key kept across a lost answer and then sent with
		// different values would replay the earlier run and ignore the new ones.
		const idempotencyKey = attemptKey(id, params);
		let keepKey = true;
		try {
			const res = await fetch(`${getApiBase()}/workflows/${id}/run`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(params ? { params, idempotencyKey } : { idempotencyKey })
			});
			if (res.status === 409) {
				// A refusal that is NOT a failure. Before the claim existed every non-ok
				// answer landed in the error branch below, so a correctly reported "already
				// running" would have shown as "run failed" — a red box for the one case
				// where nothing went wrong.
				const msg = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
				keepKey = !attemptIsOver({ httpStatus: 409, code: msg?.code });
				// ⚠ The message is chosen by CODE, never by whether the key survives. Those
				// two coincided until `run_outcome_unknown` became non-terminal, and then the
				// branch on `keepKey` sent that code into the "already running" banner — a
				// sentence that is false for it — while the specific wording written for it
				// became unreachable. Two questions, two conditions.
				// Composed in `run-notice.ts`, for the reason recorded there: as an if/else chain
				// here, a one-line change that prepended a code to the first condition restored
				// the defect this branch had just fixed, with every test green — the witnesses
				// were regexes over this file and cannot see reachability.
				const banner = refusalBanner(msg?.code);
				notice = banner.kind === 'notice' ? t(banner.key) : '';
				error = banner.kind === 'error' ? t(banner.key) : '';
				if (msg?.code === 'run_outcome_unknown') {
					// ⚠ The ONE state where the earlier run may still be alive and still
					// spending. The key is kept (so no click can silently duplicate it), and
					// the only way out is this question — asked once, naming the consequence,
					// and answered by the person rather than decided here.
					//
					// This replaced a sentence that told the owner to click again, while the
					// client discarded the key on the same answer: the server refused because a
					// run may still be paying, and the client undid the refusal on the next
					// click. Releasing is now an act, not a side effect.
					//
					// It does NOT re-run. The release and the run are two decisions, so the
					// confirm cannot turn into a second run the person did not separately ask
					// for.
					if (confirm(t('workflow_library.run_outcome_unknown_force'))) {
						clearAttemptKey(id, params);
						error = '';
						notice = t('workflow_library.run_outcome_unknown_released');
					}
				}
				return;
			}
			if (!res.ok) {
				// ⚠ `attemptIsOver` decides, NOT `res.ok`. A 502/503/504 from a proxy, or a
				// 429, is an answer the route never produced — the engine may still be running
				// and spending. Discarding the key there is what lets the next click pay for
				// the whole workflow a second time.
				keepKey = !attemptIsOver({ httpStatus: res.status });
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
				idempotent?: boolean;
				restartedFrom?: string;
				previousCostUsd?: number;
				stepErrors?: Array<{ stepId: string; error?: string; costUsd: number }>;
			};
			// ⚠ HERE, and not before the parse. The attempt is over once its outcome is in
			// hand; a 200 whose body never arrives is an answer the client did not receive,
			// and clearing the key there would make the next click pay for a run that had
			// already succeeded. Deleting this line reintroduces "never clear" — after which
			// a successful run replays for ever and the workflow can never be run again, so
			// it is witnessed in both directions.
			keepKey = !attemptIsOver({ httpStatus: res.status });
			// Composed in `run-notice.ts`, where every shape it can take is drivable. It went
			// wrong twice as template literals here, both times in a sentence about money.
			// `tf` where a string has a slot, `t` otherwise — one closure, so the module needs
			// no knowledge of which keys carry placeholders.
			const composed = composeRunNotice(data, (key, vars) => (vars === undefined ? t(key) : tf(key, vars)));
			if (composed.kind === 'notice') {
				notice = composed.text;
				error = '';
			} else {
				error = composed.text;
				notice = '';
			}
		} catch {
			// The answer never arrived, so whether the run started is unknown HERE — and that
			// is precisely the case the key is for. `keepKey` starts true, so this needs no
			// assignment: every exit that does NOT reach an answer keeps the key, which is the
			// safe default and the reason the initial value is `true` rather than `false`.
			error = t('workflow_library.run_failed');
			notice = '';
		} finally {
			if (!keepKey) clearAttemptKey(id, params);
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
			// No answer can ever be terminal for a workflow that is gone, so its attempt keys
			// would stay in storage for good. Nothing else removes them.
			clearAllAttemptKeys(id);
			await loadWorkflows();
		} catch {
			error = t('common.save_failed');
		}
	}

	$effect(() => { void loadWorkflows(); /* catches and sets its error */ });
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
					<div class="flex flex-col gap-2 md:flex-row md:items-start md:justify-between md:gap-3">
						<div class="flex-1 min-w-0">
							{#if editingId === wf.id}
								<input
									bind:value={editName}
									onkeydown={(e) => { if (e.key === 'Enter') void saveRename(wf.id); if (e.key === 'Escape') cancelRename(); }}
									aria-label={t('workflow_library.rename')}
									class="w-full min-h-11 md:[@media(hover:hover)]:min-h-0 rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1 text-[16px] md:text-sm focus:border-accent focus:outline-none"
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
						<div class="flex flex-wrap items-center gap-2 md:max-w-[50%] lg:max-w-none md:shrink-0 md:justify-end md:mt-0.5">
							{#if editingId === wf.id}
								<button onclick={() => void saveRename(wf.id)} class="inline-flex items-center rounded-[var(--radius-sm)] border border-success/30 bg-success/10 {actionSize} text-success hover:bg-success/20 transition-colors">{t('workflow_library.save')}</button>
								<button onclick={cancelRename} class="inline-flex items-center rounded-[var(--radius-sm)] border border-border bg-bg-muted {actionSize} text-text-muted hover:bg-bg transition-colors">{t('workflow_library.cancel')}</button>
							{:else}
								<button
									onclick={() => onRunClick(wf)}
									disabled={runningId !== null}
									class="flex items-center gap-1 {revealOnHover} rounded-[var(--radius-sm)] border border-accent/30 bg-accent/10 {actionSize} text-accent-text hover:bg-accent/20 transition-opacity disabled:cursor-not-allowed disabled:opacity-50 md:[@media(hover:hover)]:disabled:opacity-0 group-hover:disabled:opacity-50 group-focus-within:disabled:opacity-50"
								>
									<Icon name="bolt" size="xs" />
									{runningId === wf.id ? t('workflow_library.running') : t('workflow_library.run')}
								</button>
								{#if wf.mode === 'autonomous'}
									<button
										onclick={() => onScheduleClick(wf)}
										class="flex items-center gap-1 {revealOnHover} rounded-[var(--radius-sm)] border border-accent/30 bg-accent/10 {actionSize} text-accent-text hover:bg-accent/20 transition-opacity"
									>
										<Icon name="clock" size="xs" />
										{t('workflow_library.schedule')}
									</button>
								{/if}
								<button
									onclick={() => onEditInChat(wf)}
									class="flex items-center gap-1 {revealOnHover} rounded-[var(--radius-sm)] border border-accent/30 bg-accent/10 {actionSize} text-accent-text hover:bg-accent/20 transition-opacity"
								>
									<Icon name="chat" size="xs" />
									{t('workflow_library.edit_in_chat')}
								</button>
								<button onclick={() => startRename(wf)} class="flex items-center gap-1 {revealOnHover} rounded-[var(--radius-sm)] border border-border bg-bg-muted {actionSize} text-text-muted hover:bg-bg transition-opacity">
									<Icon name="pencil" size="xs" />
									{t('workflow_library.rename')}
								</button>
								<button onclick={() => void deleteWorkflow(wf.id)} class="flex items-center gap-1 {revealOnHover} rounded-[var(--radius-sm)] border border-danger/30 bg-danger/10 {actionSize} text-danger hover:bg-danger/20 transition-opacity">
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
					<ul class="space-y-0.5 text-text-subtle font-mono">
						{#each contractTuples(c) as line (line)}
							<li>{line}</li>
						{/each}
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
					oninput={dropGrantPreview}
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
								oninput={dropGrantPreview}
								onkeydown={onScheduleKey}
								class="w-full rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1 text-[16px] md:text-sm focus:border-accent focus:outline-none"
							/>
						</label>
					{/each}
				</div>
			{/if}

			{#if grantEnabled}
				<div class="mt-4 rounded-[var(--radius-sm)] border border-border p-3 text-xs">
					<label class="flex items-center gap-2 font-medium">
						<input type="checkbox" bind:checked={grantOpen} onchange={dropGrantPreview} />
						{t('workflow_library.grant_toggle')}
					</label>
					{#if grantOpen}
						<p class="mt-2 text-[10px] text-text-subtle">{t('workflow_library.grant_hint')}</p>
						<div class="mt-3 grid grid-cols-[auto_1fr] items-center gap-2">
							<span>{t('workflow_library.grant_method')}</span>
							<select bind:value={grantMethod} onchange={dropGrantPreview} class="rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1 text-[16px] md:text-sm">
								<option value="POST">POST</option>
								<option value="PUT">PUT</option>
								<option value="PATCH">PATCH</option>
							</select>
							<span>{t('workflow_library.grant_host')}</span>
							<input bind:value={grantHost} oninput={dropGrantPreview} placeholder="api.example.com" autocomplete="off" class="rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1 font-mono text-[16px] md:text-sm focus:border-accent focus:outline-none" />
						</div>
						<label class="mt-2 block">
							<span class="block mb-1">{t('workflow_library.grant_paths')}</span>
							<textarea bind:value={grantPaths} oninput={dropGrantPreview} rows="3" placeholder="/v1/reports" class="w-full rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1 font-mono text-[16px] md:text-sm focus:border-accent focus:outline-none"></textarea>
						</label>
						<label class="mt-2 flex items-start gap-2">
							<input type="checkbox" bind:checked={grantAfterUntrusted} onchange={dropGrantPreview} class="mt-0.5" />
							<span>{t('workflow_library.grant_after_untrusted')}<span class="block text-[10px] text-text-subtle">{t('workflow_library.grant_after_untrusted_hint')}</span></span>
						</label>
						<label class="mt-2 block">
							<span class="block mb-1">{t('workflow_library.grant_name')}</span>
							<input bind:value={grantName} autocomplete="name" class="w-full rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1 text-[16px] md:text-sm focus:border-accent focus:outline-none" />
						</label>
						<button
							onclick={previewGrant}
							disabled={previewing}
							class="mt-3 rounded-[var(--radius-sm)] border border-border bg-bg-muted px-3 py-1 text-xs hover:bg-bg transition-colors disabled:opacity-50"
						>{t('workflow_library.grant_preview')}</button>
						{#if grantPreview}
							<div class="mt-3 rounded-[var(--radius-sm)] border border-warning/30 bg-warning/10 p-2">
								<p class="font-medium mb-1">{t('workflow_library.grant_preview_title')}</p>
								<ul class="space-y-0.5 font-mono text-text-subtle">
									{#each grantPreview.tuples as line (line)}
										<li>{line}</li>
									{/each}
								</ul>
								{#if Object.keys(grantPreview.boundParams).length > 0}
									<p class="mt-2 font-medium">{t('workflow_library.grant_values')}</p>
									<ul class="space-y-0.5 font-mono text-text-subtle">
										{#each Object.entries(grantPreview.boundParams) as [name, value] (name)}
											<li>{name} = {String(value)}</li>
										{/each}
									</ul>
								{/if}
								{#if grantAfterUntrusted}
									<p class="mt-2">{t('workflow_library.grant_after_untrusted_on')}</p>
								{/if}
								{#if grantPreview.binding === 'unkeyed'}
									<p class="mt-2 flex items-center gap-1"><Icon name="warning" size="xs" />{t('workflow_library.grant_unkeyed')}</p>
								{/if}
							</div>
						{/if}
					{/if}
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
