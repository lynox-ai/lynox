<script lang="ts">
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { getApiBase } from '../config.svelte.js';
	import { t, getLocale } from '../i18n.svelte.js';
	import { newChat, sendMessage } from '../stores/chat.svelte.js';
	import { sanitizeFramingField } from '../utils/chat-framing.js';
	import { recordRowSummary } from '../utils/footprint.js';
	import {
		listSubjects,
		fetchSubjectFootprint,
		type SubjectListItem,
		type SubjectFootprint,
		type SubjectTimelineEntry,
	} from '../api/subject-footprint.js';

	// Record-on-spine R2b — the read-only subject-graph surface. A subjects list
	// (left) → a footprint detail panel (right): records + threads as an occurrence
	// timeline, memories + tasks as adjacent sections. Read + ONE chat handoff
	// ("discuss"); every edit routes through the agent (no inline mutation here).

	const PAGE_SIZE = 50;

	let subjects = $state<SubjectListItem[]>([]);
	let loading = $state(true);
	let loadingMore = $state(false);
	let hasMore = $state(false);
	let query = $state('');
	let selected = $state<SubjectListItem | null>(null);
	let footprint = $state<SubjectFootprint | null>(null);
	let footprintLoading = $state(false);
	let error = $state('');

	// Kind palette — same theme-agnostic hues KnowledgeGraphView uses for entity types.
	const kindHues: Record<string, string> = {
		person: '#6366f1',
		organization: '#10b981',
		product: '#c026d3',
		service: '#0891b2',
		engagement: '#d97706',
	};

	function kindStyle(kind: string): string {
		const hue = kindHues[kind];
		if (!hue) return '';
		return `background: color-mix(in srgb, ${hue} 15%, transparent); color: ${hue};`;
	}

	function fmtDate(iso: string | null): string {
		if (!iso) return '—';
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		return d.toLocaleDateString(getLocale() === 'de' ? 'de-CH' : 'en-US');
	}

	// Escape closes the footprint panel (matches the close button + KG precedent).
	$effect(() => {
		function handleEscape(e: KeyboardEvent) {
			if (e.key === 'Escape' && selected) { selected = null; footprint = null; }
		}
		window.addEventListener('keydown', handleEscape);
		return () => window.removeEventListener('keydown', handleEscape);
	});

	async function loadSubjects(append = false) {
		if (append) { loadingMore = true; } else { loading = true; }
		error = '';
		const offset = append ? subjects.length : 0;
		const result = await listSubjects(getApiBase(), {
			limit: PAGE_SIZE,
			offset,
			...(query ? { q: query } : {}),
		});
		if (result === null) {
			if (!append) subjects = [];
			error = t('common.load_failed');
		} else {
			subjects = append ? [...subjects, ...result.subjects] : result.subjects;
			hasMore = offset + result.subjects.length < result.total;
		}
		loading = false;
		loadingMore = false;
	}

	async function selectSubject(s: SubjectListItem) {
		selected = s;
		footprint = null;
		footprintLoading = true;
		const fp = await fetchSubjectFootprint(getApiBase(), s.id);
		// Drop a stale result: if the user picked another subject while this fetch
		// was in flight, the newer selection owns `footprint`/`footprintLoading`.
		if (selected?.id !== s.id) return;
		footprint = fp;
		footprintLoading = false;
	}

	// The ONE chat handoff — open a fresh thread seeded to discuss the subject
	// (mirrors ContactsView.editInChat). The agent picks up context + can anchor
	// the thread via `set_thread_context`; the UI never mutates the subject itself.
	function discussSubject(s: SubjectListItem) {
		newChat();
		void sendMessage(`${t('subjects.discuss_prompt')} ${sanitizeFramingField(s.name)}.`);
		void goto('/app');
	}

	function handleSearch() { loadSubjects(); }

	function timelineDate(entry: SubjectTimelineEntry): string {
		return fmtDate(entry.occurredAt);
	}

	// Initial load only. `untrack` so the mount effect does NOT track `query`
	// (loadSubjects reads it synchronously) — otherwise every keystroke would
	// re-fetch. Search is manual: Enter → handleSearch; load-more → loadSubjects(true).
	$effect(() => { untrack(() => { void loadSubjects(); }); });
</script>

<div class="p-6 max-w-5xl mx-auto">
	<div class="flex items-center justify-between mb-4">
		<h1 class="text-xl font-light tracking-tight">{t('subjects.title')}</h1>
	</div>

	{#if error}
		<div class="rounded-[var(--radius-md)] bg-danger/10 border border-danger/20 px-4 py-3 text-sm text-danger mb-4">{error}</div>
	{/if}

	<!-- Search -->
	<div class="mb-4">
		<input bind:value={query} onkeydown={(e) => e.key === 'Enter' && handleSearch()} placeholder={t('subjects.search')}
			class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-border-hover" />
	</div>

	{#if loading}
		<p class="text-text-subtle text-sm">{t('common.loading')}</p>
	{:else if subjects.length === 0}
		<p class="text-text-subtle text-sm">{t('subjects.no_subjects')}</p>
	{:else}
		<div class="flex gap-4">
			<!-- Subject list -->
			<div class="flex-1 min-w-0">
				<div class="space-y-1">
					{#each subjects as subject}
						<button onclick={() => selectSubject(subject)}
							class="w-full text-left rounded-[var(--radius-md)] border px-4 py-2.5 transition-all flex items-center gap-3 {selected?.id === subject.id ? 'border-accent/30 bg-accent/5' : 'border-border bg-bg-subtle hover:border-border-hover'}">
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-2">
									<span class="text-sm font-medium truncate">{subject.name}</span>
									<span class="shrink-0 text-[10px] rounded-full px-2 py-0.5 font-mono" style={kindStyle(subject.kind)}>{subject.kind}</span>
								</div>
							</div>
						</button>
					{/each}
				</div>

				<!-- Load more + count -->
				<div class="mt-3 flex items-center justify-between">
					<span class="text-xs text-text-subtle">{t('subjects.showing')} {subjects.length}</span>
					{#if hasMore}
						<button onclick={() => loadSubjects(true)} disabled={loadingMore}
							class="text-xs text-accent-text hover:underline disabled:opacity-50">
							{loadingMore ? t('common.loading') : t('subjects.load_more')}
						</button>
					{/if}
				</div>
			</div>

			<!-- Footprint detail panel -->
			{#if selected}
				{@render footprintPanel()}
			{/if}
		</div>
	{/if}
</div>

{#snippet footprintPanel()}
	<!-- Mobile: full-width overlay; Desktop: sticky sidebar -->
	<div class="fixed inset-0 z-40 bg-bg/95 p-4 overflow-y-auto md:static md:inset-auto md:z-auto md:bg-bg-subtle md:w-96 md:shrink-0 md:rounded-[var(--radius-md)] md:border md:border-border md:p-4 md:self-start md:sticky md:top-4 md:max-h-[calc(100vh-8rem)] md:overflow-y-auto scrollbar-thin" style="padding-top: calc(1rem + env(safe-area-inset-top, 0px));">
		<!-- Header -->
		<div class="flex items-start justify-between gap-2">
			<div>
				<h2 class="text-lg font-medium mb-1">{selected!.name}</h2>
				<span class="text-xs rounded-full px-2.5 py-0.5 font-mono" style={kindStyle(selected!.kind)}>{selected!.kind}</span>
			</div>
			<button onclick={() => { selected = null; footprint = null; }} class="shrink-0 p-1.5 rounded text-text-subtle hover:text-text hover:bg-bg-muted transition-colors" aria-label="Close">
				<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
			</button>
		</div>

		<!-- Discuss handoff (the single context-injection button) -->
		<button onclick={() => discussSubject(selected!)}
			class="mt-3 w-full rounded-[var(--radius-md)] border border-accent/30 bg-accent/5 px-3 py-2 text-sm text-accent-text hover:bg-accent/10 transition-colors">
			{t('subjects.discuss')}
		</button>

		{#if footprintLoading}
			<p class="mt-4 text-text-subtle text-sm">{t('common.loading')}</p>
		{:else if !footprint}
			<p class="mt-4 text-text-subtle text-sm">{t('common.load_failed')}</p>
		{:else if footprint.timeline.length === 0 && footprint.memories.length === 0 && footprint.tasks.length === 0}
			<p class="mt-4 text-text-subtle text-sm">{t('subjects.empty_footprint')}</p>
		{:else}
			<!-- Timeline: records + threads, newest first, each with its source + date -->
			{#if footprint.timeline.length > 0}
				<div class="mt-4">
					<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle mb-1.5">{t('subjects.timeline')}</p>
					<div class="space-y-1.5">
						{#each footprint.timeline as entry}
							<div class="border-l-2 border-border pl-3 py-0.5">
								<div class="flex items-center justify-between gap-2">
									<span class="text-xs font-medium text-accent-text truncate">
										{entry.type === 'thread' ? t('subjects.thread') : entry.collection}
									</span>
									<span class="shrink-0 text-[11px] text-text-subtle tabular-nums">
										{timelineDate(entry)}{#if entry.type === 'record' && !entry.occurredAtIsEventTime}<span class="ml-1 text-text-subtle/70">· {t('subjects.logged')}</span>{/if}
									</span>
								</div>
								<p class="text-xs text-text-muted mt-0.5 truncate">
									{#if entry.type === 'thread'}
										{entry.thread.title || t('subjects.untitled_thread')}
									{:else}
										{recordRowSummary(entry.row, entry.matchedColumns)}
									{/if}
								</p>
							</div>
						{/each}
					</div>
					{#if footprint.truncated.records || footprint.truncated.threads}
						<p class="mt-1.5 text-[11px] text-text-subtle/70">{t('subjects.more_exist')}</p>
					{/if}
				</div>
			{/if}

			<!-- Memories (adjacent — semantic facts) -->
			{#if footprint.memories.length > 0}
				<div class="mt-4">
					<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle mb-1.5">{t('subjects.memories')} ({footprint.memories.length})</p>
					<div class="space-y-1.5">
						{#each footprint.memories as memory}
							<div class="rounded-[var(--radius-sm)] bg-bg-muted px-2.5 py-1.5">
								<p class="text-xs text-text-muted">{memory.text}</p>
								<p class="text-[11px] text-text-subtle mt-0.5 tabular-nums">{fmtDate(memory.createdAt)}</p>
							</div>
						{/each}
					</div>
					{#if footprint.truncated.memories}
						<p class="mt-1.5 text-[11px] text-text-subtle/70">{t('subjects.more_exist')}</p>
					{/if}
				</div>
			{/if}

			<!-- Tasks (adjacent — future due) -->
			{#if footprint.tasks.length > 0}
				<div class="mt-4">
					<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle mb-1.5">{t('subjects.tasks')} ({footprint.tasks.length})</p>
					<div class="space-y-1.5">
						{#each footprint.tasks as task}
							<div class="rounded-[var(--radius-sm)] bg-bg-muted px-2.5 py-1.5">
								<div class="flex items-center justify-between gap-2">
									<span class="text-xs text-text-muted truncate">{task.title}</span>
									<span class="shrink-0 text-[10px] rounded-full px-1.5 py-0.5 font-mono text-text-subtle bg-bg">{task.status}</span>
								</div>
								{#if task.due_date}
									<p class="text-[11px] text-text-subtle mt-0.5 tabular-nums">{fmtDate(task.due_date)}</p>
								{/if}
							</div>
						{/each}
					</div>
					{#if footprint.truncated.tasks}
						<p class="mt-1.5 text-[11px] text-text-subtle/70">{t('subjects.more_exist')}</p>
					{/if}
				</div>
			{/if}
		{/if}
	</div>
{/snippet}
