<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';

	interface FileEntry { name: string; isDirectory: boolean; size: number; }

	let entries = $state<FileEntry[]>([]);
	let currentPath = $state('.');
	let loading = $state(true);
	let error = $state('');
	let showHidden = $state(false);

	async function loadDir(path: string) {
		loading = true; error = '';
		currentPath = path;
		try {
			const qs = showHidden ? '&hidden=1' : '';
			const res = await fetch(`${getApiBase()}/files?path=${encodeURIComponent(path)}${qs}`);
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

	function toggleHidden() {
		showHidden = !showHidden;
		loadDir(currentPath);
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
	<div class="flex items-center justify-between mb-4">
		<h1 class="text-xl font-light tracking-tight">{t('files.title')}</h1>
		<button
			onclick={toggleHidden}
			class="text-xs rounded-[var(--radius-sm)] border border-border px-2.5 py-1 transition-all {showHidden ? 'bg-accent/10 text-accent-text border-accent/30' : 'text-text-muted hover:text-text hover:border-border-hover'}"
		>
			{t('files.show_hidden')}
		</button>
	</div>

	{#if error}
		<div class="rounded-[var(--radius-md)] bg-danger/10 border border-danger/20 px-4 py-3 text-sm text-danger mb-4">{error}</div>
	{/if}

	<!-- Breadcrumb -->
	{#if currentPath !== '.'}
		<div class="flex items-center gap-1 mb-4 text-xs font-mono text-text-subtle">
			<button onclick={() => loadDir('.')} class="hover:text-text transition-colors">~</button>
			{#each currentPath.split('/').filter(Boolean) as part, i}
				<span>/</span>
				<button onclick={() => loadDir(currentPath.split('/').slice(0, i + 1).join('/'))} class="hover:text-text transition-colors">{part}</button>
			{/each}
		</div>
	{/if}

	{#if loading}
		<p class="text-text-subtle text-sm">{t('common.loading')}</p>
	{:else if entries.length === 0 && currentPath === '.'}
		<div class="text-center py-16 space-y-3">
			<svg xmlns="http://www.w3.org/2000/svg" class="h-10 w-10 mx-auto text-text-subtle" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1">
				<path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
			</svg>
			<p class="text-text-subtle text-sm">{t('files.empty_workspace')}</p>
			<p class="text-text-subtle text-xs">{t('files.empty_workspace_hint')}</p>
		</div>
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
							<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0 text-accent-text" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
								<path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
							</svg>
						{:else}
							<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0 text-text-subtle" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
								<path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
							</svg>
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
