<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';

	const namespaces = ['knowledge', 'methods', 'project-state', 'learnings'] as const;
	let selectedNs = $state<(typeof namespaces)[number]>('knowledge');
	let content = $state<string | null>(null);
	let loading = $state(false);
	let editing = $state(false);
	let editContent = $state('');
	let saving = $state(false);
	let appendText = $state('');
	let deletePattern = $state('');
	let error = $state('');

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

	async function deleteEntry() {
		if (!deletePattern.trim()) return;
		const confirmed = confirm(`${t('memory.delete_confirm_prefix')} "${deletePattern}" ${t('memory.delete_confirm_from')} ${selectedNs} ${t('memory.delete_confirm_suffix')}`);
		if (!confirmed) return;
		saving = true;
		error = '';
		try {
			const res = await fetch(`${getApiBase()}/memory/${selectedNs}?pattern=${encodeURIComponent(deletePattern)}`, {
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

	$effect(() => {
		loadNamespace();
	});
</script>

<div class="p-6 max-w-4xl mx-auto">
	<div class="flex items-center justify-between mb-4">
		<h1 class="text-xl font-light tracking-tight">{t('memory.title')}</h1>
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
					class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm text-text hover:opacity-90 disabled:opacity-50"
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
		<div class="relative group">
			<pre class="whitespace-pre-wrap rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4 font-mono text-sm">{content}</pre>
			<button
				onclick={startEdit}
				class="absolute top-3 right-3 rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1 text-xs text-text-muted opacity-0 group-hover:opacity-100 hover:text-text transition-all"
			>
				{t('memory.edit')}
			</button>
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
					class="shrink-0 rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm text-text hover:opacity-90 disabled:opacity-50"
				>
					{t('memory.add_button')}
				</button>
			</div>
		</div>

		<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4 space-y-3">
			<p class="text-xs font-mono uppercase tracking-widest text-text-subtle">{t('memory.delete_entries')}</p>
			<div class="flex gap-2">
				<input
					bind:value={deletePattern}
					placeholder={t('memory.delete_placeholder')}
					class="flex-1 rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-border-hover"
				/>
				<button
					onclick={deleteEntry}
					disabled={!deletePattern.trim() || saving}
					class="shrink-0 rounded-[var(--radius-sm)] border border-danger/30 bg-danger/15 px-4 py-2 text-sm text-danger hover:bg-danger/25 disabled:opacity-50"
				>
					{t('settings.delete')}
				</button>
			</div>
		</div>
	</div>
</div>
