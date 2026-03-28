<script lang="ts">
	import { getContext, isPinned, togglePin, closePanel } from '../stores/context-panel.svelte.js';

	const ctx = $derived(getContext());
	const pinned = $derived(isPinned());

	const TOOL_LABELS: Record<string, string> = {
		write_file: 'File Written',
		read_file: 'File Read',
		bash: 'Command',
		http_request: 'HTTP Request',
		web_research: 'Web Search',
		google_gmail: 'Gmail',
		google_sheets: 'Sheets',
		google_drive: 'Drive',
		google_calendar: 'Calendar',
		google_docs: 'Docs',
		spawn_agent: 'Sub-Agent',
		memory_store: 'Memory',
		memory_recall: 'Recall',
		data_store_query: 'Data Query',
		data_store_insert: 'Data Insert',
		run_pipeline: 'Pipeline',
	};

	function friendlyName(name: string): string {
		return TOOL_LABELS[name] ?? name;
	}

	function extractPreview(input: unknown): string {
		if (!input || typeof input !== 'object') return '';
		const obj = input as Record<string, unknown>;
		return String(obj['path'] ?? obj['url'] ?? obj['query'] ?? obj['task'] ?? obj['text'] ?? '').slice(0, 200);
	}
</script>

{#if ctx}
	<aside class="w-80 shrink-0 border-l border-border bg-bg-subtle overflow-y-auto hidden lg:flex flex-col">
		<!-- Header -->
		<div class="flex items-center justify-between px-4 py-2.5 border-b border-border">
			<div class="flex items-center gap-2">
				<span class="inline-block h-2 w-2 rounded-full {ctx.type === 'file' ? 'bg-accent' : 'bg-warning'}"></span>
				<span class="text-xs font-mono uppercase tracking-widest text-text-subtle">{friendlyName(ctx.title)}</span>
			</div>
			<div class="flex items-center gap-1.5">
				<button
					onclick={togglePin}
					class="text-xs px-1.5 py-0.5 rounded-[var(--radius-sm)] transition-colors {pinned ? 'bg-accent/10 text-accent-text' : 'text-text-subtle hover:text-text'}"
				>
					{pinned ? 'Pinned' : 'Pin'}
				</button>
				<button onclick={closePanel} class="text-text-subtle hover:text-text transition-colors p-0.5" aria-label="Close">
					<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
						<path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
					</svg>
				</button>
			</div>
		</div>

		<!-- Content -->
		<div class="flex-1 p-4 space-y-3">
			{#if ctx.type === 'file' && ctx.filePath}
				<p class="text-xs font-mono text-accent-text break-all">{ctx.filePath}</p>
				{#if ctx.toolResult}
					<pre class="text-xs font-mono text-text-muted whitespace-pre-wrap max-h-96 overflow-y-auto rounded-[var(--radius-md)] bg-bg-muted p-3 border border-border">{ctx.toolResult.slice(0, 3000)}</pre>
				{/if}

			{:else if ctx.toolName === 'web_research'}
				<p class="text-xs text-text-muted">{extractPreview(ctx.toolInput)}</p>
				{#if ctx.toolResult}
					<div class="text-xs text-text-muted whitespace-pre-wrap max-h-96 overflow-y-auto">{ctx.toolResult.slice(0, 3000)}</div>
				{/if}

			{:else if ctx.toolName?.startsWith('google_')}
				<div class="rounded-[var(--radius-md)] bg-bg-muted border border-border p-3">
					<p class="text-xs font-mono text-text-subtle mb-1">{friendlyName(ctx.toolName)}</p>
					<p class="text-xs text-text-muted">{extractPreview(ctx.toolInput)}</p>
				</div>
				{#if ctx.toolResult}
					<pre class="text-xs font-mono text-text-muted whitespace-pre-wrap max-h-80 overflow-y-auto">{ctx.toolResult.slice(0, 2000)}</pre>
				{/if}

			{:else}
				{#if ctx.toolInput}
					<pre class="text-xs font-mono text-text-subtle whitespace-pre-wrap rounded-[var(--radius-md)] bg-bg-muted p-3 border border-border max-h-48 overflow-y-auto">{JSON.stringify(ctx.toolInput, null, 2).slice(0, 1000)}</pre>
				{/if}
				{#if ctx.toolResult}
					<p class="text-xs font-mono uppercase tracking-widest text-text-subtle mt-2">Result</p>
					<pre class="text-xs font-mono text-text-muted whitespace-pre-wrap max-h-80 overflow-y-auto">{ctx.toolResult.slice(0, 2000)}</pre>
				{/if}
			{/if}
		</div>
	</aside>
{/if}
