<!--
	BulkRunDetail — one bulk run: its steps, counts, preview per target, and the owner's next
	act (PRD bulk-changes-reversible §3.9): approve a preview, confirm a probe, prepare and
	approve an undo. Each act sends what this page was shown — the approval checksum the
	route returned with the run — so a run that changed since is refused, not approved.
-->
<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { formatCost } from '../format.js';
	import { t, tf, getLocale } from '../i18n.svelte.js';
	import {
		BULK_STEPS, bulkAtProbe, bulkHostOf, bulkLabel, bulkStep, bulkSystemName, bulkValueText, bulkWriting,
		type BulkRunDetailData, type BulkTarget,
	} from './bulk-runs.js';

	let { runId, onBack, onOpen }: { runId: string; onBack: () => void; onOpen: (id: string) => void } = $props();

	// As many as the prototype showed: the owner's next act stays in view below them.
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
	let probeOk = $state(false);
	let maxTargets = $state(1);

	async function json<T>(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: T }> {
		const res = await fetch(`${getApiBase()}${path}`, init);
		const body = (await res.json().catch(() => ({}))) as T;
		return { ok: res.ok, status: res.status, body };
	}

	function post(path: string, body?: unknown): Promise<{ ok: boolean; status: number; body: { error?: string; id?: string } }> {
		return json(path, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body ?? {}),
		});
	}

	async function loadTargets(offset: number, limit: number): Promise<BulkTarget[]> {
		const r = await json<{ targets?: BulkTarget[] }>(`/bulk/runs/${encodeURIComponent(runId)}/targets?offset=${offset}&limit=${limit}`);
		return r.ok ? (r.body.targets ?? []) : [];
	}

	/** Every target an undo deletes — the entries its source created, listed in full (F3). */
	async function loadCreates(total: number): Promise<BulkTarget[]> {
		const out: BulkTarget[] = [];
		for (let offset = 0; offset < total; offset += PAGE) {
			const page = await loadTargets(offset, PAGE);
			out.push(...page.filter((x) => x.change === 'delete'));
			if (page.length < PAGE) break;
		}
		return out;
	}

	async function load(): Promise<void> {
		loading = true;
		error = '';
		try {
			const r = await json<BulkRunDetailData>(`/bulk/runs/${encodeURIComponent(runId)}`);
			if (!r.ok) { error = t('common.load_failed'); loading = false; return; }
			run = r.body;
			targets = await loadTargets(0, FIRST_PAGE);
			creates = run.kind === 'undo' ? await loadCreates(run.total) : [];
			maxTargets = Math.max(1, bulkWriting(run));
			unmeasuredOk = false;
			probeOk = false;
		} catch {
			error = t('common.load_failed');
		}
		loading = false;
	}

	async function showMore(): Promise<void> {
		targets = [...targets, ...(await loadTargets(targets.length, PAGE))];
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

	const refusalOf = (r: { ok: boolean; body: { error?: string } }): string | null =>
		r.ok ? null : (r.body.error ?? t('common.load_failed'));

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

	function approveUndo(): Promise<void> {
		return act(async () => {
			if (!run?.checksum) return t('common.load_failed');
			return refusalOf(await post(`/bulk/runs/${encodeURIComponent(runId)}/approve`, { checksum: run.checksum }));
		});
	}

	/** Confirm the probe, then resume with the cap the owner set — against the checksum the
	 *  run carries after the confirmation, read fresh rather than reused. */
	function confirmProbeAndResume(): Promise<void> {
		return act(async () => {
			const confirmed = await post(`/bulk/runs/${encodeURIComponent(runId)}/confirm-probe`);
			if (!confirmed.ok) return refusalOf(confirmed);
			const fresh = await json<BulkRunDetailData>(`/bulk/runs/${encodeURIComponent(runId)}`);
			if (!fresh.ok || !fresh.body.checksum) return t('common.load_failed');
			return refusalOf(await post(`/bulk/runs/${encodeURIComponent(runId)}/resume`, { checksum: fresh.body.checksum, maxTargets }));
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

	const host = $derived(run ? bulkHostOf(run.targetSystem) : null);
	const atProbe = $derived(run !== null && bulkAtProbe(run));
	const step = $derived(run ? bulkStep(run) : 0);
	const provider = $derived(run ? bulkSystemName(run.targetSystem, i18n) : '');
	// The unmeasured note in English is the engine's own sentence; German is the approved translation.
	const unmeasuredNote = $derived(getLocale() === 'de' || !run?.writeFormNote ? t('bulk.approve.unmeasured_note') : run.writeFormNote);
	const unmeasuredConfirmation = $derived(getLocale() === 'de' || !run?.writeFormConfirmation ? t('bulk.approve.unmeasured_confirm') : run.writeFormConfirmation);
	const canUndo = $derived(run !== null && run.kind === 'apply' && !atProbe && run.applied - run.undone > 0
		&& (run.phase === 'done' || run.phase === 'aborted' || ((run.phase === 'writing' || run.phase === 'approved') && run.haltReason !== null)));

	const btn = 'rounded-[var(--radius-sm)] px-3 py-1.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed';
	const btnPrimary = `${btn} bg-accent text-accent-fg hover:opacity-90`;
	const btnPlain = `${btn} border border-border hover:bg-bg-muted`;
	const inputClass = 'w-24 rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1 text-sm';
</script>

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
					<dt class="text-text-subtle">{t('bulk.head.halted')}</dt>
					<dd>{atProbe ? t('bulk.halted_after_probe') : run.haltReason}</dd>
				{/if}
			</dl>

			{#if run.resumesAt}
				<p class="text-sm rounded-[var(--radius-sm)] bg-warning/10 border border-warning/30 px-3 py-2">{tf('bulk.resumes_at', { time: when(run.resumesAt) })}</p>
			{/if}
			{#if run.phase === 'planned' && run.haltReason !== null}
				<p class="text-sm text-text-muted">{t('bulk.awaiting_start')}</p>
			{/if}
			{#if run.conflicts > 0}
				<p class="text-sm text-text-muted">{tf('bulk.conflicts', { n: String(run.conflicts) })}</p>
			{/if}

			{#if run.kind === 'apply' && targets.length > 0}
				<div>
					<h2 class="text-sm font-medium mb-2">{tf('bulk.preview.title', { k: String(targets.length), n: String(run.total) })}</h2>
					<div class="overflow-x-auto">
						<table class="w-full text-sm">
							<thead>
								<tr class="text-left text-xs text-text-subtle border-b border-border">
									<th class="py-1.5 pr-3 font-medium">{t('bulk.head.target')}</th>
									<th class="py-1.5 font-medium">{t('bulk.preview.before_after')}</th>
								</tr>
							</thead>
							<tbody>
								{#each targets as target (target.seq)}
									<tr class="border-b border-border align-top">
										<td class="py-1.5 pr-3"><code class="text-xs break-all">{target.key}</code></td>
										<td class="py-1.5">
											{#if target.diff.kind === 'fields'}
												{#each target.diff.fields as f (f.field)}
													<div>
														<span class="text-text-subtle">{f.field}:</span>
														{#if bulkValueText(f.before) === ''}<span class="text-text-subtle">{t('bulk.preview.empty_value')}</span>{:else}<del class="text-danger">{bulkValueText(f.before)}</del>{/if}
														→ <ins class="text-success no-underline">{bulkValueText(f.after)}</ins>
													</div>
												{/each}
											{:else if target.diff.kind === 'text'}
												<pre class="text-xs whitespace-pre-wrap">{#each target.diff.removed as line}<del class="text-danger">- {line}</del>
{/each}{#each target.diff.added as line}<ins class="text-success no-underline">+ {line}</ins>
{/each}</pre>
											{:else if target.error}
												<span class="text-text-subtle">{target.error}</span>
											{/if}
											{#if target.sentUnchanged && target.sentUnchanged.length > 0}
												<div class="text-xs text-text-subtle">{tf('bulk.preview.sent_unchanged', { fields: target.sentUnchanged.join(', ') })}</div>
											{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					{#if targets.length < run.total}
						<button type="button" class="{btnPlain} mt-2" onclick={showMore}>{tf('bulk.preview.show_all', { n: String(run.total) })}</button>
					{/if}
				</div>
			{/if}

			{#if run.phase === 'previewed' && run.kind === 'apply'}
				<div class="space-y-3 border-t border-border pt-4">
					<h2 class="text-sm font-medium">{t('bulk.approve.title')}</h2>
					{#if run.writeForm === 'unmeasured'}
						<p class="text-sm rounded-[var(--radius-sm)] bg-warning/10 border border-warning/30 px-3 py-2">{unmeasuredNote}</p>
						<label class="flex gap-2 items-start text-sm">
							<input type="checkbox" bind:checked={unmeasuredOk} class="mt-1" />
							<span>{unmeasuredConfirmation}</span>
						</label>
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
							disabled={busy || (run.writeForm === 'unmeasured' && !unmeasuredOk)}
							onclick={() => approve(host !== null && !run!.probeConfirmed)}>
							{host !== null && !run.probeConfirmed ? t('bulk.approve.write_one') : t('bulk.approve.approve')}
						</button>
						<button type="button" class={btnPlain} onclick={onBack}>{t('bulk.not_now')}</button>
					</div>
				</div>
			{:else if atProbe && run.probe}
				<div class="space-y-3 border-t border-border pt-4">
					<h2 class="text-sm font-medium">{t('bulk.probe.title')}</h2>
					<p class="text-sm">{tf('bulk.probe.explain', { target: run.probe.key, provider, field: run.probe.fields.join(', ') })}</p>
					<label class="flex gap-2 items-start text-sm">
						<input type="checkbox" bind:checked={probeOk} class="mt-1" />
						<span>{tf('bulk.probe.confirm', { provider })}{run.writeForm === 'measured' ? ` ${tf('bulk.probe.confirm_measured', { provider })}` : ''}</span>
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
					{#if creates.length > 0}
						<div class="text-sm rounded-[var(--radius-sm)] bg-warning/10 border border-warning/30 px-3 py-2">
							<p>{tf('bulk.undo.creates', { k: String(creates.length) })}</p>
							<ul class="list-disc pl-5 mt-1">
								{#each creates as c (c.seq)}<li><code class="text-xs break-all">{c.key}</code></li>{/each}
							</ul>
						</div>
					{/if}
					<div class="flex flex-wrap gap-2">
						<button type="button" class={btnPrimary} disabled={busy} onclick={approveUndo}>{t('bulk.undo.approve')}</button>
						<button type="button" class={btnPlain} onclick={onBack}>{t('bulk.not_now')}</button>
					</div>
				</div>
			{:else if canUndo}
				<div class="space-y-3 border-t border-border pt-4">
					<h2 class="text-sm font-medium">{t('bulk.undo.title')}</h2>
					<p class="text-sm">{t('bulk.undo.explain')}</p>
					<button type="button" class={btnPlain} disabled={busy} onclick={planUndo}>{t('bulk.undo.prepare')}</button>
				</div>
			{/if}

			{#if actionError}
				<p class="text-sm text-danger">{actionError}</p>
			{/if}
		</section>
	{/if}
</div>
