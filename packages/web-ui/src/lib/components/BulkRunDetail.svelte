<!--
	BulkRunDetail — one bulk run: its steps, counts, preview per target, and the owner's next
	act (PRD bulk-changes-reversible §3.9): start a run that waits for its start, approve a
	preview, confirm a probe, prepare and approve an undo. Each act sends what this page was
	shown — the approval checksum, the list's start checksum or the judge rule's hash the route
	returned with the run — so a run that changed since is refused, not approved.
-->
<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { formatCost } from '../format.js';
	import { t, tf, getLocale } from '../i18n.svelte.js';
	import {
		BULK_STEPS, bulkAtProbe, bulkCanUndo, bulkCostCap, bulkHaltCause, bulkHaltHeadKey, bulkHaltText, bulkInvalidText, bulkSkippedHead, bulkFieldNamesText, bulkHostOf, bulkIsShopifyHost, bulkJudgeProviderName, bulkLabel, bulkManagedOf, bulkRestartCap, bulkRestartKind, bulkResumeKind, bulkResumeMax, bulkResumeText, bulkRollbackIncomplete, bulkRollbackLeft, bulkSentUnknownText, bulkStartButtonKey, bulkStartKind, bulkStep, bulkSupportMailto, bulkUsd, bulkVisibleText, bulkSystemName, bulkValueText, bulkWaitsForStart, bulkWriting, BULK_DESELECT_REFUSALS,
		type BulkRunDetailData, type BulkTarget,
	} from './bulk-runs.js';

	let { runId, onBack, onOpen }: { runId: string; onBack: () => void; onOpen: (id: string) => void } = $props();

	// A first page short enough that the owner's next act stays in view below it.
	const i18n = { t, tf };
	const FIRST_PAGE = 6;
	const PAGE = 500;

	let run = $state<BulkRunDetailData | null>(null);
	let targets = $state<BulkTarget[]>([]);
	let creates = $state<BulkTarget[]>([]);
	let loading = $state(true);
	let error = $state('');
	let actionError = $state('');
	let busy = $state(false);
	let unmeasuredOk = $state(false);
	// Unchanged targets fold away: the owner checks what is written and what lynox leaves out.
	let showUnchanged = $state(false);
	let probeOk = $state(false);
	let maxTargets = $state(1);
	// The spend limit of a judged start, as the owner types it; no default (there is no estimate).
	let capInput = $state('');
	// The started, unapproved judged run a judged start would end, once the engine has named it.
	let supersedable = $state<{ id: string; costUsd: number } | null>(null);
	// Whether this is a managed instance: two halt sentences name a different next step there.
	// Unknown (not yet loaded, or the config could not be read) reads as managed.
	let managed = $state<boolean | null>(null);

	async function json<T>(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: T }> {
		const res = await fetch(`${getApiBase()}${path}`, init);
		const body = (await res.json().catch(() => ({}))) as T;
		return { ok: res.ok, status: res.status, body };
	}

	type PostBody = { error?: string; id?: string; code?: string; supersedable?: { id: string; costUsd: number } };
	function post(path: string, body?: unknown): Promise<{ ok: boolean; status: number; body: PostBody }> {
		return json(path, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body ?? {}),
		});
	}

	/** A page of the run's targets. A failed fetch throws: an empty page would read as a run
	 *  with fewer targets than the approval covers. */
	async function loadTargets(offset: number, limit: number): Promise<BulkTarget[]> {
		const r = await json<{ targets?: BulkTarget[] }>(`/bulk/runs/${encodeURIComponent(runId)}/targets?offset=${offset}&limit=${limit}`);
		if (!r.ok || !Array.isArray(r.body.targets)) throw new Error('targets');
		return r.body.targets;
	}

	/** Every target from `offset` on, page by page (the route serves at most PAGE at once). */
	async function loadFrom(offset: number, total: number): Promise<BulkTarget[]> {
		const out: BulkTarget[] = [];
		for (let at = offset; at < total; at += PAGE) {
			const page = await loadTargets(at, PAGE);
			out.push(...page);
			if (page.length < PAGE) break;
		}
		return out;
	}

	/** Every target an undo deletes — the entries its source created, listed in full. The
	 *  approval deletes all of them, so a list shorter than the run's own count is not shown
	 *  as the whole: it fails, and approving waits for a page that lists them all. */
	async function loadCreates(r: BulkRunDetailData): Promise<BulkTarget[]> {
		const out = (await loadFrom(0, r.total)).filter((x) => x.change === 'delete');
		if (out.length !== r.changes.delete) throw new Error('creates');
		return out;
	}

	async function load(): Promise<void> {
		loading = true;
		error = '';
		try {
			const r = await json<BulkRunDetailData>(`/bulk/runs/${encodeURIComponent(runId)}`);
			if (!r.ok) { error = t('common.load_failed'); loading = false; return; }
			// The run is shown only with its targets: a page that could not load them all shows
			// the error, never a run whose approval covers more than it lists.
			// A preview the owner approves is loaded whole: the approval covers every target, and
			// each one the owner may take out has to be on the page to be taken out.
			// So is a run whose rollback left targets: the sentence names the marked ones, and each
			// has to be on the page to be seen.
			const approving = r.body.phase === 'previewed' && r.body.kind === 'apply';
			const whole = approving || bulkRollbackIncomplete(r.body);
			const shown = whole ? await loadFrom(0, r.body.total) : await loadTargets(0, FIRST_PAGE);
			// A short page ends the loading early: fewer targets than the run's count are not the whole.
			if (whole && shown.length !== r.body.total) { error = t('common.load_failed'); loading = false; return; }
			const deleted = r.body.kind === 'undo' ? await loadCreates(r.body) : [];
			run = r.body;
			targets = shown;
			creates = deleted;
			maxTargets = Math.max(1, bulkWriting(run));
			unmeasuredOk = false;
			probeOk = false;
			supersedable = null;
		} catch {
			error = t('common.load_failed');
		}
		loading = false;
	}

	async function showMore(): Promise<void> {
		if (!run) return;
		try {
			targets = [...targets, ...(await loadFrom(targets.length, run.total))];
		} catch {
			actionError = t('common.load_failed');
		}
	}

	async function act(fn: () => Promise<string | null>): Promise<void> {
		busy = true;
		actionError = '';
		try {
			const refusal = await fn();
			if (refusal !== null) actionError = refusal;
			else await load();
		} catch {
			actionError = t('common.load_failed');
		}
		busy = false;
	}

	// A run no one can be shown to have planned is refused a resume by its code, worded here.
	const refusalOf = (r: { ok: boolean; body: { error?: string; code?: string } }): string | null =>
		r.ok ? null : r.body.code === 'planner_unknown' ? t('bulk.resume.refused.planner_unknown') : (r.body.error ?? t('common.load_failed'));

	function approve(oneFirst: boolean): Promise<void> {
		return act(async () => {
			if (!run?.checksum) return t('common.load_failed');
			return refusalOf(await post(`/bulk/runs/${encodeURIComponent(runId)}/approve`, {
				checksum: run.checksum,
				maxTargets: oneFirst ? 1 : maxTargets,
				...(run.writeForm === 'unmeasured' ? { unmeasuredConfirmed: unmeasuredOk } : {}),
			}));
		});
	}

	/** Take one target out of the write, or put it back, against the checksum this page showed:
	 *  each moves the checksum, so the page reloads and approves only the run as it now is. */
	function toggleSelected(target: BulkTarget): Promise<void> {
		return act(async () => {
			if (!run?.checksum) return t('common.load_failed');
			const verb = target.deselected ? 'reselect' : 'deselect';
			const r = await post(`/bulk/runs/${encodeURIComponent(runId)}/targets/${target.seq}/${verb}`, { checksum: run.checksum });
			// The refusals the owner can meet here are worded by their code; the engine's English is the fallback.
			const code = r.body.code;
			if (!r.ok && code !== undefined && BULK_DESELECT_REFUSALS.includes(code)) return t(`bulk.deselect.refused.${code}`);
			return refusalOf(r);
		});
	}

	function approveUndo(): Promise<void> {
		return act(async () => {
			if (!run?.checksum) return t('common.load_failed');
			return refusalOf(await post(`/bulk/runs/${encodeURIComponent(runId)}/approve`, { checksum: run.checksum }));
		});
	}

	/** Confirm the probe, then resume with the cap the owner set — against the checksum of the
	 *  run as this page showed it. The checksum does not cover the probe, so confirming does
	 *  not move it; a run that changed since it was shown is refused, never resumed. */
	function confirmProbeAndResume(): Promise<void> {
		return act(async () => {
			if (!run?.checksum) return t('common.load_failed');
			const shown = run.checksum;
			const confirmed = await post(`/bulk/runs/${encodeURIComponent(runId)}/confirm-probe`);
			if (!confirmed.ok) return refusalOf(confirmed);
			return refusalOf(await post(`/bulk/runs/${encodeURIComponent(runId)}/resume`, { checksum: shown, maxTargets }));
		});
	}

	/** Start a run that waits for its start, with what this page showed: a list read with the
	 *  list's start checksum, a judged start with the rule's hash and the spend limit as typed.
	 *  A judged start never ends another run unasked: the engine names it, the owner sees what
	 *  it has spent, and only a second click with its id ends it. */
	function start(supersedes?: string): Promise<void> {
		return act(async () => {
			if (!run) return t('common.load_failed');
			const kind = bulkStartKind(run);
			let body: Record<string, unknown> = {};
			if (kind === 'list') {
				if (!run.listStartChecksum) return t('common.load_failed');
				body = { listChecksum: run.listStartChecksum };
			} else if (kind === 'judge') {
				const cap = bulkCostCap(capInput);
				if (cap === null) return t('bulk.start.cap_invalid');
				if (!run.judgeRuleHash) return t('common.load_failed');
				body = { judgeRuleHash: run.judgeRuleHash, costCapUsd: cap, ...(supersedes !== undefined ? { supersedes } : {}) };
			} else if (kind !== 'read') {
				return t('common.load_failed');
			}
			const r = await post(`/bulk/runs/${encodeURIComponent(runId)}/resume`, body);
			if (!r.ok && r.body.code === 'supersede_required' && r.body.supersedable) {
				supersedable = r.body.supersedable;
				return '';
			}
			// A refused start may have changed the run (an ended mandate ends it): show it as it is now.
			// If that reload fails, the page shows the refusal in place of the run, not that loading failed.
			const refusal = refusalOf(r);
			if (refusal !== null) {
				await load();
				if (error) error = refusal;
			} else {
				// A started run that halts on its limit later offers an empty field, not this one.
				capInput = '';
			}
			return refusal;
		});
	}

	/** Move a planned run on that halted on a failure (`bulkRestartKind`), with what this page
	 *  showed: a list's start checksum, a judged run's rule hash, and on a run halted at its spend
	 *  limit the higher limit as typed. Without a new limit a judged run keeps the one it started
	 *  with. A judged restart ends another started judged run only as a start does: named first. */
	function restart(supersedes?: string): Promise<void> {
		return act(async () => {
			if (!run) return t('common.load_failed');
			const kind = bulkRestartKind(run);
			let body: Record<string, unknown> = {};
			if (kind === 'list') {
				if (!run.listStartChecksum) return t('common.load_failed');
				body = { listChecksum: run.listStartChecksum };
			} else if (kind === 'judge' || kind === 'judge_cap') {
				if (!run.judgeRuleHash) return t('common.load_failed');
				body = { judgeRuleHash: run.judgeRuleHash, ...(supersedes !== undefined ? { supersedes } : {}) };
				if (kind === 'judge_cap') {
					const cap = bulkRestartCap(capInput, run.costCapUsd);
					if (cap === null) return tf('bulk.restart.cap_low', { cap: bulkUsd(run.costCapUsd ?? 0) });
					body['costCapUsd'] = cap;
				}
			} else if (kind !== 'read') {
				return t('common.load_failed');
			}
			const r = await post(`/bulk/runs/${encodeURIComponent(runId)}/resume`, body);
			if (!r.ok && r.body.code === 'supersede_required' && r.body.supersedable) {
				supersedable = r.body.supersedable;
				return '';
			}
			const refusal = refusalOf(r);
			if (refusal !== null) {
				await load();
				if (error) error = refusal;
			} else {
				capInput = '';
			}
			return refusal;
		});
	}

	/** Write on a run that halted while writing (`bulkResumeKind`), against the checksum of the
	 *  run as this page showed it: a run that changed since is refused, never written on. A run
	 *  halted at its maximum writes on only under the higher maximum the owner typed. */
	function resume(): Promise<void> {
		return act(async () => {
			if (!run?.checksum) return t('common.load_failed');
			const kind = bulkResumeKind(run);
			const body: Record<string, unknown> = { checksum: run.checksum };
			if (kind === 'max') {
				const max = bulkResumeMax(maxTargets, run.maxTargets, bulkWriting(run));
				if (max === null) return tf('bulk.resume.max_more', { max: String(run.maxTargets ?? 0), all: String(bulkWriting(run)) });
				body['maxTargets'] = max;
			} else if (kind !== 'write') {
				return t('common.load_failed');
			}
			return refusalOf(await post(`/bulk/runs/${encodeURIComponent(runId)}/resume`, body));
		});
	}

	/** Plan the undo of this run; it is a run of its own, opened for its second approval. */
	function planUndo(): Promise<void> {
		return act(async () => {
			const r = await post(`/bulk/runs/${encodeURIComponent(runId)}/undo`);
			if (!r.ok) return refusalOf(r);
			if (r.body.id) onOpen(r.body.id);
			return null;
		});
	}

	function when(iso: string): string {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		return d.toLocaleString(getLocale() === 'de' ? 'de-CH' : 'en-US', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
	}

	$effect(() => { void runId; void load(); });
	$effect(() => {
		fetch(`${getApiBase()}/config`)
			.then(async (r) => { managed = bulkManagedOf(r.ok, r.ok ? await r.json() : null); })
			.catch(() => { managed = null; });
	});

	const host = $derived(run ? bulkHostOf(run.targetSystem) : null);
	const atProbe = $derived(run !== null && bulkAtProbe(run));
	const step = $derived(run ? bulkStep(run) : 0);
	const provider = $derived(run ? bulkSystemName(run.targetSystem, i18n) : '');
	// The unmeasured note in English is the engine's own sentence; German is the approved translation.
	const unmeasuredNote = $derived(getLocale() === 'de' || !run?.writeFormNote ? t('bulk.approve.unmeasured_note') : run.writeFormNote);
	const unmeasuredConfirmation = $derived(getLocale() === 'de' || !run?.writeFormConfirmation ? t('bulk.approve.unmeasured_confirm') : run.writeFormConfirmation);
	const canUndo = $derived(run !== null && bulkCanUndo(run));
	const startKind = $derived(run ? bulkStartKind(run) : null);
	// The start button's label, from the same source as the button itself: the halt sentence names it.
	const startButton = $derived(run ? bulkStartButtonKey(run, startKind, supersedable !== null) : null);
	const supportMail = $derived(run ? bulkSupportMailto(run, managed, i18n) : null);
	const restartKind = $derived(run ? bulkRestartKind(run) : null);
	const haltText = $derived(run ? bulkHaltText(run, managed, i18n) : null);
	const resumeKind = $derived(run ? bulkResumeKind(run) : null);
	const resumeText = $derived(run ? bulkResumeText(run, managed, i18n) : null);
	const sentUnknownText = $derived(run ? bulkSentUnknownText(run, i18n) : null);
	const shopify = $derived(bulkIsShopifyHost(host));
	const approving = $derived(run !== null && run.phase === 'previewed' && run.kind === 'apply');
	const skipped = $derived(run && approving ? bulkSkippedHead(run, shopify, i18n) : { text: null, nothing: false });
	const shownTargets = $derived(showUnchanged ? targets : targets.filter((x) => x.change !== 'unchanged'));
	const foldedUnchanged = $derived(targets.length - shownTargets.length);
	const writes = (x: BulkTarget): boolean => x.change === 'update' || x.change === 'create' || x.change === 'delete';

	const btn = 'rounded-[var(--radius-sm)] px-3 py-1.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed';
	const btnPrimary = `${btn} bg-accent text-accent-fg hover:opacity-90`;
	const btnPlain = `${btn} border border-border hover:bg-bg-muted`;
	const inputClass = 'w-24 rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1 text-sm';
</script>

<!-- Taking the run back: offered on its own, and beside writing on a run that halted. -->
{#snippet undoOffer()}
	<div class="space-y-3 border-t border-border pt-4">
		<h2 class="text-sm font-medium">{t('bulk.undo.title')}</h2>
		<p class="text-sm">{t('bulk.undo.explain')}</p>
		<button type="button" class={btnPlain} disabled={busy} onclick={planUndo}>{t('bulk.undo.prepare')}</button>
	</div>
{/snippet}

<div class="p-6 max-w-4xl mx-auto space-y-4">
	<button type="button" class={btnPlain} onclick={onBack}>{t('bulk.back')}</button>

	{#if loading && run === null}
		<p class="text-text-subtle text-sm">{t('common.loading')}</p>
	{:else if error || run === null}
		<div class="rounded-[var(--radius-md)] bg-danger/10 border border-danger/20 px-4 py-3 text-sm text-danger">{error || t('common.load_failed')}</div>
	{:else}
		<section class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4 space-y-4">
			<h1 class="text-lg font-medium">{bulkLabel(run, i18n)}</h1>

			<ol class="flex flex-wrap gap-1.5 text-[11px]">
				{#each BULK_STEPS as s, i (s)}
					<li class="rounded-full px-2 py-0.5 {i === step ? 'bg-accent text-accent-fg' : 'bg-bg-muted text-text-muted'}" aria-current={i === step ? 'step' : undefined}>{t(`bulk.step.${s}`)}</li>
				{/each}
			</ol>

			<dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
				<dt class="text-text-subtle">{t('bulk.head.target')}</dt>
				<dd>{provider}{run.writeMethod ? ` · ${run.writeMethod}` : ''}</dd>
				<dt class="text-text-subtle">{t('bulk.head.targets')}</dt>
				<dd>{tf('bulk.head.counts', { n: String(run.total), a: String(run.applied), c: String(run.conflicts), f: String(run.failed) })}</dd>
				{#if run.costUsd > 0 || run.costCapUsd !== null}
					<dt class="text-text-subtle">{t('bulk.head.cost')}</dt>
					<dd class="font-mono">{formatCost(run.costUsd)}{run.costCapUsd !== null ? ` / ${formatCost(run.costCapUsd)}` : ''}</dd>
				{/if}
				{#if run.haltReason}
					<dt class="text-text-subtle">{t(bulkHaltHeadKey(run))}</dt>
					<dd>{bulkHaltCause(run, managed, startButton === null ? null : t(startButton), i18n)}</dd>
				{/if}
			</dl>

			{#if run.resumesAt}
				<p class="text-sm rounded-[var(--radius-sm)] bg-warning/10 border border-warning/30 px-3 py-2">{tf('bulk.resumes_at', { time: when(run.resumesAt) })}</p>
			{/if}
			{#if bulkWaitsForStart(run)}
				<p class="text-sm text-text-muted">{t('bulk.awaiting_start')}</p>
			{/if}
			{#if run.phase === 'planned' && run.haltKey === 'listed'}
				<p class="text-sm">{tf(run.judge !== null ? 'bulk.start.listed_judge' : 'bulk.start.listed', { n: String(run.total) })}</p>
				<p class="text-sm rounded-[var(--radius-sm)] bg-warning/10 border border-warning/30 px-3 py-2">{t('bulk.start.list_note')}</p>
			{/if}
			{#if run.conflicts > 0}
				<p class="text-sm text-text-muted">{tf('bulk.conflicts', { n: String(run.conflicts) })}</p>
			{/if}
			{#if sentUnknownText}
				<p class="text-sm rounded-[var(--radius-sm)] bg-warning/10 border border-warning/30 px-3 py-2">{sentUnknownText}</p>
			{/if}

			{#if run.kind === 'apply' && targets.length > 0}
				<div>
					<h2 class="text-sm font-medium mb-2">{tf('bulk.preview.title', { k: String(targets.length), n: String(run.total) })}</h2>
					{#if skipped.text && !skipped.nothing}
						<p class="text-sm mb-2">{skipped.text}</p>
					{/if}
					<div class="overflow-x-auto">
						<table class="w-full text-sm">
							<thead>
								<tr class="text-left text-xs text-text-subtle border-b border-border">
									<th class="py-1.5 pr-3 font-medium">{t('bulk.head.target')}</th>
									<th class="py-1.5 font-medium">{t('bulk.preview.before_after')}</th>
								</tr>
							</thead>
							<tbody>
								{#each shownTargets as target (target.seq)}
									<tr class="border-b border-border align-top {target.deselected ? 'opacity-60' : ''}">
										<td class="py-1.5 pr-3">
											<code class="text-xs break-all">{bulkVisibleText(target.key)}</code>
											{#if bulkRollbackLeft(run, target)}
												<span class="ml-1 inline-block rounded-full bg-warning/15 border border-warning/40 px-1.5 text-[11px] text-warning" data-testid="bulk-rollback-left">{t('bulk.target.not_taken_back')}</span>
											{/if}
										</td>
										<td class="py-1.5">
											{#if target.diff.kind === 'fields'}
												{#each target.diff.fields as f (f.field)}
													<div>
														<span class="text-text-subtle">{bulkVisibleText(f.field)}:</span>
														{#if bulkValueText(f.before) === ''}<span class="text-text-subtle">{t('bulk.preview.empty_value')}</span>{:else}<del class="text-danger">{bulkValueText(f.before)}</del>{/if}
														→ <ins class="text-success no-underline">{bulkValueText(f.after)}</ins>
													</div>
												{/each}
											{:else if target.diff.kind === 'text'}
												<pre class="text-xs whitespace-pre-wrap">{#each target.diff.removed as line, i (i)}<del class="text-danger">- {bulkVisibleText(line)}</del>
{/each}{#each target.diff.added as line, i (i)}<ins class="text-success no-underline">+ {bulkVisibleText(line)}</ins>
{/each}</pre>
											{:else if target.error && target.change !== 'invalid'}
												<span class="text-text-subtle">{bulkVisibleText(target.error)}</span>
											{/if}
											{#if target.change === 'invalid' && target.error}
												<p class="text-sm">{bulkInvalidText(target.error, shopify, managed, i18n)}</p>
											{/if}
											{#if approving && (target.deselected || writes(target))}
												<div class="mt-1 flex flex-wrap items-center gap-2 text-xs">
													{#if target.deselected}<span class="text-text-subtle">{t('bulk.deselect.taken_out')}</span>{/if}
													<button type="button" class="{btnPlain} text-xs" disabled={busy} onclick={() => toggleSelected(target)}>{t(target.deselected ? 'bulk.deselect.on' : 'bulk.deselect.off')}</button>
												</div>
											{/if}
											{#if target.sentUnchanged && target.sentUnchanged.length > 0}
												<div class="text-xs text-text-subtle">{tf('bulk.preview.sent_unchanged', { fields: bulkFieldNamesText(host, target.sentUnchanged, t) })}</div>
											{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					{#if foldedUnchanged > 0}
						<button type="button" class="{btnPlain} mt-2" onclick={() => { showUnchanged = true; }}>{tf(shopify ? 'bulk.preview.show_unchanged' : 'bulk.preview.show_unchanged_targets', { n: String(foldedUnchanged) })}</button>
					{/if}
					{#if targets.length < run.total}
						<button type="button" class="{btnPlain} mt-2" onclick={showMore}>{tf('bulk.preview.show_all', { n: String(run.total) })}</button>
					{/if}
				</div>
			{/if}

			{#if startKind === 'read'}
				<div class="space-y-3 border-t border-border pt-4">
					<p class="text-sm">{tf('bulk.start.read_explain', { provider })}</p>
					<div class="flex flex-wrap gap-2">
						<button type="button" class={btnPrimary} disabled={busy} onclick={() => start()}>{t(startButton ?? 'bulk.start.read')}</button>
						<button type="button" class={btnPlain} onclick={onBack}>{t('bulk.not_now')}</button>
					</div>
				</div>
			{:else if startKind === 'list' && run.listFirstPage}
				<div class="space-y-3 border-t border-border pt-4">
					<p class="text-sm">{tf('bulk.start.list_explain', { provider, address: bulkVisibleText(run.listFirstPage) })}</p>
					<div class="flex flex-wrap gap-2">
						<button type="button" class={btnPrimary} disabled={busy} onclick={() => start()}>{t(startButton ?? 'bulk.start.list')}</button>
						<button type="button" class={btnPlain} onclick={onBack}>{t('bulk.not_now')}</button>
					</div>
				</div>
			{:else if startKind === 'judge_own_key'}
				<p class="text-sm rounded-[var(--radius-sm)] bg-warning/10 border border-warning/30 px-3 py-2">{t('bulk.start.judge_own_key')}</p>
			{:else if startKind === 'no_judge'}
				<p class="text-sm rounded-[var(--radius-sm)] bg-warning/10 border border-warning/30 px-3 py-2">{t('bulk.start.no_judge_model')}</p>
			{:else if startKind === 'judge' && run.judgeServedBy && run.judgeRule}
				<div class="space-y-3 border-t border-border pt-4">
					<p class="text-sm">{tf('bulk.start.judge_explain', { provider: bulkJudgeProviderName(run.judgeServedBy.provider), model: run.judgeServedBy.label })}</p>
					<div>
						<h3 class="text-xs font-medium text-text-subtle mb-1">{t('bulk.start.rule')}</h3>
						<p class="text-sm whitespace-pre-wrap rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-2">{bulkVisibleText(run.judgeRule.rule)}</p>
					</div>
					<div>
						<h3 class="text-xs font-medium text-text-subtle mb-1">{t('bulk.start.fields')}</h3>
						<ul class="text-sm space-y-0.5">
							{#each Object.entries(run.judgeRule.schema.properties) as [field, shape] (field)}
								<li><code class="text-xs">{bulkVisibleText(field)}</code> <span class="text-xs text-text-subtle break-all">{bulkValueText(shape)}</span></li>
							{/each}
						</ul>
					</div>
					<div class="text-sm space-y-1">
						<label class="flex flex-wrap items-center gap-2">
							{t('bulk.start.cap_prefix')}
							<input type="text" inputmode="decimal" class={inputClass} bind:value={capInput} aria-invalid={capInput !== '' && bulkCostCap(capInput) === null} />
							{t('bulk.start.cap_suffix')}
						</label>
						<p class="text-text-muted">{t('bulk.start.cap_explain')}</p>
						{#if capInput !== '' && bulkCostCap(capInput) === null}
							<p class="text-danger">{t('bulk.start.cap_invalid')}</p>
						{/if}
					</div>
					{#if supersedable}
						<div class="space-y-2 text-sm rounded-[var(--radius-sm)] bg-warning/10 border border-warning/30 px-3 py-2">
							<p>{tf('bulk.start.supersede', { cost: formatCost(supersedable.costUsd) })}</p>
							<div class="flex flex-wrap gap-2">
								<button type="button" class={btnPrimary} disabled={busy || bulkCostCap(capInput) === null} onclick={() => start(supersedable!.id)}>{t(startButton ?? 'bulk.start.supersede_yes')}</button>
								<button type="button" class={btnPlain} onclick={() => { supersedable = null; }}>{t('bulk.not_now')}</button>
							</div>
						</div>
					{:else}
						<div class="flex flex-wrap gap-2">
							<button type="button" class={btnPrimary} disabled={busy || bulkCostCap(capInput) === null} onclick={() => start()}>{t(startButton ?? 'bulk.start.judge')}</button>
							<button type="button" class={btnPlain} onclick={onBack}>{t('bulk.not_now')}</button>
						</div>
					{/if}
				</div>
			{:else if restartKind !== null}
				<div class="space-y-3 border-t border-border pt-4">
					{#if haltText?.before}
						<p class="text-sm">{haltText.before}</p>
					{/if}
					{#if supportMail}
						<p class="text-sm"><a href={supportMail} class="{btnPlain} inline-block">{t('bulk.halt.support_mail')}</a></p>
					{/if}
					{#if restartKind === 'none'}
						<p class="text-sm rounded-[var(--radius-sm)] bg-warning/10 border border-warning/30 px-3 py-2">{t('bulk.restart.none')}</p>
					{:else if restartKind === 'judge_own_key'}
						<p class="text-sm rounded-[var(--radius-sm)] bg-warning/10 border border-warning/30 px-3 py-2">{t('bulk.start.judge_own_key')}</p>
					{:else if restartKind === 'no_judge'}
						{#if run.haltKey !== 'judgeModel'}
							<p class="text-sm rounded-[var(--radius-sm)] bg-warning/10 border border-warning/30 px-3 py-2">{t('bulk.start.no_judge_model')}</p>
						{/if}
					{:else}
						{#if restartKind === 'judge_cap'}
							<div class="text-sm space-y-1">
								<label class="flex flex-wrap items-center gap-2">
									{t('bulk.start.cap_prefix')}
									<input type="text" inputmode="decimal" class={inputClass} bind:value={capInput} aria-invalid={capInput !== '' && bulkRestartCap(capInput, run.costCapUsd) === null} />
									{t('bulk.start.cap_suffix')}
								</label>
								<p class="text-text-muted">{t('bulk.restart.cap_whole')} {t('bulk.start.cap_explain')}</p>
								{#if capInput !== '' && bulkRestartCap(capInput, run.costCapUsd) === null}
									<p class="text-danger">{tf('bulk.restart.cap_low', { cap: bulkUsd(run.costCapUsd ?? 0) })}</p>
								{/if}
							</div>
						{/if}
						<p class="text-sm text-text-muted">{t(restartKind === 'list' ? 'bulk.restart.kept_list' : 'bulk.restart.kept')}</p>
						{#if supersedable}
							<div class="space-y-2 text-sm rounded-[var(--radius-sm)] bg-warning/10 border border-warning/30 px-3 py-2">
								<p>{tf('bulk.start.supersede', { cost: formatCost(supersedable.costUsd) })}</p>
								<div class="flex flex-wrap gap-2">
									<button type="button" class={btnPrimary} disabled={busy || (restartKind === 'judge_cap' && bulkRestartCap(capInput, run.costCapUsd) === null)} onclick={() => restart(supersedable!.id)}>{t('bulk.start.supersede_yes')}</button>
									<button type="button" class={btnPlain} onclick={() => { supersedable = null; }}>{t('bulk.not_now')}</button>
								</div>
							</div>
						{:else}
							<div class="flex flex-wrap gap-2">
								<button type="button" class={btnPrimary} disabled={busy || (restartKind === 'judge_cap' && bulkRestartCap(capInput, run.costCapUsd) === null)} onclick={() => restart()}>{t(restartKind === 'list' ? 'bulk.restart.list' : restartKind === 'read' ? 'bulk.restart.read' : 'bulk.restart.judge')}</button>
								<button type="button" class={btnPlain} onclick={onBack}>{t('bulk.not_now')}</button>
							</div>
						{/if}
					{/if}
				</div>
			{:else if resumeKind !== null && resumeText}
				<div class="space-y-3 border-t border-border pt-4">
					{#if resumeText.before}
						<p class="text-sm">{resumeText.before}</p>
					{/if}
					{#if supportMail}
						<p class="text-sm"><a href={supportMail} class="{btnPlain} inline-block">{t('bulk.halt.support_mail')}</a></p>
					{/if}
					{#if resumeKind === 'none'}
						<p class="text-sm rounded-[var(--radius-sm)] bg-warning/10 border border-warning/30 px-3 py-2">{t('bulk.resume.none')}</p>
					{:else}
						{#if resumeText.soFar}
							<p class="text-sm">{resumeText.soFar}</p>
						{/if}
						{#if resumeKind === 'max'}
							<div class="text-sm space-y-1">
								<label class="flex flex-wrap items-center gap-2">
									{t('bulk.probe.in_total')}
									<input type="number" class={inputClass} min={(run.maxTargets ?? 0) + 1} max={bulkWriting(run)} bind:value={maxTargets} aria-invalid={bulkResumeMax(maxTargets, run.maxTargets, bulkWriting(run)) === null} />
									{t('bulk.probe.targets')}
								</label>
								{#if bulkResumeMax(maxTargets, run.maxTargets, bulkWriting(run)) === null}
									<p class="text-danger">{tf('bulk.resume.max_more', { max: String(run.maxTargets ?? 0), all: String(bulkWriting(run)) })}</p>
								{/if}
							</div>
						{/if}
						<p class="text-sm text-text-muted">{resumeText.kept}</p>
						{#if resumeText.allows}
							<p class="text-sm">{resumeText.allows}</p>
						{/if}
						<p class="text-sm text-text-muted">{t('bulk.resume.window')}</p>
						<div class="flex flex-wrap gap-2">
							<button type="button" class={btnPrimary} disabled={busy || (resumeKind === 'max' && bulkResumeMax(maxTargets, run.maxTargets, bulkWriting(run)) === null)} onclick={resume}>{t('bulk.resume.write')}</button>
							<button type="button" class={btnPlain} onclick={onBack}>{t('bulk.not_now')}</button>
						</div>
					{/if}
				</div>
				{#if canUndo}
					{@render undoOffer()}
				{/if}
			{:else if run.phase === 'previewed' && run.kind === 'apply'}
				<div class="space-y-3 border-t border-border pt-4">
					<h2 class="text-sm font-medium">{t('bulk.approve.title')}</h2>
					{#if run.writeForm === 'unmeasured'}
						<p class="text-sm rounded-[var(--radius-sm)] bg-warning/10 border border-warning/30 px-3 py-2">{unmeasuredNote}</p>
						<label class="flex gap-2 items-start text-sm">
							<input type="checkbox" bind:checked={unmeasuredOk} class="mt-1" />
							<span>{unmeasuredConfirmation}</span>
						</label>
					{/if}
					{#if bulkIsShopifyHost(host)}
						<p class="text-sm">{t('bulk.approve.shopify_visible')}</p>
					{/if}
					{#if host !== null && !run.probeConfirmed}
						<p class="text-sm">{t('bulk.approve.one_first')}</p>
					{:else}
						<label class="flex items-center gap-2 text-sm">
							{t('bulk.approve.at_most')}
							<input type="number" class={inputClass} min="1" max={bulkWriting(run)} bind:value={maxTargets} />
							{t('bulk.approve.targets_write')}
						</label>
					{/if}
					<div class="flex flex-wrap gap-2">
						<button type="button" class={btnPrimary}
							disabled={busy || skipped.nothing || (run.writeForm === 'unmeasured' && !unmeasuredOk)}
							aria-describedby={skipped.nothing ? 'bulk-approve-nothing' : run.writeForm === 'unmeasured' && !unmeasuredOk ? 'bulk-approve-confirm-first' : undefined}
							onclick={() => approve(host !== null && !run!.probeConfirmed)}>
							{host !== null && !run.probeConfirmed ? t('bulk.approve.write_one') : t('bulk.approve.approve')}
						</button>
						<button type="button" class={btnPlain} onclick={onBack}>{t('bulk.not_now')}</button>
					</div>
					{#if skipped.nothing}
						<p id="bulk-approve-nothing" class="text-sm">{skipped.text}</p>
					{:else if run.writeForm === 'unmeasured' && !unmeasuredOk}
						<p id="bulk-approve-confirm-first" class="text-xs text-text-subtle">{t('bulk.approve.confirm_first')}</p>
					{/if}
				</div>
			{:else if atProbe && run.probe}
				<div class="space-y-3 border-t border-border pt-4">
					<h2 class="text-sm font-medium">{t('bulk.probe.title')}</h2>
					<p class="text-sm">{run.probe.fields.length > 0
						? tf('bulk.probe.explain', { target: bulkVisibleText(run.probe.key), provider, field: bulkFieldNamesText(host, run.probe.fields, t) })
						: tf('bulk.probe.explain_whole', { target: bulkVisibleText(run.probe.key), provider })}</p>
					<label class="flex gap-2 items-start text-sm">
						<input type="checkbox" bind:checked={probeOk} class="mt-1" />
						<span>{tf(run.probe.fields.length > 0 ? 'bulk.probe.confirm' : 'bulk.probe.confirm_whole', { provider })}{run.writeForm === 'measured' ? ` ${tf('bulk.probe.confirm_measured', { provider })}` : ''}</span>
					</label>
					<label class="flex items-center gap-2 text-sm">
						{t('bulk.probe.in_total')}
						<input type="number" class={inputClass} min="1" max={bulkWriting(run)} bind:value={maxTargets} />
						{t('bulk.probe.targets')}
					</label>
					<div class="flex flex-wrap gap-2">
						<button type="button" class={btnPrimary} disabled={busy || !probeOk} onclick={confirmProbeAndResume}>{t('bulk.probe.continue')}</button>
						<button type="button" class={btnPlain} disabled={busy} onclick={planUndo}>{t('bulk.probe.undo_one')}</button>
					</div>
				</div>
			{:else if run.kind === 'undo' && run.phase === 'previewed'}
				<div class="space-y-3 border-t border-border pt-4">
					<h2 class="text-sm font-medium">{t('bulk.undo.approve_title')}</h2>
					<!-- The targets that get a value back; the entries the source created are listed apart. -->
					<p class="text-sm">{tf('bulk.undo.approve_explain', { n: String(run.changes.update + run.changes.create) })}</p>
					{#if run.changes.delete > 0}
						<div class="text-sm rounded-[var(--radius-sm)] bg-warning/10 border border-warning/30 px-3 py-2">
							<p>{tf('bulk.undo.creates', { k: String(run.changes.delete) })}</p>
							<ul class="list-disc pl-5 mt-1">
								{#each creates as c (c.seq)}<li><code class="text-xs break-all">{bulkVisibleText(c.key)}</code></li>{/each}
							</ul>
						</div>
					{/if}
					<div class="flex flex-wrap gap-2">
						<button type="button" class={btnPrimary} disabled={busy || creates.length !== run.changes.delete} onclick={approveUndo}>{t('bulk.undo.approve')}</button>
						<button type="button" class={btnPlain} onclick={onBack}>{t('bulk.not_now')}</button>
					</div>
				</div>
			{:else if canUndo}
				{@render undoOffer()}
			{/if}

			{#if actionError}
				<p class="text-sm text-danger">{actionError}</p>
			{/if}
		</section>
	{/if}
</div>
