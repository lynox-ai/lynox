<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';

	interface FileEntry { name: string; isDirectory: boolean; size: number; }

	let entries = $state<FileEntry[]>([]);
	let currentPath = $state('.');
	let loading = $state(true);
	let error = $state('');

	async function loadDir(path: string) {
		loading = true; error = '';
		currentPath = path;
		try {
			const res = await fetch(`${getApiBase()}/files?path=${encodeURIComponent(path)}`);
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { path: string; entries: FileEntry[] };
			entries = data.entries.sort((a, b) => {
				if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
				return a.name.localeCompare(b.name);
			});
		} catch { error = t('common.load_failed'); entries = []; }
		loading = false;
	}

	function navigate(entry: FileEntry) {
		if (entry.isDirectory) {
			loadDir(currentPath === '.' ? entry.name : `${currentPath}/${entry.name}`);
		}
	}

	function goUp() {
		if (currentPath === '.') return;
		const parts = currentPath.split('/');
		parts.pop();
		loadDir(parts.length === 0 ? '.' : parts.join('/'));
	}

	function formatSize(bytes: number): string {
		if (bytes === 0) return '';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / 1048576).toFixed(1)} MB`;
	}

	$effect(() => { loadDir('.'); });
</script>

<div class="p-6 max-w-4xl mx-auto">
	<h1 class="text-xl font-light tracking-tight mb-4">{t('files.title')}</h1>

	{#if error}
		<div class="rounded-[var(--radius-md)] bg-danger/10 border border-danger/20 px-4 py-3 text-sm text-danger mb-4">{error}</div>
	{/if}

	<!-- Breadcrumb -->
	<div class="flex items-center gap-1 mb-4 text-xs font-mono text-text-subtle">
		<button onclick={() => loadDir('.')} class="hover:text-text transition-colors">~</button>
		{#each currentPath.split('/').filter(Boolean) as part, i}
			<span>/</span>
			<button onclick={() => loadDir(currentPath.split('/').slice(0, i + 1).join('/'))} class="hover:text-text transition-colors">{part}</button>
		{/each}
	</div>

	{#if loading}
		<p class="text-text-subtle text-sm">{t('common.loading')}</p>
	{:else if entries.length === 0}
		<p class="text-text-subtle text-sm">{t('files.no_files')}</p>
	{:else}
		<div class="rounded-[var(--radius-md)] border border-border overflow-hidden">
			{#if currentPath !== '.'}
				<button onclick={goUp} class="w-full px-4 py-2.5 text-left text-sm text-text-muted hover:bg-bg-subtle transition-colors border-b border-border flex items-center gap-2">
					<span class="text-text-subtle">..</span>
				</button>
			{/if}
			{#each entries as entry}
				<button
					onclick={() => navigate(entry)}
					class="w-full px-4 py-2.5 text-left text-sm hover:bg-bg-subtle transition-colors border-b border-border last:border-b-0 flex items-center justify-between {entry.isDirectory ? 'cursor-pointer' : ''}"
				>
					<div class="flex items-center gap-2">
						{#if entry.isDirectory}
							<span class="text-accent-text">📁</span>
						{:else}
							<span class="text-text-subtle">📄</span>
						{/if}
						<span class="{entry.isDirectory ? 'text-text' : 'text-text-muted'}">{entry.name}</span>
					</div>
					{#if !entry.isDirectory && entry.size > 0}
						<span class="text-xs text-text-subtle font-mono">{formatSize(entry.size)}</span>
					{/if}
				</button>
			{/each}
		</div>
	{/if}
</div>
