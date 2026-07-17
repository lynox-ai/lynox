<script lang="ts">
	// DK.2 — the durable-memory review queue. Untrusted-turn `remember` captures
	// land here as `pending_review` (H4 routing); approval is the HUMAN trust
	// event (status → active, tier → user_asserted, subject minted from the
	// hint). The raw text is shown deliberately: the reviewer must judge injected
	// content on its actual wording.
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';

	interface QueueEntry {
		id: string;
		text: string;
		subjectHint: string | null;
		kind: string;
		sourceChannel: string | null;
		sourceType: string;
		createdAt: string;
	}

	let entries = $state<QueueEntry[]>([]);
	let loading = $state(true);
	let error = $state('');
	let busyId = $state<string | null>(null);
	let editingId = $state<string | null>(null);
	let editText = $state('');

	const { onCountChange = undefined }: { onCountChange?: ((n: number) => void) | undefined } = $props();

	async function load(): Promise<void> {
		loading = true;
		error = '';
		try {
			const res = await fetch(`${getApiBase()}/knowledge/queue`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = (await res.json()) as { entries: QueueEntry[]; pendingCount: number };
			entries = body.entries;
			onCountChange?.(body.pendingCount);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	$effect(() => { void load(); });

	async function review(id: string, action: 'approve' | 'edit_approve' | 'reject', text?: string): Promise<void> {
		busyId = id;
		error = '';
		try {
			const res = await fetch(`${getApiBase()}/knowledge/queue/${id}/review`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(text !== undefined ? { action, text } : { action }),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? `HTTP ${res.status}`);
			}
			entries = entries.filter((e) => e.id !== id);
			editingId = null;
			onCountChange?.(entries.length);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busyId = null;
		}
	}

	function startEdit(entry: QueueEntry): void {
		editingId = entry.id;
		editText = entry.text;
	}

	function fmtDate(iso: string): string {
		// SQLite `datetime('now')` is "YYYY-MM-DD HH:MM:SS" (space, no T, UTC). The bare
		// "space + Z" form only parses in V8; Safari/Firefox return Invalid Date (and
		// `.toLocaleString()` on it yields the string "Invalid Date", not a throw). Normalise
		// to real ISO-8601 UTC first so it parses everywhere.
		const isoUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(iso) ? iso.replace(' ', 'T') + 'Z' : iso;
		const d = new Date(isoUtc);
		return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
	}
</script>

<div class="p-4 sm:p-5 space-y-3">
	<div class="flex items-center justify-between">
		<div>
			<h2 class="text-sm font-semibold">{t('knowledge.queue.title')}</h2>
			<p class="text-xs text-text-muted mt-0.5">{t('knowledge.queue.subtitle')}</p>
		</div>
		<button type="button" aria-label={t('knowledge.queue.reload_aria')} title={t('knowledge.queue.reload_aria')} class="text-xs text-text-muted hover:text-text px-2 py-1 rounded-[var(--radius-sm)] hover:bg-bg-muted" onclick={() => void load()}>↻</button>
	</div>

	{#if error}
		<div class="text-xs text-red-500 border border-red-500/30 rounded-[var(--radius-sm)] px-3 py-2">{error}</div>
	{/if}

	{#if loading}
		<p class="text-xs text-text-muted">…</p>
	{:else if entries.length === 0}
		<div class="text-xs text-text-muted border border-dashed border-border rounded-[var(--radius-sm)] px-4 py-6 text-center">
			{t('knowledge.queue.empty')}
		</div>
	{:else}
		{#each entries as entry (entry.id)}
			<div class="border border-border rounded-[var(--radius-sm)] p-3 space-y-2">
				<div class="flex items-center gap-2 text-[10px] text-text-muted font-mono">
					<span class="rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 px-1.5">{t('knowledge.queue.pending_tag')}</span>
					{#if entry.subjectHint}<span>→ {entry.subjectHint}</span>{/if}
					<span>{entry.kind}</span>
					<span class="ml-auto">{fmtDate(entry.createdAt)}</span>
				</div>
				{#if editingId === entry.id}
					<textarea
						aria-label={t('knowledge.queue.edit_aria')}
						class="w-full text-xs bg-bg-muted border border-border rounded-[var(--radius-sm)] p-2 min-h-[60px]"
						bind:value={editText}
					></textarea>
					<div class="flex gap-2">
						<button type="button" disabled={busyId === entry.id || !editText.trim()}
							class="text-xs px-2.5 py-1 rounded-[var(--radius-sm)] bg-accent/10 text-accent-text hover:bg-accent/20 disabled:opacity-50"
							onclick={() => void review(entry.id, 'edit_approve', editText)}>{t('knowledge.queue.save_approve')}</button>
						<button type="button" class="text-xs px-2.5 py-1 rounded-[var(--radius-sm)] text-text-muted hover:bg-bg-muted"
							onclick={() => { editingId = null; }}>{t('common.cancel')}</button>
					</div>
				{:else}
					<p class="text-xs whitespace-pre-wrap">{entry.text}</p>
					<div class="flex gap-2">
						<button type="button" disabled={busyId === entry.id}
							class="text-xs px-2.5 py-1 rounded-[var(--radius-sm)] bg-accent/10 text-accent-text hover:bg-accent/20 disabled:opacity-50"
							onclick={() => void review(entry.id, 'approve')}>{t('knowledge.queue.approve')}</button>
						<button type="button" disabled={busyId === entry.id}
							class="text-xs px-2.5 py-1 rounded-[var(--radius-sm)] text-text-muted hover:bg-bg-muted disabled:opacity-50"
							onclick={() => startEdit(entry)}>{t('knowledge.queue.edit')}</button>
						<button type="button" disabled={busyId === entry.id}
							class="text-xs px-2.5 py-1 rounded-[var(--radius-sm)] text-red-500/80 hover:bg-red-500/10 disabled:opacity-50"
							onclick={() => { if (confirm(t('knowledge.queue.reject_confirm'))) void review(entry.id, 'reject'); }}>{t('knowledge.queue.reject')}</button>
					</div>
				{/if}
			</div>
		{/each}
	{/if}
</div>
