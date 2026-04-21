<script lang="ts">
	import { getContext, isPinned, togglePin, closePanel } from '../stores/context-panel.svelte.js';
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { getToolIcon } from '../utils/tool-icons.js';

	const ctx = $derived(getContext());
	const pinned = $derived(isPinned());

	const TOOL_LABELS: Record<string, string> = {
		write_file: 'tool.file_created', read_file: 'tool.file_read',
		bash: 'tool.command', http_request: 'tool.api_request',
		web_research: 'tool.web_search', spawn_agent: 'tool.delegated',
		memory_store: 'tool.remembered', memory_recall: 'tool.knowledge_recalled',
		memory_update: 'tool.knowledge_updated', data_store_query: 'tool.data_queried',
		data_store_insert: 'tool.data_stored', data_store_create: 'tool.table_created',
		run_pipeline: 'tool.pipeline', ask_user: 'tool.question',
		task_create: 'tool.task_created', plan_task: 'tool.plan_created',
		artifact_save: 'tool.artifact_saved', google_calendar: 'tool.calendar',
	};

	function meta(name: string) {
		const def = getToolIcon(name);
		const labelKey = TOOL_LABELS[name];
		const label = labelKey ? t(labelKey) : name;
		return { label, paths: def.paths, color: def.color };
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
	{@const headerMeta = meta(ctx.title)}
	<aside class="w-80 shrink-0 border-l border-border bg-bg-subtle overflow-y-auto overflow-x-hidden scrollbar-thin hidden lg:flex flex-col">
		<!-- Header -->
		<div class="flex items-center justify-between px-4 py-2.5 border-b border-border">
			<div class="flex items-center gap-2">
				<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0 {headerMeta.color}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
					{#each headerMeta.paths as p}<path stroke-linecap="round" stroke-linejoin="round" d={p} />{/each}
				</svg>
				<span class="text-xs font-medium text-text">{headerMeta.label}</span>
			</div>
			<div class="flex items-center gap-1.5">
				<button
					onclick={togglePin}
					class="text-xs px-1.5 py-0.5 rounded-[var(--radius-sm)] transition-colors {pinned ? 'bg-accent/10 text-accent-text' : 'text-text-subtle hover:text-text'}"
				>
					{pinned ? t('panel.pinned') : t('panel.pin')}
				</button>
				<button onclick={closePanel} class="text-text-subtle hover:text-text transition-colors p-1.5" aria-label="Close">
					<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
						<path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
					</svg>
				</button>
			</div>
		</div>

		<!-- Content -->
		<div class="flex-1 p-4 space-y-3">

			<!-- === Spawn (sub-agent delegation, live progress) === -->
			{#if ctx.type === 'spawn'}
				{@const agents = ctx.spawnAgents ?? []}
				{@const running = ctx.spawnRunning ?? []}
				{@const done = ctx.spawnDone ?? []}
				{@const lastTool = ctx.spawnLastTool ?? {}}
				{@const elapsed = ctx.spawnElapsedS ?? 0}
				<div class="flex items-center gap-2 text-xs text-text-muted">
					<span class="font-mono">{elapsed}s</span>
					{#if running.length > 0}
						<span class="inline-block h-1.5 w-1.5 rounded-full bg-warning animate-pulse" aria-hidden="true"></span>
						<span>{running.length} {t('spawn.active')}</span>
					{:else}
						<span class="inline-block h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true"></span>
						<span>{t('spawn.done')}</span>
					{/if}
					{#if agents.length > 0}
						<span class="text-text-subtle">·</span>
						<span>{done.length}/{agents.length}</span>
					{/if}
				</div>

				{#if running.length > 0}
					<div class="rounded-[var(--radius-md)] bg-bg border border-warning/20 overflow-hidden">
						<div class="px-3 py-1.5 border-b border-border bg-bg-muted">
							<span class="text-[10px] font-mono uppercase tracking-widest text-warning">{t('spawn.running')}</span>
						</div>
						<ul class="divide-y divide-border">
							{#each running as subName}
								<li class="px-3 py-2 flex items-center gap-2">
									<span class="inline-block h-1.5 w-1.5 rounded-full bg-warning animate-pulse shrink-0" aria-hidden="true"></span>
									<span class="text-xs font-mono text-text">{subName}</span>
									{#if lastTool[subName]}
										<span class="text-text-subtle text-[10px]">·</span>
										<span class="text-[10px] font-mono text-text-subtle truncate">{lastTool[subName]}</span>
									{/if}
								</li>
							{/each}
						</ul>
					</div>
				{/if}

				{#if done.length > 0}
					<div class="rounded-[var(--radius-md)] bg-bg border border-border overflow-hidden">
						<div class="px-3 py-1.5 border-b border-border bg-bg-muted">
							<span class="text-[10px] font-mono uppercase tracking-widest text-text-subtle">{t('spawn.completed')}</span>
						</div>
						<ul class="divide-y divide-border">
							{#each done as d}
								<li class="px-3 py-2 flex items-center gap-2">
									<span class={d.ok ? 'text-success' : 'text-danger'} aria-hidden="true">{d.ok ? '✓' : '✗'}</span>
									<span class="text-xs font-mono text-text-muted truncate flex-1">{d.name}</span>
									<span class="text-[10px] font-mono text-text-subtle shrink-0">{d.elapsedS}s</span>
								</li>
							{/each}
						</ul>
					</div>
				{/if}

			<!-- === File Operations === -->
			{:else if ctx.toolName === 'write_file' || ctx.toolName === 'read_file'}
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
