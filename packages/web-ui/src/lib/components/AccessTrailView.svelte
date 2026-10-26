<!--
	The owner's view of the actor trail: what people with delegated access did on this instance,
	one entry per run, step or event, never content. It reads `GET /api/access-trail`, owner only;
	a helper's session gets the refusal and sees a line saying so.

	A status comes from the engine (audit-trail-view.ts); this view names it and never derives one.
	A plan run whose rows carry no key shows "–" for its targets: no number, not even 0.
-->
<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t, tf, getLocale } from '../i18n.svelte.js';

	type Status = 'running' | 'done' | 'halted' | 'ended' | 'refused' | 'failed' | 'interrupted';
	type Note = 'awaits-answer' | 'awaits-approval' | 'unanswered' | 'approval-expired' | 'approval-rejected' | 'no-result';
	interface Person { email: string | null; display: string | null; mandateId: string | null }
	interface Targets { written: number; failed: number; atLeast: boolean }
	interface Step { kind: 'step'; action: string; target: string | null; at: string; person: Person; status: Status | null; note?: Note; decidedBy?: string | null }
	interface Event { kind: 'event'; action: string; target: string | null; phase: string; at: string; person: Person }
	interface PlanRun { kind: 'plan'; key: string | null; trigger: string | null; startedBy: 'schedule' | 'hand' | null; at: string; person: Person; status: Status | null; targets: Targets | null; entries: Array<Step | Event> }
	interface BulkRun { kind: 'bulk'; runId: string; action: string; host: string | null; at: string; person: Person; status: Status | null; planned: boolean; windows: number; targets: Targets }
	type Entry = PlanRun | BulkRun | Step | Event;

	const PERIODS = { all: null, '1d': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 } as const;
	type Period = keyof typeof PERIODS;
	const MANDATE_TAG_PREFIX = 'mandate:';

	let entries = $state<Entry[]>([]);
	let before = $state<number | null>(null);
	let phase = $state<'loading' | 'ready' | 'error' | 'owner-only'>('loading');
	let loadingOlder = $state(false);
	let person = $state('');
	let period = $state<Period>('all');

	async function fetchPage(beforeId: number | null): Promise<{ entries: Entry[]; before: number | null } | 'owner-only'> {
		const q = beforeId === null ? '' : `?before=${String(beforeId)}`;
		const res = await fetch(`${getApiBase()}/access-trail${q}`);
		if (res.status === 403) return 'owner-only';
		if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
		return (await res.json()) as { entries: Entry[]; before: number | null };
	}

	async function load(): Promise<void> {
		phase = 'loading';
		try {
			const page = await fetchPage(null);
			if (page === 'owner-only') { phase = 'owner-only'; return; }
			entries = page.entries;
			before = page.before;
			phase = 'ready';
		} catch {
			phase = 'error';
		}
	}

	async function loadOlder(): Promise<void> {
		if (before === null || loadingOlder) return;
		loadingOlder = true;
		try {
			const page = await fetchPage(before);
			if (page === 'owner-only') { phase = 'owner-only'; return; }
			entries = [...entries, ...page.entries];
			before = page.before;
		} catch {
			phase = 'error';
		} finally {
			loadingOlder = false;
		}
	}

	$effect(() => { void load(); });

	function personKey(p: Person): string {
		return p.mandateId ?? p.email ?? p.display ?? '';
	}
	function personName(p: Person): string {
		return p.display ?? p.email ?? '–';
	}

	const people = $derived.by(() => {
		const seen = new Map<string, string>();
		for (const e of entries) {
			const k = personKey(e.person);
			if (k !== '' && !seen.has(k)) seen.set(k, personName(e.person));
		}
		return [...seen].map(([key, name]) => ({ key, name }));
	});

	const shown = $derived.by(() => {
		const span = PERIODS[period];
		const since = span === null ? null : Date.now() - span;
		return entries.filter((e) =>
			(person === '' || personKey(e.person) === person)
			&& (since === null || Date.parse(e.at) >= since));
	});

	function when(at: string): string {
		const d = new Date(at);
		return Number.isNaN(d.getTime()) ? at : d.toLocaleString(getLocale() === 'de' ? 'de-CH' : 'en-GB');
	}
	function statusText(s: Status | null): string {
		return t(`access_trail.status.${s ?? 'unknown'}`);
	}
	function kindText(e: Entry): string {
		if (e.kind === 'event') return t(e.phase === 'read' ? 'access_trail.kind_read' : 'access_trail.kind_event');
		return t(`access_trail.kind_${e.kind}`);
	}
	function targetsText(x: Targets | null): string {
		if (x === null) return t('access_trail.targets_none');
		const vars = { written: String(x.written), failed: String(x.failed) };
		return tf(x.atLeast ? 'access_trail.targets_at_least' : 'access_trail.targets', vars);
	}
	function decidedByText(by: string | null | undefined): string | null {
		if (by === undefined || by === null) return null;
		if (by === 'owner') return t('access_trail.decided_by_owner');
		if (by.startsWith(MANDATE_TAG_PREFIX)) return tf('access_trail.decided_by', { who: by.slice(MANDATE_TAG_PREFIX.length) });
		return null;
	}
	function noteText(s: Step): string | null {
		if (s.note === undefined) return null;
		const by = s.note === 'approval-rejected' ? decidedByText(s.decidedBy) : null;
		const note = t(`access_trail.note.${s.note}`);
		return by === null ? note : `${note} (${by})`;
	}
</script>

{#snippet line(e: Step | Event)}
	<div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm" data-entry-kind={e.kind}>
		<span class="text-xs text-text-subtle tabular-nums">{when(e.at)}</span>
		<span class="text-text-muted">{kindText(e)}</span>
		<span class="font-mono text-xs break-all">{e.action}{#if e.target} · {e.target}{/if}</span>
		{#if e.kind === 'step'}
			<span class="text-xs" data-status>{statusText(e.status)}</span>
			{#if e.note !== undefined}<span class="text-xs text-text-muted" data-note>{noteText(e)}</span>{/if}
		{/if}
	</div>
{/snippet}

<div class="space-y-6 max-w-3xl mx-auto p-4">
	<a href="/app/settings" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('account.back_to_settings')}</a>
	<header>
		<h1 class="text-2xl font-semibold mb-1">{t('settings.account.access_trail')}</h1>
		<p class="text-sm text-text-muted">{t('settings.account.access_trail_desc')}</p>
	</header>

	{#if phase === 'loading'}
		<p class="text-sm text-text-muted">{t('access_trail.loading')}</p>
	{:else if phase === 'owner-only'}
		<p class="text-sm text-text-muted" data-state="owner-only">{t('access_trail.owner_only')}</p>
	{:else if phase === 'error'}
		<div class="space-y-2" data-state="error">
			<p class="text-sm text-danger">{t('access_trail.error')}</p>
			<button type="button" onclick={load} class="px-3 py-1.5 text-sm border border-border rounded hover:bg-accent/5">{t('access_trail.retry')}</button>
		</div>
	{:else if entries.length === 0}
		<p class="text-sm text-text-muted" data-state="empty">{t('access_trail.empty')}</p>
	{:else}
		<div class="flex flex-wrap gap-4 text-sm">
			<label class="flex items-center gap-2">
				<span class="text-text-muted">{t('access_trail.filter_person')}</span>
				<select bind:value={person} class="border border-border rounded px-2 py-1 bg-bg" data-filter="person">
					<option value="">{t('access_trail.filter_person_all')}</option>
					{#each people as p (p.key)}<option value={p.key}>{p.name}</option>{/each}
				</select>
			</label>
			<label class="flex items-center gap-2">
				<span class="text-text-muted">{t('access_trail.filter_period')}</span>
				<select bind:value={period} class="border border-border rounded px-2 py-1 bg-bg" data-filter="period">
					{#each Object.keys(PERIODS) as k (k)}<option value={k}>{t(`access_trail.period_${k}`)}</option>{/each}
				</select>
			</label>
		</div>

		{#if shown.length === 0}
			<p class="text-sm text-text-muted" data-state="empty-filtered">{t('access_trail.empty_filtered')}</p>
		{:else}
			<ul class="divide-y divide-border border-y border-border" aria-label={t('settings.account.access_trail')}>
				{#each shown as e, i (i)}
					<li class="py-3 space-y-1" data-entry-kind={e.kind}>
						<div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
							<span class="text-sm font-medium">{personName(e.person)}</span>
							{#if e.person.email && e.person.display}<span class="text-xs text-text-subtle">{e.person.email}</span>{/if}
						</div>
						{#if e.kind === 'plan'}
							<div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
								<span class="text-xs text-text-subtle tabular-nums">{when(e.at)}</span>
								<span class="text-text-muted">{kindText(e)}</span>
								{#if e.trigger}<span class="font-mono text-xs break-all">{e.trigger}</span>{/if}
								{#if e.startedBy}<span class="text-xs text-text-muted">{t(`access_trail.started_${e.startedBy}`)}</span>{/if}
								<span class="text-xs" data-status>{statusText(e.status)}</span>
								<span class="text-xs text-text-muted" data-targets>{targetsText(e.targets)}</span>
							</div>
							{#if e.key !== null && e.entries.length > 0}
								<details class="pl-4">
									<summary class="text-xs text-text-subtle cursor-pointer">{t('access_trail.steps')} ({e.entries.length})</summary>
									<div class="space-y-1 pt-1">
										{#each e.entries as s, j (j)}{@render line(s)}{/each}
									</div>
								</details>
							{/if}
						{:else if e.kind === 'bulk'}
							<div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
								<span class="text-xs text-text-subtle tabular-nums">{when(e.at)}</span>
								<span class="text-text-muted">{kindText(e)}</span>
								<span class="font-mono text-xs break-all">{e.action}{#if e.host} · {e.host}{/if}</span>
								<span class="text-xs" data-status>{statusText(e.status)}</span>
								<span class="text-xs text-text-muted">{tf('access_trail.windows', { n: String(e.windows) })}</span>
								<span class="text-xs text-text-muted" data-targets>{targetsText(e.targets)}</span>
								{#if e.planned}<span class="text-xs text-text-muted" data-note>{t('access_trail.planned')}</span>{/if}
							</div>
						{:else}
							{@render line(e)}
						{/if}
					</li>
				{/each}
			</ul>
		{/if}

		{#if before !== null}
			<button type="button" onclick={loadOlder} disabled={loadingOlder}
				class="px-3 py-1.5 text-sm border border-border rounded hover:bg-accent/5 disabled:opacity-50">{t('access_trail.load_older')}</button>
		{/if}
	{/if}
</div>
