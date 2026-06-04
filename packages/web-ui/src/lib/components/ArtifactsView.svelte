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
	import { tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { t, getLocale } from '../i18n.svelte.js';
	import MarkdownRenderer from './MarkdownRenderer.svelte';

	let selected = $state<Artifact | null>(null);
	// True when `selected` was opened via the chat deep-link (?id=…) — drives
	// the toolbar back button to return to the chat instead of the gallery.
	let openedFromChat = $state(false);
	let confirmDelete = $state<string | null>(null);
	let deleteDialogRef = $state<HTMLDivElement | null>(null);
	let deleteDialogTrigger: HTMLElement | null = null;
	let deepLinkConsumed = false;

	const artifacts = $derived(getArtifacts());
	const isLoading = $derived(getIsLoadingArtifacts());

	$effect(() => {
		loadArtifacts();
	});

	// Deep-link: `/app/artifacts?id=…` (set by MarkdownRenderer's
	// "open-gallery" button on inline markdown artifacts) auto-opens that
	// artifact's preview once the list has loaded. One-shot — re-running
	// loadArtifacts shouldn't keep re-opening the same artifact, and a
	// hard reload (or back-nav after deleting the artifact) shouldn't
	// resurrect the open dialog.
	$effect(() => {
		if (deepLinkConsumed || isLoading || artifacts.length === 0) return;
		const id = $page.url.searchParams.get('id');
		if (!id) return;
		const match = artifacts.find(a => a.id === id);
		if (match) {
			deepLinkConsumed = true;
			// Strip the `?id=` from the URL so reload / back-nav doesn't
			// re-open the same artifact. keepFocus avoids stealing focus from
			// the about-to-mount preview dialog.
			void goto('/app/artifacts', { replaceState: true, keepFocus: true, noScroll: true });
			void openArtifact(match, true);
		}
	});

	// Focus dialog when it opens
	$effect(() => {
		if (confirmDelete) {
			void tick().then(() => deleteDialogRef?.focus());
		}
	});

	async function openArtifact(meta: ArtifactMeta, fromChat = false) {
		const full = await getArtifact(meta.id);
		if (full) {
			openedFromChat = fromChat;
			selected = full;
		}
	}

	function closePreview() {
		selected = null;
	}

	// Back action for the fullscreen preview: return to the chat when the
	// artifact was deep-linked from there, otherwise close back to the gallery.
	function goBack() {
		if (openedFromChat) void goto('/app');
		else closePreview();
	}

	async function handleDelete(id: string) {
		await deleteArtifact(id);
		confirmDelete = null;
		if (selected?.id === id) selected = null;
	}

	function formatDate(iso: string): string {
		// Date AND time — "updated" without a time read as stale on a doc edited
		// minutes ago (rafael 2026-06-04). Locale-aware so it matches the UI.
		const locale = getLocale() === 'de' ? 'de-CH' : 'en-GB';
		return new Date(iso).toLocaleString(locale, {
			day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
		});
	}

	function formatDateTime(iso: string): string {
		return new Date(iso).toLocaleString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
	}

	const CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'unsafe-inline'; script-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com; style-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src * data: blob:; connect-src 'none'">`;

	function injectCsp(html: string): string {
		if (html.includes('<head')) return html.replace(/<head[^>]*>/, `$&${CSP_META}`);
		return `${CSP_META}${html}`;
	}

	function typeIcon(type: string): string {
		if (type === 'mermaid') return '◇';
		if (type === 'svg') return '△';
		if (type === 'csv' || type === 'tsv' || type === 'json' || type === 'text') return '▤';
		return '⬡';
	}

	function mimeFor(type: string): string {
		if (type === 'html') return 'text/html';
		if (type === 'svg') return 'image/svg+xml';
		if (type === 'markdown') return 'text/markdown';
		if (type === 'csv') return 'text/csv';
		if (type === 'tsv') return 'text/tab-separated-values';
		if (type === 'json') return 'application/json';
		return 'text/plain'; // mermaid + text + unknown
	}

	function extensionFor(type: string): string {
		if (type === 'html') return 'html';
		if (type === 'svg') return 'svg';
		if (type === 'markdown') return 'md';
		if (type === 'mermaid') return 'mmd';
		if (type === 'csv') return 'csv';
		if (type === 'tsv') return 'tsv';
		if (type === 'json') return 'json';
		return 'txt'; // text + unknown
	}

	function exportArtifact(a: Artifact) {
		const blob = new Blob([a.content], { type: mimeFor(a.type) });
		const link = document.createElement('a');
		link.href = URL.createObjectURL(blob);
		link.download = `${a.title.replace(/\s+/g, '-').toLowerCase()}.${extensionFor(a.type)}`;
		link.click();
		URL.revokeObjectURL(link.href);
	}

	$effect(() => {
		function handleEscape(e: KeyboardEvent) {
			if (e.key !== 'Escape') return;
			if (confirmDelete) confirmDelete = null;
			else if (selected) goBack();
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
									{#if (artifact.version ?? 1) > 1}
										<span class="text-[10px] font-mono text-text-subtle" title={t('artifacts.version_hint')}>v{artifact.version}</span>
									{/if}
									<span class="text-[10px] text-text-subtle">{formatDate(artifact.updatedAt)}</span>
								</div>
							</div>
						</div>

						<!-- Delete button -->
						<button
							type="button"
							class="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity text-text-subtle hover:text-danger text-xs p-1"
							onclick={(e) => { e.stopPropagation(); deleteDialogTrigger = e.currentTarget as HTMLElement; confirmDelete = artifact.id; }}
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
	<div
		bind:this={deleteDialogRef}
		class="fixed inset-0 z-[9998] bg-bg-overlay/60 flex items-center justify-center"
		role="dialog" aria-modal="true" tabindex="-1"
		onclick={(e) => { if (e.target === e.currentTarget) { confirmDelete = null; deleteDialogTrigger?.focus(); } }}
		onkeydown={(e) => { if (e.key === 'Escape') { confirmDelete = null; deleteDialogTrigger?.focus(); } }}
		style="padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);"
	>
		<div class="bg-bg border border-border rounded-[var(--radius-md)] p-6 max-w-sm mx-4 space-y-4">
			<p class="text-sm text-text">{t('artifacts.confirm_delete')}</p>
			<div class="flex gap-3 justify-end">
				<button type="button" class="text-xs text-text-muted hover:text-text px-3 py-1.5" onclick={() => { confirmDelete = null; deleteDialogTrigger?.focus(); }}>{t('artifacts.cancel')}</button>
				<button type="button" class="text-xs text-danger hover:opacity-80 border border-danger/30 rounded-[var(--radius-sm)] px-3 py-1.5" onclick={() => handleDelete(confirmDelete!)}>{t('artifacts.delete')}</button>
			</div>
		</div>
	</div>
{/if}

<!-- Fullscreen preview -->
{#if selected}
	<div class="fixed inset-0 z-[9999] bg-bg flex flex-col" role="dialog" aria-modal="true" aria-label={selected.title} style="padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px);">
		<!-- Toolbar -->
		<div class="flex items-center gap-3 px-4 md:px-5 py-3 border-b border-border bg-bg-subtle shrink-0">
			<button type="button" class="text-text-muted hover:text-text text-sm p-1" onclick={goBack}>← {openedFromChat ? t('artifacts.back_to_chat') : t('artifacts.back')}</button>
			<h2 class="text-sm font-medium text-text flex-1 truncate">{selected.title}</h2>
			<span class="hidden sm:inline text-[10px] text-text-subtle whitespace-nowrap">{t('artifacts.updated')} {formatDateTime(selected.updatedAt)}{#if selected.version && selected.version > 1}{' · '}v{selected.version}{/if}</span>
			<span class="text-[10px] font-mono uppercase tracking-widest text-text-subtle">{selected.type}</span>
			<button type="button" class="text-xs text-text-muted hover:text-text border border-border rounded-[var(--radius-sm)] px-3 py-1" onclick={() => exportArtifact(selected!)}>Export</button>
		</div>

		<!-- Artifact content -->
		<div class="flex-1 overflow-hidden">
			{#if selected.type === 'html' || selected.type === 'svg'}
				<iframe
					srcdoc={injectCsp(selected.content)}
					sandbox="allow-scripts"
					class="w-full h-full border-none bg-bg-elevated"
					title={selected.title}
				></iframe>
			{:else if selected.type === 'mermaid'}
				<div class="p-6 overflow-auto h-full">
					<MarkdownRenderer content={'```mermaid\n' + selected.content + '\n```'} />
				</div>
			{:else if selected.type === 'markdown'}
				<div class="p-6 overflow-auto h-full bg-bg">
					<article class="prose prose-invert max-w-3xl mx-auto">
						<MarkdownRenderer content={selected.content} />
					</article>
				</div>
			{:else}
				<!-- Data-file artifacts (csv/tsv/json/text) + any unknown type:
				     raw text preview. The toolbar Export button downloads the
				     real file via mimeFor()/extensionFor(). -->
				<div class="p-6 overflow-auto h-full bg-bg">
					<pre class="text-xs font-mono text-text-muted whitespace-pre">{selected.content}</pre>
				</div>
			{/if}
		</div>
	</div>
{/if}
