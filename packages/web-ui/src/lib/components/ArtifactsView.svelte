<script lang="ts">
	import {
		loadArtifacts,
		getArtifacts,
		getArtifact,
		deleteArtifact,
		getIsLoadingArtifacts,
		type Artifact,
		type ArtifactMeta,
	} from '../stores/artifacts.svelte.js';
	import { t } from '../i18n.svelte.js';
	import MarkdownRenderer from './MarkdownRenderer.svelte';

	let selected = $state<Artifact | null>(null);
	let confirmDelete = $state<string | null>(null);

	const artifacts = $derived(getArtifacts());
	const isLoading = $derived(getIsLoadingArtifacts());

	$effect(() => {
		loadArtifacts();
	});

	async function openArtifact(meta: ArtifactMeta) {
		const full = await getArtifact(meta.id);
		if (full) selected = full;
	}

	function closePreview() {
		selected = null;
	}

	async function handleDelete(id: string) {
		await deleteArtifact(id);
		confirmDelete = null;
		if (selected?.id === id) selected = null;
	}

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' });
	}

	const CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'unsafe-inline'; script-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com; style-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src * data: blob:; connect-src 'none'">`;

	function injectCsp(html: string): string {
		if (html.includes('<head')) return html.replace(/<head[^>]*>/, `$&${CSP_META}`);
		return `${CSP_META}${html}`;
	}

	function typeIcon(type: string): string {
		if (type === 'mermaid') return '◇';
		if (type === 'svg') return '△';
		return '⬡';
	}

	function exportArtifact(a: Artifact) {
		const blob = new Blob([a.content], { type: a.type === 'html' ? 'text/html' : 'text/plain' });
		const link = document.createElement('a');
		link.href = URL.createObjectURL(blob);
		link.download = `${a.title.replace(/\s+/g, '-').toLowerCase()}.${a.type === 'html' ? 'html' : a.type === 'svg' ? 'svg' : 'txt'}`;
		link.click();
		URL.revokeObjectURL(link.href);
	}

	$effect(() => {
		function handleEscape(e: KeyboardEvent) {
			if (e.key !== 'Escape') return;
			if (confirmDelete) confirmDelete = null;
			else if (selected) closePreview();
		}
		window.addEventListener('keydown', handleEscape);
		return () => window.removeEventListener('keydown', handleEscape);
	});
</script>

<div class="flex flex-col h-full">
	<!-- Header -->
	<div class="flex items-center justify-between px-6 py-4 border-b border-border">
		<h1 class="text-lg font-light tracking-tight text-text">{t('artifacts.title')}</h1>
		<span class="text-xs text-text-subtle">{artifacts.length} {t('artifacts.items')}</span>
	</div>

	<!-- Content -->
	<div class="flex-1 overflow-y-auto p-6">
		{#if isLoading}
			<p class="text-text-muted text-sm">{t('artifacts.loading')}</p>
		{:else if artifacts.length === 0}
			<div class="flex flex-col items-center justify-center h-full gap-3 text-center">
				<span class="text-4xl opacity-20">⬡</span>
				<p class="text-text-muted text-sm max-w-xs">{t('artifacts.empty')}</p>
			</div>
		{:else}
			<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
				{#each artifacts as artifact (artifact.id)}
					<div
						class="group relative text-left rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4 transition-colors hover:border-accent/40 hover:bg-bg-muted cursor-pointer w-full"
						role="button"
						tabindex="0"
						onclick={() => openArtifact(artifact)}
						onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openArtifact(artifact); } }}
					>
						<div class="flex items-start gap-3">
							<span class="text-accent-text text-lg mt-0.5 opacity-60">{typeIcon(artifact.type)}</span>
							<div class="min-w-0 flex-1">
								<h3 class="text-sm font-medium text-text truncate">{artifact.title}</h3>
								{#if artifact.description}
									<p class="text-xs text-text-muted mt-1 line-clamp-2">{artifact.description}</p>
								{/if}
								<div class="flex items-center gap-2 mt-2">
									<span class="text-[10px] font-mono uppercase tracking-widest text-text-subtle">{artifact.type}</span>
									<span class="text-[10px] text-text-subtle">{formatDate(artifact.updatedAt)}</span>
								</div>
							</div>
						</div>

						<!-- Delete button -->
						<button
							type="button"
							class="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity text-text-subtle hover:text-danger text-xs p-1"
							onclick={(e) => { e.stopPropagation(); confirmDelete = artifact.id; }}
							title={t('artifacts.delete')}
						>✕</button>
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>

<!-- Delete confirmation -->
{#if confirmDelete}
	<div class="fixed inset-0 z-[9998] bg-black/60 flex items-center justify-center" role="dialog" aria-modal="true">
		<div class="bg-bg border border-border rounded-[var(--radius-md)] p-6 max-w-sm space-y-4">
			<p class="text-sm text-text">{t('artifacts.confirm_delete')}</p>
			<div class="flex gap-3 justify-end">
				<button type="button" class="text-xs text-text-muted hover:text-text px-3 py-1.5" onclick={() => confirmDelete = null}>{t('artifacts.cancel')}</button>
				<button type="button" class="text-xs text-danger hover:text-red-400 border border-danger/30 rounded-[var(--radius-sm)] px-3 py-1.5" onclick={() => handleDelete(confirmDelete!)}>{t('artifacts.delete')}</button>
			</div>
		</div>
	</div>
{/if}

<!-- Fullscreen preview -->
{#if selected}
	<div class="fixed inset-0 z-[9999] bg-bg flex flex-col" role="dialog" aria-modal="true" aria-label={selected.title}>
		<!-- Toolbar -->
		<div class="flex items-center gap-3 px-5 py-3 border-b border-border bg-bg-subtle shrink-0">
			<button type="button" class="text-text-muted hover:text-text text-sm" onclick={closePreview}>← {t('artifacts.back')}</button>
			<h2 class="text-sm font-medium text-text flex-1 truncate">{selected.title}</h2>
			<span class="text-[10px] font-mono uppercase tracking-widest text-text-subtle">{selected.type}</span>
			<button type="button" class="text-xs text-text-muted hover:text-text border border-border rounded-[var(--radius-sm)] px-3 py-1" onclick={() => exportArtifact(selected!)}>Export</button>
		</div>

		<!-- Artifact content -->
		<div class="flex-1 overflow-hidden">
			{#if selected.type === 'html' || selected.type === 'svg'}
				<iframe
					srcdoc={injectCsp(selected.content)}
					sandbox="allow-scripts"
					class="w-full h-full border-none bg-[#0a0a1a]"
					title={selected.title}
				></iframe>
			{:else if selected.type === 'mermaid'}
				<div class="p-6 overflow-auto h-full">
					<MarkdownRenderer content={'```mermaid\n' + selected.content + '\n```'} />
				</div>
			{/if}
		</div>
	</div>
{/if}
