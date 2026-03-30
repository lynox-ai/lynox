<script lang="ts">
	import { getContext, isPinned, togglePin, closePanel } from '../stores/context-panel.svelte.js';
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';

	const ctx = $derived(getContext());
	const pinned = $derived(isPinned());

	// User-friendly labels + icons
	const TOOL_META: Record<string, { label: string; icon: string; color: string }> = {
		write_file:       { label: 'Datei erstellt',    icon: '📄', color: 'text-success' },
		read_file:        { label: 'Datei gelesen',     icon: '📖', color: 'text-accent-text' },
		bash:             { label: 'Befehl',            icon: '⚡', color: 'text-warning' },
		http_request:     { label: 'API-Anfrage',       icon: '🌐', color: 'text-accent-text' },
		web_research:     { label: 'Web-Recherche',     icon: '🔍', color: 'text-accent-text' },
		google_gmail:     { label: 'Gmail',             icon: '📧', color: 'text-accent-text' },
		google_sheets:    { label: 'Sheets',            icon: '📊', color: 'text-success' },
		google_drive:     { label: 'Drive',             icon: '📁', color: 'text-accent-text' },
		google_calendar:  { label: 'Kalender',          icon: '📅', color: 'text-accent-text' },
		google_docs:      { label: 'Docs',              icon: '📝', color: 'text-accent-text' },
		spawn_agent:      { label: 'Delegiert',         icon: '🤖', color: 'text-warning' },
		memory_store:     { label: 'Gemerkt',           icon: '🧠', color: 'text-success' },
		memory_recall:    { label: 'Erinnert',          icon: '💭', color: 'text-accent-text' },
		memory_update:    { label: 'Wissen aktualisiert', icon: '✏️', color: 'text-warning' },
		data_store_query: { label: 'Daten abgefragt',   icon: '📊', color: 'text-accent-text' },
		data_store_insert:{ label: 'Daten gespeichert', icon: '💾', color: 'text-success' },
		data_store_create:{ label: 'Tabelle erstellt',  icon: '🗂️', color: 'text-success' },
		run_pipeline:     { label: 'Workflow',          icon: '⚙️', color: 'text-warning' },
		ask_user:         { label: 'Frage an dich',     icon: '❓', color: 'text-accent-text' },
		task_create:      { label: 'Aufgabe erstellt',  icon: '✅', color: 'text-success' },
		plan_task:        { label: 'Plan erstellt',     icon: '📋', color: 'text-accent-text' },
	};

	function meta(name: string) {
		return TOOL_META[name] ?? { label: name, icon: '🔧', color: 'text-text-subtle' };
	}

	function getInput(key: string): string {
		if (!ctx?.toolInput || typeof ctx.toolInput !== 'object') return '';
		return String((ctx.toolInput as Record<string, unknown>)[key] ?? '');
	}

	function getInputObj(): Record<string, unknown> {
		if (!ctx?.toolInput || typeof ctx.toolInput !== 'object') return {};
		return ctx.toolInput as Record<string, unknown>;
	}

	function truncate(s: string, max = 300): string {
		return s.length > max ? s.slice(0, max) + '...' : s;
	}
</script>

{#if ctx}
	<aside class="w-80 shrink-0 border-l border-border bg-bg-subtle overflow-y-auto overflow-x-hidden scrollbar-thin hidden lg:flex flex-col">
		<!-- Header -->
		<div class="flex items-center justify-between px-4 py-2.5 border-b border-border">
			<div class="flex items-center gap-2">
				<span class="text-base">{meta(ctx.title).icon}</span>
				<span class="text-xs font-medium text-text">{meta(ctx.title).label}</span>
			</div>
			<div class="flex items-center gap-1.5">
				<button
					onclick={togglePin}
					class="text-xs px-1.5 py-0.5 rounded-[var(--radius-sm)] transition-colors {pinned ? 'bg-accent/10 text-accent-text' : 'text-text-subtle hover:text-text'}"
				>
					{pinned ? t('panel.pinned') : t('panel.pin')}
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

			<!-- === File Operations === -->
			{#if ctx.toolName === 'write_file' || ctx.toolName === 'read_file'}
				<a href="/app/files" class="flex items-center gap-2 text-xs text-accent-text hover:underline cursor-pointer">
					<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /></svg>
					<span class="font-mono break-all">{getInput('path')}</span>
				</a>
				{#if getInput('content')}
					<div class="rounded-[var(--radius-md)] bg-bg border border-border overflow-hidden">
						<div class="px-3 py-1.5 border-b border-border bg-bg-muted">
							<span class="text-[10px] font-mono uppercase tracking-widest text-text-subtle">Inhalt</span>
						</div>
						<pre class="px-3 py-2 text-xs font-mono text-text-muted whitespace-pre-wrap break-all max-h-80 overflow-y-auto scrollbar-thin">{truncate(getInput('content'), 2000)}</pre>
					</div>
				{/if}
				{#if ctx.toolResult}
					<p class="text-xs text-success">{ctx.toolResult}</p>
				{/if}

			<!-- === Bash === -->
			{:else if ctx.toolName === 'bash'}
				<div class="rounded-[var(--radius-md)] bg-[#1a1a2e] border border-border overflow-hidden">
					<div class="px-3 py-1.5 border-b border-border flex items-center gap-2">
						<span class="h-2 w-2 rounded-full bg-danger"></span>
						<span class="h-2 w-2 rounded-full bg-warning"></span>
						<span class="h-2 w-2 rounded-full bg-success"></span>
						<span class="text-[10px] font-mono text-text-subtle ml-2">Terminal</span>
					</div>
					<pre class="px-3 py-2 text-xs font-mono text-green-400 whitespace-pre-wrap break-all max-h-60 overflow-y-auto scrollbar-thin">$ {getInput('command')}</pre>
					{#if ctx.toolResult}
						<pre class="px-3 py-2 text-xs font-mono text-text-muted whitespace-pre-wrap break-all max-h-40 overflow-y-auto scrollbar-thin border-t border-border">{truncate(ctx.toolResult, 1500)}</pre>
					{/if}
				</div>

			<!-- === ask_user === -->
			{:else if ctx.toolName === 'ask_user'}
				<p class="text-sm text-text font-medium">{getInput('question')}</p>
				{@const options = getInputObj()['options']}
				{#if Array.isArray(options)}
					<div class="space-y-1.5 mt-2">
						{#each options as option}
							<div class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-2 text-sm text-text-muted">
								{option}
							</div>
						{/each}
					</div>
					<p class="text-[10px] text-text-subtle mt-2">Antwort im Chat eingeben</p>
				{/if}

			<!-- === Memory === -->
			{:else if ctx.toolName === 'memory_store'}
				<div class="rounded-[var(--radius-md)] bg-bg border border-accent/20 px-3 py-2.5">
					<p class="text-[10px] font-mono uppercase tracking-widest text-accent-text mb-1.5">{getInput('namespace') || 'knowledge'}</p>
					<p class="text-sm text-text leading-relaxed">{truncate(getInput('content'), 500)}</p>
				</div>
				{#if ctx.toolResult}
					<p class="text-xs text-success">{ctx.toolResult}</p>
				{/if}

			<!-- === Memory Recall === -->
			{:else if ctx.toolName === 'memory_recall'}
				{#if ctx.toolResult}
					<div class="rounded-[var(--radius-md)] bg-bg border border-border px-3 py-2.5 max-h-96 overflow-y-auto scrollbar-thin">
						<pre class="text-xs text-text-muted whitespace-pre-wrap">{truncate(ctx.toolResult, 2000)}</pre>
					</div>
				{/if}

			<!-- === Data Store === -->
			{:else if ctx.toolName === 'data_store_insert' || ctx.toolName === 'data_store_create'}
				<div class="rounded-[var(--radius-md)] bg-bg border border-border overflow-hidden">
					<div class="px-3 py-1.5 border-b border-border bg-bg-muted flex items-center gap-2">
						<span class="text-[10px] font-mono uppercase tracking-widest text-text-subtle">{getInput('collection') || 'Tabelle'}</span>
					</div>
					{#if getInput('collection')}
						<div class="px-3 py-2">
							<p class="text-xs text-text-muted">{ctx.toolResult ?? ''}</p>
						</div>
					{/if}
				</div>

			<!-- === Web / HTTP === -->
			{:else if ctx.toolName === 'http_request' || ctx.toolName === 'web_research'}
				<div class="flex items-center gap-2">
					<span class="text-xs font-mono text-accent-text break-all">{getInput('url') || getInput('query') || ''}</span>
				</div>
				{#if ctx.toolResult}
					<div class="rounded-[var(--radius-md)] bg-bg border border-border px-3 py-2 max-h-80 overflow-y-auto scrollbar-thin">
						<pre class="text-xs text-text-muted whitespace-pre-wrap">{truncate(ctx.toolResult, 2000)}</pre>
					</div>
				{/if}

			<!-- === Google Workspace === -->
			{:else if ctx.toolName?.startsWith('google_')}
				<div class="rounded-[var(--radius-md)] bg-bg border border-border px-3 py-2.5">
					<p class="text-xs text-text-muted">{getInput('query') || getInput('subject') || getInput('title') || getInput('text') || ''}</p>
				</div>
				{#if ctx.toolResult}
					<div class="max-h-80 overflow-y-auto scrollbar-thin">
						<pre class="text-xs text-text-muted whitespace-pre-wrap">{truncate(ctx.toolResult, 2000)}</pre>
					</div>
				{/if}

			<!-- === Spawn Agent === -->
			{:else if ctx.toolName === 'spawn_agent'}
				<div class="rounded-[var(--radius-md)] bg-bg border border-warning/20 px-3 py-2.5">
					{#if getInput('role')}
						<span class="text-[10px] font-mono uppercase tracking-widest text-warning">{getInput('role')}</span>
					{/if}
					<p class="text-sm text-text mt-1">{truncate(getInput('task'), 300)}</p>
				</div>

			<!-- === Task === -->
			{:else if ctx.toolName === 'task_create'}
				<div class="rounded-[var(--radius-md)] bg-bg border border-success/20 px-3 py-2.5">
					<p class="text-sm text-text font-medium">{getInput('title')}</p>
					{#if getInput('due_date')}
						<p class="text-xs text-text-subtle mt-1">Fällig: {getInput('due_date')}</p>
					{/if}
				</div>

			<!-- === Fallback (unknown tools) === -->
			{:else}
				{#if ctx.toolInput}
					<pre class="text-xs font-mono text-text-subtle whitespace-pre-wrap rounded-[var(--radius-md)] bg-bg p-3 border border-border max-h-48 overflow-y-auto scrollbar-thin">{JSON.stringify(ctx.toolInput, null, 2).slice(0, 1000)}</pre>
				{/if}
				{#if ctx.toolResult}
					<pre class="text-xs font-mono text-text-muted whitespace-pre-wrap break-all max-h-80 overflow-y-auto scrollbar-thin">{truncate(ctx.toolResult, 2000)}</pre>
				{/if}
			{/if}
		</div>
	</aside>
{/if}
