<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import MarkdownRenderer from './MarkdownRenderer.svelte';

	const namespaces = ['knowledge', 'methods', 'status', 'learnings'] as const;
	let selectedNs = $state<(typeof namespaces)[number]>('knowledge');
	let content = $state<string | null>(null);
	let loading = $state(false);
	let editing = $state(false);
	let editContent = $state('');
	let saving = $state(false);
	let appendText = $state('');
	let deletePattern = $state('');
	let error = $state('');
	let editingIdx = $state<number | null>(null);
	let editingText = $state('');

	// Knowledge-graph stats surfaced in the Wissen header (M5): a glanceable
	// "how much do I know" summary, mirroring StatusBar's /api/kg/stats panel.
	interface KgStats {
		memoryCount: number;
		entityCount: number;
		relationCount: number;
		communityCount: number;
	}
	let kgStats = $state<KgStats | null>(null);

	async function loadKgStats() {
		try {
			const res = await fetch(`${getApiBase()}/kg/stats`);
			if (res.ok) kgStats = (await res.json()) as KgStats;
		} catch { /* silent — stats are a non-critical header adornment */ }
	}

	async function loadNamespace() {
		loading = true;
		error = '';
		try {
			const res = await fetch(`${getApiBase()}/memory/${selectedNs}`);
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { content: string | null };
			content = data.content;
		} catch {
			error = t('common.load_failed');
		}
		loading = false;
		editing = false;
	}

	function startEdit() {
		editContent = content ?? '';
		editing = true;
	}

	async function saveEdit() {
		saving = true;
		error = '';
		try {
			const res = await fetch(`${getApiBase()}/memory/${selectedNs}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ content: editContent })
			});
			if (!res.ok) throw new Error();
			await loadNamespace();
		} catch {
			error = t('common.save_failed');
		}
		saving = false;
	}

	async function appendEntry() {
		if (!appendText.trim()) return;
		saving = true;
		error = '';
		try {
			const res = await fetch(`${getApiBase()}/memory/${selectedNs}/append`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ text: '\n' + appendText })
			});
			if (!res.ok) throw new Error();
			appendText = '';
			await loadNamespace();
		} catch {
			error = t('common.save_failed');
		}
		saving = false;
	}


	async function updateEntry(oldLine: string, newText: string) {
		saving = true;
		error = '';
		try {
			const res = await fetch(`${getApiBase()}/memory/${selectedNs}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ old_content: oldLine, new_content: newText })
			});
			if (!res.ok) throw new Error();
			editingIdx = null;
			editingText = '';
			await loadNamespace();
		} catch {
			error = t('common.save_failed');
		}
		saving = false;
	}

	async function erasePattern() {
		const pattern = deletePattern.trim();
		if (!pattern) return;
		// Hard erase by substring (GDPR Art. 17). This is the ONLY user path that reaches
		// content with no visible notebook line — e.g. rows ingested from documents — which
		// the per-entry delete button (bound to rendered lines) cannot target.
		if (!confirm(t('memory.erase_pattern_confirm').replace('{pattern}', pattern))) return;
		saving = true;
		error = '';
		try {
			const res = await fetch(`${getApiBase()}/memory/${selectedNs}?pattern=${encodeURIComponent(pattern)}`, {
				method: 'DELETE'
			});
			if (!res.ok) throw new Error();
			deletePattern = '';
			await loadNamespace();
		} catch {
			error = t('common.save_failed');
		}
		saving = false;
	}

	async function deleteEntry(line: string) {
		// Erasure is permanent (hard-delete in both stores) and MemoryView was the only
		// destructive action without a confirm. Native confirm matches the rest of the
		// app's destructive-action UX (ApiStoreView, WorkflowLibraryView).
		if (!confirm(t('memory.delete_confirm'))) return;
		saving = true;
		error = '';
		try {
			const res = await fetch(`${getApiBase()}/memory/${selectedNs}?pattern=${encodeURIComponent(line)}`, {
				method: 'DELETE'
			});
			if (!res.ok) throw new Error();
			await loadNamespace();
		} catch {
			error = t('common.save_failed');
		}
		saving = false;
	}

	$effect(() => {
		loadNamespace();
		editingIdx = null;
	});

	// Load once on mount — KG stats are workspace-wide, not per-namespace.
	$effect(() => { void loadKgStats(); });
</script>

<div class="p-6 max-w-4xl mx-auto">
	<div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 mb-4">
		<h1 class="text-xl font-light tracking-tight">{t('memory.title')}</h1>
		{#if kgStats && (kgStats.memoryCount > 0 || kgStats.entityCount > 0)}
			<div class="shrink-0 flex items-center gap-3 text-xs font-mono text-text-subtle">
				<span>{kgStats.memoryCount}&nbsp;{t('status.memories')}</span>
				<span>{kgStats.entityCount}&nbsp;{t('status.entities')}</span>
				<span>{kgStats.relationCount}&nbsp;{t('status.relations')}</span>
			</div>
		{/if}
	</div>

	<div class="mb-6 space-y-2">
		<div class="flex flex-wrap gap-2">
			{#each namespaces as ns}
				<button
					onclick={() => { selectedNs = ns; }}
					title={t(`memory.ns.${ns}`)}
					class="rounded-[var(--radius-sm)] px-3 py-1.5 text-sm transition-all {selectedNs === ns
						? 'bg-accent/10 text-accent-text border border-accent/30'
						: 'text-text-muted hover:text-text border border-transparent'}"
				>
					{ns}
				</button>
			{/each}
		</div>
		<p class="text-xs text-text-subtle">{t(`memory.ns.${selectedNs}`)}</p>
	</div>

	{#if error}
		<div class="rounded-[var(--radius-md)] bg-danger/10 border border-danger/20 px-4 py-3 text-sm text-danger mb-4">{error}</div>
	{/if}

	{#if loading}
		<p class="text-text-subtle text-sm">{t('common.loading')}</p>
	{:else if editing}
		<div class="space-y-3">
			<textarea
				bind:value={editContent}
				rows="15"
				class="w-full resize-y rounded-[var(--radius-md)] border border-border bg-bg-subtle px-4 py-3 font-mono text-sm text-text outline-none focus:border-border-hover"
			></textarea>
			<div class="flex gap-2">
				<button
					onclick={saveEdit}
					disabled={saving}
					class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm text-accent-fg hover:opacity-90 disabled:opacity-50"
				>
					{saving ? t('settings.saving') : t('settings.save')}
				</button>
				<button
					onclick={() => { editing = false; }}
					class="rounded-[var(--radius-sm)] border border-border px-4 py-2 text-sm text-text-muted hover:text-text"
				>
					{t('memory.cancel')}
				</button>
			</div>
		</div>
	{:else if content}
		<!-- Newest first: the document appends chronologically, so reverse for display. -->
		{@const entries = content.split('\n').filter(line => line.trim()).reverse()}
		<p class="text-xs text-text-subtle mb-2">{entries.length}&nbsp;{t('memory.entry_count_label')}</p>
		<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle divide-y divide-border">
			{#each entries as entry, i}
				{@const dateMatch = entry.match(/^\[(\d{4}-\d{2}-\d{2})\]\s*/)}
				{@const date = dateMatch?.[1] ?? ''}
				{@const text = dateMatch ? entry.slice(dateMatch[0].length) : entry}
				<div class="px-4 py-3 group relative">
					{#if editingIdx === i}
						<!-- Inline edit mode -->
						<textarea
							bind:value={editingText}
							rows="3"
							class="w-full resize-none rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-border-hover"
						></textarea>
						<div class="flex gap-2 mt-2">
							<button
								onclick={() => updateEntry(entry, (date ? `[${date}] ` : '') + editingText)}
								disabled={saving}
								class="rounded-[var(--radius-sm)] bg-accent px-3 py-1 text-xs text-accent-fg hover:opacity-90 disabled:opacity-30"
							>{t('common.save')}</button>
							<button
								onclick={() => { editingIdx = null; }}
								class="rounded-[var(--radius-sm)] border border-border px-3 py-1 text-xs text-text-muted hover:text-text"
							>{t('memory.cancel')}</button>
						</div>
					{:else}
						<!-- Display mode — render the stored markdown, not raw source. -->
						<div class="text-sm text-text leading-relaxed pr-16 memory-entry-md">
							<MarkdownRenderer content={text} />
						</div>
						{#if date}
							<p class="text-[10px] text-text-subtle mt-1.5 font-mono">{date}</p>
						{/if}
						<!-- Edit + Delete buttons (visible on hover) -->
						<div class="absolute top-2.5 right-3 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
							<button
								onclick={() => { editingIdx = i; editingText = text; }}
								class="rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-0.5 text-[10px] text-text-muted hover:text-text transition-colors"
							>{t('memory.edit')}</button>
							<button
								onclick={() => deleteEntry(entry)}
								class="rounded-[var(--radius-sm)] border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10px] text-danger hover:bg-danger/20 transition-colors"
							>{t('memory.delete_button')}</button>
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{:else}
		<div class="text-text-subtle text-sm space-y-1">
			<p>{t('memory.no_entries')} {selectedNs}.</p>
			<p class="text-xs">{t('memory.no_entries_hint')}</p>
		</div>
	{/if}

	<div class="mt-6 space-y-3">
		<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4 space-y-3">
			<p class="text-xs font-mono uppercase tracking-widest text-text-subtle">{t('memory.add_entry')}</p>
			<div class="flex gap-2">
				<input
					bind:value={appendText}
					placeholder={t('memory.add_placeholder')}
					class="flex-1 rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-border-hover"
				/>
				<button
					onclick={appendEntry}
					disabled={!appendText.trim() || saving}
					class="shrink-0 rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm text-accent-fg hover:opacity-90 disabled:opacity-50"
				>
					{t('memory.add_button')}
				</button>
			</div>
		</div>

		<div class="rounded-[var(--radius-md)] border border-danger/20 bg-danger/5 p-4 space-y-2">
			<p class="text-xs font-mono uppercase tracking-widest text-text-subtle">{t('memory.erase_pattern_label')}</p>
			<p class="text-xs text-text-muted">{t('memory.erase_pattern_hint')}</p>
			<div class="flex gap-2">
				<input
					bind:value={deletePattern}
					placeholder={t('memory.erase_pattern_placeholder')}
					class="flex-1 rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-danger/40"
				/>
				<button
					onclick={erasePattern}
					disabled={!deletePattern.trim() || saving}
					class="shrink-0 rounded-[var(--radius-sm)] border border-danger/30 bg-danger/10 px-4 py-2 text-sm text-danger hover:bg-danger/20 disabled:opacity-50"
				>
					{t('memory.erase_pattern_button')}
				</button>
			</div>
		</div>

	</div>
</div>
