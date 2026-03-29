<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';

	interface FileEntry { name: string; isDirectory: boolean; size: number; }

	let entries = $state<FileEntry[]>([]);
	let currentPath = $state('.');
	let loading = $state(true);
	let error = $state('');
	let showHidden = $state(false);

	// Preview state
	let previewFile = $state<string | null>(null);
	let previewContent = $state('');
	let previewLoading = $state(false);

	async function loadDir(path: string) {
		loading = true; error = '';
		currentPath = path;
		previewFile = null;
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
		} else {
			openPreview(entry.name);
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

	function filePath(name: string): string {
		return currentPath === '.' ? name : `${currentPath}/${name}`;
	}

	async function openPreview(name: string) {
		const path = filePath(name);
		previewFile = name;
		previewLoading = true;
		previewContent = '';
		try {
			const res = await fetch(`${getApiBase()}/files/read?path=${encodeURIComponent(path)}`);
			if (!res.ok) {
				const err = (await res.json()) as { error?: string };
				previewContent = `Error: ${err.error ?? res.statusText}`;
			} else {
				const data = (await res.json()) as { content: string };
				previewContent = data.content;
			}
		} catch {
			previewContent = 'Could not load file.';
		}
		previewLoading = false;
	}

	function downloadFile(name: string) {
		const path = filePath(name);
		const url = `${getApiBase()}/files/download?path=${encodeURIComponent(path)}`;
		const a = document.createElement('a');
		a.href = url; a.download = name;
		a.click();
	}

	async function deleteFile(name: string) {
		const path = filePath(name);
		try {
			const res = await fetch(`${getApiBase()}/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
			if (res.ok) {
				if (previewFile === name) previewFile = null;
				await loadDir(currentPath);
			}
		} catch { /* ignore */ }
	}

	function formatSize(bytes: number): string {
		if (bytes === 0) return '';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / 1048576).toFixed(1)} MB`;
	}

	$effect(() => { loadDir('.'); });
</script>

<div class="p-6 max-w-5xl mx-auto">
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
		<div class="flex gap-4">
			<!-- File list -->
			<div class="flex-1 min-w-0">
				<div class="rounded-[var(--radius-md)] border border-border overflow-hidden">
					{#if currentPath !== '.'}
						<button onclick={goUp} class="w-full px-4 py-2.5 text-left text-sm text-text-muted hover:bg-bg-subtle transition-colors border-b border-border flex items-center gap-2">
							<span class="text-text-subtle">..</span>
						</button>
					{/if}
					{#each entries as entry}
						<div class="flex items-center border-b border-border last:border-b-0 hover:bg-bg-subtle transition-colors group">
							<button
								onclick={() => navigate(entry)}
								class="flex-1 px-4 py-2.5 text-left text-sm flex items-center gap-2 cursor-pointer"
							>
								{#if entry.isDirectory}
									<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0 text-accent-text" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
										<path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
									</svg>
								{:else}
									<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0 text-text-subtle" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
										<path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
									</svg>
								{/if}
								<span class="{entry.isDirectory ? 'text-text' : previewFile === entry.name ? 'text-accent-text' : 'text-text-muted'}">{entry.name}</span>
							</button>
							{#if !entry.isDirectory}
								<span class="text-xs text-text-subtle font-mono pr-2">{formatSize(entry.size)}</span>
								<div class="flex items-center gap-1 pr-3 opacity-0 group-hover:opacity-100 transition-opacity">
									<button onclick={() => downloadFile(entry.name)} class="p-1 rounded hover:bg-bg-muted text-text-subtle hover:text-text" title="Download">
										<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>
									</button>
									<button onclick={() => deleteFile(entry.name)} class="p-1 rounded hover:bg-danger/10 text-text-subtle hover:text-danger" title="Delete">
										<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>
									</button>
								</div>
							{/if}
						</div>
					{/each}
				</div>
			</div>

			<!-- Preview panel -->
			{#if previewFile}
				<div class="w-1/2 shrink-0">
					<div class="rounded-[var(--radius-md)] border border-border overflow-hidden sticky top-6">
						<div class="px-4 py-2.5 border-b border-border bg-bg-subtle flex items-center justify-between">
							<span class="text-xs font-mono text-text-muted truncate">{previewFile}</span>
							<button onclick={() => previewFile = null} class="text-text-subtle hover:text-text p-0.5">
								<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
							</button>
						</div>
						{#if previewLoading}
							<div class="px-4 py-8 text-center text-text-subtle text-sm">{t('common.loading')}</div>
						{:else}
							<pre class="px-4 py-3 text-xs font-mono text-text-muted whitespace-pre-wrap max-h-[70vh] overflow-y-auto scrollbar-thin">{previewContent}</pre>
						{/if}
					</div>
				</div>
			{/if}
		</div>
	{/if}
</div>
