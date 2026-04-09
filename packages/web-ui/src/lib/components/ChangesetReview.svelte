<script lang="ts">
	import { t } from '../i18n.svelte.js';
	import type { ChangesetFileInfo } from '../stores/chat.svelte.js';

	const SENSITIVE_PATTERNS = [
		/\.env$/i, /\.env\..+$/i,
		/\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i,
		/credentials/i, /\.netrc$/i,
		/\.token$/i, /\.secret$/i,
		/id_rsa$/, /id_ed25519$/,
		/\.(ssh|gnupg|aws|config|docker|kube)\//i,
	];

	function isSensitivePath(file: string): boolean {
		return SENSITIVE_PATTERNS.some(p => p.test(file));
	}

	let {
		files,
		onReview,
	}: {
		files: ChangesetFileInfo[];
		onReview: (action: 'accept' | 'rollback' | 'partial', rolledBackFiles?: string[]) => void;
	} = $props();

	let expandedFile = $state<string | null>(null);
	let inPartialMode = $state(false);
	let fileDecisions = $state<Record<string, 'accept' | 'rollback'>>({});

	const totalAdded = $derived(files.reduce((s, f) => s + f.added, 0));
	const totalRemoved = $derived(files.reduce((s, f) => s + f.removed, 0));
	const addedCount = $derived(files.filter(f => f.status === 'added').length);
	const modifiedCount = $derived(files.filter(f => f.status === 'modified').length);
	const allDecided = $derived(Object.keys(fileDecisions).length === files.length);

	function toggleFile(file: string) {
		expandedFile = expandedFile === file ? null : file;
	}

	function setDecision(file: string, decision: 'accept' | 'rollback') {
		fileDecisions = { ...fileDecisions, [file]: decision };
	}

	function applyPartial() {
		const rolledBack = files
			.filter(f => fileDecisions[f.file] === 'rollback')
			.map(f => f.file);
		if (rolledBack.length === files.length) {
			onReview('rollback');
		} else if (rolledBack.length === 0) {
			onReview('accept');
		} else {
			onReview('partial', rolledBack);
		}
	}

	function enterPartialMode() {
		inPartialMode = true;
		// Default all to accept
		const decisions: Record<string, 'accept' | 'rollback'> = {};
		for (const f of files) {
			decisions[f.file] = isSensitivePath(f.file) ? 'rollback' : 'accept';
		}
		fileDecisions = decisions;
	}
</script>

<div class="rounded-[var(--radius-md)] border border-warning/30 bg-warning/5 overflow-hidden">
	<!-- Header -->
	<div class="px-4 py-3 border-b border-warning/20">
		<div class="flex items-center justify-between">
			<h3 class="text-sm font-medium text-text">{t('changeset.title')}</h3>
			<div class="flex items-center gap-3 text-xs text-text-muted font-mono">
				{#if modifiedCount > 0}
					<span>{modifiedCount} {t('changeset.files_modified')}</span>
				{/if}
				{#if addedCount > 0}
					<span>{addedCount} {t('changeset.files_added')}</span>
				{/if}
				<span class="text-success">+{totalAdded}</span>
				<span class="text-danger">-{totalRemoved}</span>
			</div>
		</div>
	</div>

	<!-- File list -->
	<div class="divide-y divide-border/50">
		{#each files as f (f.file)}
			{@const sensitive = isSensitivePath(f.file)}
			<div class="bg-surface-800/30">
				<!-- File row -->
				<button
					onclick={() => toggleFile(f.file)}
					class="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-surface-800/60 transition-colors"
				>
					<span class="text-xs font-mono {expandedFile === f.file ? 'rotate-90' : ''} text-text-subtle transition-transform">&#9654;</span>
					<span class="inline-block rounded px-1.5 py-0.5 text-[10px] font-mono uppercase {f.status === 'added' ? 'bg-success/15 text-success' : 'bg-accent/15 text-accent-text'}">
						{f.status === 'added' ? t('changeset.new_file') : t('changeset.modified_file')}
					</span>
					<span class="flex-1 text-xs font-mono text-text truncate">{f.file}</span>
					{#if sensitive}
						<span class="rounded px-1.5 py-0.5 text-[10px] font-mono uppercase bg-danger/15 text-danger border border-danger/20">
							{t('changeset.sensitive_warning')}
						</span>
					{/if}
					<span class="text-xs font-mono text-success">+{f.added}</span>
					<span class="text-xs font-mono text-danger">-{f.removed}</span>
				</button>

				<!-- Expanded diff -->
				{#if expandedFile === f.file}
					<div class="px-4 pb-3">
						<pre class="rounded-[var(--radius-sm)] bg-bg p-3 text-xs font-mono overflow-x-auto max-h-96 overflow-y-auto border border-border/50">{#each f.diff.split('\n') as line}{#if line.startsWith('+++') || line.startsWith('---')}<span class="text-text-muted font-bold">{line}</span>
{:else if line.startsWith('@@')}<span class="text-accent-text">{line}</span>
{:else if line.startsWith('+')}<span class="text-success">{line}</span>
{:else if line.startsWith('-')}<span class="text-danger">{line}</span>
{:else}<span class="text-text-subtle">{line}</span>
{/if}{/each}</pre>

						{#if inPartialMode}
							<div class="flex gap-2 mt-2">
								<button
									onclick={() => setDecision(f.file, 'accept')}
									class="rounded-[var(--radius-sm)] border px-3 py-1 text-xs transition-all {fileDecisions[f.file] === 'accept' ? 'border-success/50 bg-success/15 text-success' : 'border-border bg-bg text-text-muted hover:text-text'}"
								>{t('changeset.accept')}</button>
								<button
									onclick={() => setDecision(f.file, 'rollback')}
									class="rounded-[var(--radius-sm)] border px-3 py-1 text-xs transition-all {fileDecisions[f.file] === 'rollback' ? 'border-danger/50 bg-danger/15 text-danger' : 'border-border bg-bg text-text-muted hover:text-text'}"
								>{t('changeset.rollback')}</button>
							</div>
						{/if}
					</div>
				{/if}
			</div>
		{/each}
	</div>

	<!-- Action bar -->
	<div class="px-4 py-3 border-t border-warning/20 flex items-center gap-2 justify-end">
		{#if inPartialMode}
			<button
				onclick={() => { inPartialMode = false; fileDecisions = {}; }}
				class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1.5 text-xs text-text-muted hover:text-text transition-colors"
			>{t('changeset.cancel')}</button>
			<button
				onclick={applyPartial}
				disabled={!allDecided}
				class="rounded-[var(--radius-sm)] border border-accent/50 bg-accent/15 px-3 py-1.5 text-xs text-accent-text hover:bg-accent/25 disabled:opacity-30 transition-all"
			>{t('changeset.apply')}</button>
		{:else}
			<button
				onclick={enterPartialMode}
				class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1.5 text-xs text-text-muted hover:text-text transition-colors"
			>{t('changeset.review_each')}</button>
			<button
				onclick={() => onReview('rollback')}
				class="rounded-[var(--radius-sm)] border border-danger/30 bg-danger/10 px-3 py-1.5 text-xs text-danger hover:bg-danger/20 transition-colors"
			>{t('changeset.rollback_all')}</button>
			<button
				onclick={() => onReview('accept')}
				class="rounded-[var(--radius-sm)] border border-success/30 bg-success/10 px-3 py-1.5 text-xs text-success hover:bg-success/20 transition-colors"
			>{t('changeset.accept_all')}</button>
		{/if}
	</div>
</div>
