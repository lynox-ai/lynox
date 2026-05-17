<!--
	Tool Toggles — per-tool enable/disable with SERVER-SIDE enforcement.
	T5 of the deferred-batch. Disabled tools are merged into the agent's
	`excludeTools` at session creation (session.ts), so a prompt-injected
	tool_call never reaches the registry.

	Mounted under /app/settings/workspace/tools (Self-Host) per PRD-IA-V2
	P3-PR-B. P3-PR-E will additionally surface this under /privacy/tools on
	Managed. Power users disable web_search / http_request etc. for
	minimal-surface agents.
-->
<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';

	interface Tool { name: string; description: string }

	let tools = $state<Tool[]>([]);
	let disabled = $state<Set<string>>(new Set());
	let loaded = $state(false);
	let saving = $state(false);
	// Serialize PUTs so rapid toggles don't race: each click chains onto the
	// previous request's tail. Without this, an in-flight failure's revert can
	// stomp a successful later toggle's optimistic state, leaving UI and
	// server out of sync.
	let saveQueue: Promise<void> = Promise.resolve();

	async function load(): Promise<void> {
		try {
			const [toolsRes, configRes] = await Promise.all([
				fetch(`${getApiBase()}/tools/available`),
				fetch(`${getApiBase()}/config`),
			]);
			if (!toolsRes.ok || !configRes.ok) throw new Error(`HTTP ${toolsRes.status} / ${configRes.status}`);
			const toolsBody = (await toolsRes.json()) as { tools: Tool[] };
			tools = toolsBody.tools.sort((a, b) => a.name.localeCompare(b.name));
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

<section aria-labelledby="tool-toggles-heading" class="space-y-3">
	<header>
		<h2 id="tool-toggles-heading" class="text-lg font-medium">{t('tools.heading')}</h2>
		<p class="text-xs text-text-muted">{t('tools.subtitle')}</p>
	</header>

	{#if !loaded}
		<p class="text-sm text-text-muted">{t('tools.loading')}</p>
	{:else if tools.length === 0}
		<p class="text-sm text-text-muted italic">{t('tools.empty')}</p>
	{:else}
		<ul class="divide-y divide-border border border-border rounded">
			{#each tools as tool (tool.name)}
				<li class="flex items-start gap-3 p-3 hover:bg-bg-subtle">
					<input type="checkbox" id="tool-{tool.name}" class="mt-1 w-4 h-4"
						checked={!disabled.has(tool.name)} disabled={saving}
						onchange={() => toggle(tool.name)} />
					<label for="tool-{tool.name}" class="flex-1 cursor-pointer">
						<span class="font-mono text-sm font-medium">{tool.name}</span>
						{#if tool.description}
							<span class="block text-xs text-text-muted mt-0.5">{tool.description}</span>
						{/if}
					</label>
				</li>
			{/each}
		</ul>
		<p class="text-xs text-text-muted italic">{t('tools.note')}</p>
	{/if}
</section>
