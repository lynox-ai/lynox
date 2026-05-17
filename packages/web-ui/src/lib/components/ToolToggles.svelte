<!--
	Tool Toggles — per-tool enable/disable with SERVER-SIDE enforcement.
	T5 of the deferred-batch. Disabled tools are merged into the agent's
	`excludeTools` at session creation (session.ts), so a prompt-injected
	tool_call never reaches the registry.

	Mounted under /app/settings/workspace/tools (Self-Host) per PRD-IA-V2
	P3-PR-B and /app/settings/privacy/tools (Managed) per P3-PR-E. Power
	users disable web_research / http_request etc. for minimal-surface agents.

	P3-FOLLOWUP-HOTFIX (2026-05-17): switched to right-aligned iOS-style
	switches grouped by tool category for scan-ability.
-->
<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';

	interface Tool { name: string; description: string }
	interface CategorizedTool extends Tool { categoryKey: string }
	interface CategoryGroup { labelKey: string; tools: CategorizedTool[] }

	let tools = $state<Tool[]>([]);
	let disabled = $state<Set<string>>(new Set());
	let loaded = $state(false);
	let saving = $state(false);
	// Serialize PUTs so rapid toggles don't race: each click chains onto the
	// previous request's tail. Without this, an in-flight failure's revert can
	// stomp a successful later toggle's optimistic state, leaving UI and
	// server out of sync.
	let saveQueue: Promise<void> = Promise.resolve();

	// Tool → category mapping (UI-only). Keep prefixes ordered most-specific
	// first; falls through to 'other' for tools the registry adds later.
	const CATEGORY_RULES: Array<{ match: (n: string) => boolean; key: string; labelKey: string }> = [
		{ match: (n) => n.startsWith('mail_'),                key: 'communication',  labelKey: 'tools.category.communication' },
		{ match: (n) => n === 'whatsapp',                     key: 'communication',  labelKey: 'tools.category.communication' },
		{ match: (n) => n.startsWith('google_'),              key: 'google',         labelKey: 'tools.category.google' },
		{ match: (n) => n === 'web_research' || n === 'http_request', key: 'web',   labelKey: 'tools.category.web' },
		{ match: (n) => n === 'read_file' || n === 'write_file' || n === 'batch_files', key: 'files', labelKey: 'tools.category.files' },
		{ match: (n) => n.startsWith('artifact'),             key: 'artifacts',      labelKey: 'tools.category.artifacts' },
		{ match: (n) => n.startsWith('memory_'),              key: 'memory',         labelKey: 'tools.category.memory' },
		{ match: (n) => n.startsWith('data_store_'),          key: 'data',           labelKey: 'tools.category.data' },
		{ match: (n) => n === 'contacts' || n === 'deals' || n === 'interactions',    key: 'crm',  labelKey: 'tools.category.crm' },
		{ match: (n) => n.startsWith('task_') || n === 'plan_task' || n === 'step_complete', key: 'tasks', labelKey: 'tools.category.tasks' },
		{ match: (n) => n === 'run_pipeline' || n === 'spawn_agent' || n === 'propose_dag',  key: 'orchestration', labelKey: 'tools.category.orchestration' },
		{ match: (n) => n === 'ask_user' || n === 'ask_secret',                       key: 'interaction', labelKey: 'tools.category.interaction' },
		{ match: (n) => n === 'api_setup' || n === 'vault_secrets',                   key: 'integration', labelKey: 'tools.category.integration' },
		{ match: (n) => n === 'bash' || n.endsWith('_process') || n === 'extract' || n === 'score_results', key: 'system', labelKey: 'tools.category.system' },
	];
	const FALLBACK_CATEGORY = { key: 'other', labelKey: 'tools.category.other' };

	// Display order — communication-first because that's the most common
	// "I want to lock this down" target; system + other at the bottom.
	const CATEGORY_ORDER = [
		'communication', 'google', 'web', 'files', 'artifacts', 'memory',
		'data', 'crm', 'tasks', 'orchestration', 'interaction', 'integration',
		'system', 'other',
	];

	function categorize(name: string): { key: string; labelKey: string } {
		for (const rule of CATEGORY_RULES) {
			if (rule.match(name)) return { key: rule.key, labelKey: rule.labelKey };
		}
		return FALLBACK_CATEGORY;
	}

	const grouped = $derived.by((): CategoryGroup[] => {
		const buckets = new Map<string, CategoryGroup>();
		for (const tool of tools) {
			const { key, labelKey } = categorize(tool.name);
			let group = buckets.get(key);
			if (!group) {
				group = { labelKey, tools: [] };
				buckets.set(key, group);
			}
			group.tools.push({ ...tool, categoryKey: key });
		}
		// Sort tools within each group alphabetically; sort groups by
		// CATEGORY_ORDER index (unknowns fall to the end).
		for (const g of buckets.values()) {
			g.tools.sort((a, b) => a.name.localeCompare(b.name));
		}
		return [...buckets.entries()]
			.sort(([a], [b]) => {
				const ai = CATEGORY_ORDER.indexOf(a);
				const bi = CATEGORY_ORDER.indexOf(b);
				return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
			})
			.map(([, g]) => g);
	});

	async function load(): Promise<void> {
		try {
			const [toolsRes, configRes] = await Promise.all([
				fetch(`${getApiBase()}/tools/available`),
				fetch(`${getApiBase()}/config`),
			]);
			if (!toolsRes.ok || !configRes.ok) throw new Error(`HTTP ${toolsRes.status} / ${configRes.status}`);
			const toolsBody = (await toolsRes.json()) as { tools: Tool[] };
			tools = toolsBody.tools;
			const configBody = (await configRes.json()) as { disabled_tools?: string[] };
			disabled = new Set(configBody.disabled_tools ?? []);
			loaded = true;
		} catch (e) {
			addToast(e instanceof Error ? e.message : t('tools.load_failed'), 'error', 5000);
		}
	}

	function toggle(name: string): void {
		const next = new Set(disabled);
		if (next.has(name)) next.delete(name); else next.add(name);
		disabled = next;
		saving = true;
		// Capture the post-toggle snapshot — race-free because Svelte $state
		// reads are synchronous and `disabled` was just assigned above.
		const snapshot = Array.from(disabled);
		saveQueue = saveQueue
			.then(async () => {
				const res = await fetch(`${getApiBase()}/config`, {
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ disabled_tools: snapshot }),
				});
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				addToast(t('tools.saved'), 'success', 2000);
			})
			.catch((e: unknown) => {
				// Revert optimistic state on failure
				disabled = new Set(disabled.has(name) ? [...disabled].filter((d) => d !== name) : [...disabled, name]);
				addToast(e instanceof Error ? e.message : t('tools.save_failed'), 'error', 5000);
			})
			.finally(() => {
				saving = false;
			});
	}

	$effect(() => { void load(); });
</script>

<section aria-labelledby="tool-toggles-heading" class="space-y-4 p-4 max-w-3xl mx-auto">
	<header>
		<h2 id="tool-toggles-heading" class="text-lg font-medium">{t('tools.heading')}</h2>
		<p class="text-xs text-text-muted">{t('tools.subtitle')}</p>
	</header>

	{#if !loaded}
		<p class="text-sm text-text-muted">{t('tools.loading')}</p>
	{:else if tools.length === 0}
		<p class="text-sm text-text-muted italic">{t('tools.empty')}</p>
	{:else}
		{#each grouped as group}
			<section class="space-y-1">
				<h3 class="text-xs font-mono uppercase tracking-widest text-text-subtle pb-1.5">{t(group.labelKey)}</h3>
				<ul class="divide-y divide-border border border-border rounded">
					{#each group.tools as tool (tool.name)}
						<li class="flex items-center gap-3 p-3 hover:bg-bg-subtle">
							<div class="flex-1 min-w-0">
								<span class="font-mono text-sm font-medium">{tool.name}</span>
								{#if tool.description}
									<span class="block text-xs text-text-muted mt-0.5">{tool.description}</span>
								{/if}
							</div>
							<!-- Right-aligned iOS-style switch (replaces left-aligned checkbox). -->
							<button
								type="button"
								role="switch"
								aria-checked={!disabled.has(tool.name)}
								aria-label={tool.name}
								disabled={saving}
								onclick={() => toggle(tool.name)}
								class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed {!disabled.has(tool.name) ? 'bg-accent' : 'bg-border'}"
							>
								<span class="inline-block h-5 w-5 transform rounded-full bg-bg shadow transition-transform {!disabled.has(tool.name) ? 'translate-x-5' : 'translate-x-0.5'}"></span>
							</button>
						</li>
					{/each}
				</ul>
			</section>
		{/each}
		<p class="text-xs text-text-muted italic">{t('tools.note')}</p>
	{/if}
</section>
