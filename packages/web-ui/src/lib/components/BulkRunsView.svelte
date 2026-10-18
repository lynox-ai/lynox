<!--
	BulkRunsView — the owner's surface for bulk runs (PRD bulk-changes-reversible §3.9):
	the run list and the merged contacts, as the fourth tab of Activity (`?tab=bulk`). A run
	opens on its own page in the same tab (`?tab=bulk&run=<id>`, <BulkRunDetail />), so a link
	to a run survives a reload.

	Every action here is an owner's act on the engine's routes (`/api/bulk/runs…`,
	`/api/merges…`); nothing is decided in the browser. What the routes refuse they say in a
	fixed sentence, shown as it comes.
-->
<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { getApiBase } from '../config.svelte.js';
	import { formatCost } from '../format.js';
	import { t, tf, getLocale } from '../i18n.svelte.js';
	import BulkRunDetail from './BulkRunDetail.svelte';
	import { bulkLabel, bulkMergeAnswer, bulkMergeState, bulkMergeTakeable, bulkSystemName, bulkVisibleText, bulkWaitsForStart, type BulkMerge, type BulkRun } from './bulk-runs.js';

	let runs = $state<BulkRun[]>([]);
	let merges = $state<BulkMerge[]>([]);
	let loading = $state(true);
	let error = $state('');
	let mergeAnswer = $state<{ text: string; ok: boolean; goTo: string | null } | null>(null);
	// The merge a refusal sent the owner to, marked in the list until the next action.
	let markedMerge = $state<string | null>(null);
	let confirmingMerge = $state<string | null>(null);
	let mergeBusy = $state(false);

	const selectedRun = $derived($page.url.searchParams.get('run'));

	function openRun(id: string | null): void {
		const url = new URL($page.url);
		if (id === null) url.searchParams.delete('run');
		else url.searchParams.set('run', id);
		void goto(`${url.pathname}${url.search}`, { keepFocus: true, noScroll: id === null });
	}

	async function load(): Promise<void> {
		loading = true;
		error = '';
		try {
			const [runRes, mergeRes] = await Promise.all([
				fetch(`${getApiBase()}/bulk/runs`),
				fetch(`${getApiBase()}/merges`),
			]);
			// Bulk runs ship off; a 404 here means the feature is off, not a failure.
			runs = runRes.ok ? ((await runRes.json()) as { runs: BulkRun[] }).runs : [];
			// No subject store answers 404: no merges. Any other failure keeps the list as it was
			// and says so, so an answer read against it is not read against an empty list.
			if (mergeRes.ok) merges = ((await mergeRes.json()) as { merges: BulkMerge[] }).merges;
			else if (mergeRes.status === 404) merges = [];
			if ((!runRes.ok && runRes.status !== 404) || (!mergeRes.ok && mergeRes.status !== 404)) error = t('common.load_failed');
		} catch {
			error = t('common.load_failed');
		}
		loading = false;
	}

	/** Take a merge back and say what came of it: by the route's status and code, with the
	 *  merge in the way named from its row of the list as loaded after the answer. */
	async function takeBackMerge(merge: BulkMerge): Promise<void> {
		mergeBusy = true;
		mergeAnswer = null;
		markedMerge = null;
		let status = 0;
		let body: unknown = null;
		try {
			const res = await fetch(`${getApiBase()}/merges/${encodeURIComponent(merge.id)}/rollback`, { method: 'POST' });
			status = res.status;
			body = res.ok ? null : await res.json().catch(() => null);
		} catch {
			// No answer at all: the route may have taken it back. Status 0 reads as "not certain".
		}
		confirmingMerge = null;
		await load();
		mergeAnswer = bulkMergeAnswer(status, body, merge, merges, { t, tf });
		mergeBusy = false;
	}

	function goToMerge(id: string): void {
		markedMerge = id;
		document.getElementById(`merge-${id}`)?.scrollIntoView({ block: 'center', inline: 'start', behavior: 'smooth' });
	}

	function when(iso: string): string {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		return d.toLocaleString(getLocale() === 'de' ? 'de-CH' : 'en-US', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
	}

	$effect(() => {
		// Reload the list whenever the owner comes back from a run's page.
		if (selectedRun === null) void load();
	});

	const i18n = { t, tf };
	const chipClass = 'inline-block rounded-full px-2 py-0.5 text-[11px]';
</script>

{#if selectedRun !== null}
	<BulkRunDetail runId={selectedRun} onBack={() => openRun(null)} onOpen={(id) => openRun(id)} />
{:else}
	<div class="p-6 max-w-4xl mx-auto space-y-6">
		<section>
			<h1 class="text-xl font-light tracking-tight mb-2">{t('bulk.title')}</h1>
			<p class="text-sm text-text-muted mb-4">{t('bulk.intro')}</p>

			{#if error}
				<div class="rounded-[var(--radius-md)] bg-danger/10 border border-danger/20 px-4 py-3 text-sm text-danger mb-4">{error}</div>
			{/if}

			{#if loading}
				<p class="text-text-subtle text-sm">{t('common.loading')}</p>
			{:else if runs.length === 0}
				<p class="text-sm text-text-subtle py-6 text-center">{t('bulk.empty')}</p>
			{:else}
				<div class="overflow-x-auto">
					<table class="w-full text-sm">
						<thead>
							<tr class="text-left text-xs text-text-subtle border-b border-border">
								<th class="py-2 pr-3 font-medium">{t('bulk.col.run')}</th>
								<th class="py-2 pr-3 font-medium hidden sm:table-cell">{t('bulk.col.target')}</th>
								<th class="py-2 pr-3 font-medium">{t('bulk.col.status')}</th>
								<th class="py-2 pr-3 font-medium hidden sm:table-cell">{t('bulk.col.targets')}</th>
								<th class="py-2 font-medium hidden sm:table-cell">{t('bulk.col.cost')}</th>
							</tr>
						</thead>
						<tbody>
							{#each runs as run (run.id)}
								<tr class="border-b border-border hover:bg-bg-muted cursor-pointer" onclick={() => openRun(run.id)}>
									<td class="py-2 pr-3">
										<button type="button" class="text-left hover:underline" onclick={(e) => { e.stopPropagation(); openRun(run.id); }}>{bulkLabel(run, i18n)}</button>
										<div class="text-xs text-text-subtle">{when(run.createdAt)}<span class="sm:hidden"> · {bulkSystemName(run.targetSystem, i18n)}</span></div>
									</td>
									<td class="py-2 pr-3 hidden sm:table-cell">{bulkSystemName(run.targetSystem, i18n)}</td>
									<td class="py-2 pr-3">
										<span class="{chipClass} whitespace-nowrap {run.phase === 'done' ? 'bg-success/15 text-success' : run.haltReason && !bulkWaitsForStart(run) ? 'bg-warning/15 text-warning' : 'bg-bg-muted text-text-muted'}">
											{t(`bulk.phase.${run.phase}`)}{run.haltReason && !bulkWaitsForStart(run) ? ` ${t('bulk.halted_suffix')}` : ''}
										</span>
										{#if run.writeForm === 'unmeasured'}
											<span class="{chipClass} whitespace-nowrap bg-warning/15 text-warning">{t('bulk.unmeasured_chip')}</span>
										{/if}
									</td>
									<td class="py-2 pr-3 hidden sm:table-cell font-mono text-xs">{run.applied}/{run.total}</td>
									<td class="py-2 hidden sm:table-cell font-mono text-xs">{formatCost(run.costUsd)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>

		{#if merges.length > 0 || mergeAnswer}
			<section>
				<h2 class="text-base font-medium mb-1">{t('bulk.merges.title')}</h2>
				<p class="text-sm text-text-muted mb-3">{t('bulk.merges.intro')}</p>
				<div class="overflow-x-auto">
					<table class="w-full text-sm">
						<thead>
							<tr class="text-left text-xs text-text-subtle border-b border-border">
								<th class="py-2 pr-2 sm:pr-3 font-medium">{t('bulk.merges.col.merged')}</th>
								<th class="py-2 pr-2 sm:pr-3 font-medium">{t('bulk.col.status')}</th>
								<th class="py-2 pr-2 sm:pr-3 font-medium hidden sm:table-cell">{t('bulk.merges.col.linked')}</th>
								<th class="py-2"></th>
							</tr>
						</thead>
						<tbody>
							{#each merges as merge (merge.id)}
								<tr id="merge-{merge.id}" class="border-b border-border align-top {markedMerge === merge.id ? 'bg-warning/10' : ''}">
									<td class="py-2 pr-2 sm:pr-3">{bulkVisibleText(merge.dupName)} → {bulkVisibleText(merge.canonicalName)}<div class="text-xs text-text-subtle">{when(merge.createdAt)}</div></td>
									<td class="py-2 pr-2 sm:pr-3">
										{#if bulkMergeState(merge) === 'in_effect'}
											<span class="{chipClass} bg-success/15 text-success">{t('bulk.merges.in_effect')}</span>
										{:else}
											<span class="{chipClass} bg-bg-muted text-text-muted">{t(`bulk.merges.${bulkMergeState(merge)}`)}</span>
										{/if}
									</td>
									<td class="py-2 pr-2 sm:pr-3 hidden sm:table-cell text-xs text-text-muted">{tf('bulk.merges.linked', { n: String(merge.dataStoreRows), m: String(merge.threadRows) })}</td>
									<td class="py-2 text-right">
										{#if bulkMergeTakeable(merge)}
											{#if confirmingMerge === merge.id}
												<div class="space-y-2 text-left">
													<p class="text-xs">{tf('bulk.merges.confirm', { dup: bulkVisibleText(merge.dupName), canonical: bulkVisibleText(merge.canonicalName) })}</p>
													<div class="flex gap-2 flex-wrap">
														<button type="button" class="rounded-[var(--radius-sm)] bg-accent text-accent-fg px-3 py-1 text-xs disabled:opacity-50" disabled={mergeBusy} onclick={() => takeBackMerge(merge)}>{t('bulk.merges.confirm_yes')}</button>
														<button type="button" class="rounded-[var(--radius-sm)] border border-border px-3 py-1 text-xs" onclick={() => { confirmingMerge = null; }}>{t('bulk.not_now')}</button>
													</div>
												</div>
											{:else}
												<button type="button" class="rounded-[var(--radius-sm)] border border-border px-2 sm:px-3 py-1 text-xs whitespace-nowrap hover:bg-bg-muted" onclick={() => { confirmingMerge = merge.id; mergeAnswer = null; markedMerge = null; }}>{t('bulk.merges.take_back')}</button>
											{/if}
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				{#if mergeAnswer}
					<p class="text-xs mt-2 {mergeAnswer.ok ? 'text-success' : 'text-danger'}">
						{mergeAnswer.text}
						{#if mergeAnswer.goTo}
							{@const target = mergeAnswer.goTo}
							<button type="button" class="ml-1 rounded-[var(--radius-sm)] border border-border px-2 py-0.5 text-xs text-text hover:bg-bg-muted" onclick={() => goToMerge(target)}>{t('bulk.merges.go_to')}</button>
						{/if}
					</p>
				{/if}
			</section>
		{/if}
	</div>
{/if}
