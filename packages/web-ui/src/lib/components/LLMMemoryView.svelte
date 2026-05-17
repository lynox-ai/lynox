<!--
	LLM Memory (PRD-IA-V2 P3-PR-C) — final canonical home for the two
	memory-extraction dials that previously lived as a collapsible panel on
	LLMSettings (`memory_extraction`, `memory_half_life_days`). Backend SSoT
	stays `/api/config`; same fields, no schema change.

	Path rationale (PRD-IA-V2 open-question #3): kept under `/llm/memory`
	rather than promoted to `/settings/memory` because extraction is
	LLM-driven. Foundation-Rework (Universal Subject Model sprint) may
	re-home this; sub-route nav is data-driven so the re-home is one array
	entry away.
-->
<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';

	interface UserConfig {
		memory_extraction?: boolean;
		memory_half_life_days?: number;
	}

	let config = $state<UserConfig>({});
	let loaded = $state(false);
	let saving = $state(false);

	async function load(): Promise<void> {
		try {
			const res = await fetch(`${getApiBase()}/config`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = (await res.json()) as UserConfig;
			config = {
				memory_extraction: body.memory_extraction,
				memory_half_life_days: body.memory_half_life_days,
			};
			loaded = true;
		} catch (e) {
			addToast(e instanceof Error ? e.message : t('llm.load_failed'), 'error', 5000);
		}
	}

	async function save(): Promise<void> {
		if (!loaded) return;
		saving = true;
		try {
			const update: UserConfig = {};
			if (typeof config.memory_extraction === 'boolean') update.memory_extraction = config.memory_extraction;
			if (typeof config.memory_half_life_days === 'number' && config.memory_half_life_days > 0) {
				update.memory_half_life_days = config.memory_half_life_days;
			}
			const res = await fetch(`${getApiBase()}/config`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(update),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			addToast(t('llm.saved'), 'success', 3000);
		} catch (e) {
			addToast(e instanceof Error ? e.message : t('llm.save_failed'), 'error', 5000);
		} finally {
			saving = false;
		}
	}

	$effect(() => { void load(); });
</script>

<div class="space-y-6 max-w-3xl mx-auto p-4">
	<a href="/app/settings/llm" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('llm.back_to_llm')}</a>
	<header>
		<h1 class="text-2xl font-semibold mb-1">{t('llm.memory.title')}</h1>
		<p class="text-sm text-text-muted">{t('llm.memory.subtitle')}</p>
	</header>

	{#if !loaded}
		<p class="text-sm text-text-muted">{t('cost_limits.loading')}</p>
	{:else}
		<section aria-labelledby="mem-heading" class="space-y-4">
			<h2 id="mem-heading" class="sr-only">{t('llm.memory.title')}</h2>

			<div class="flex items-center justify-between gap-3">
				<div>
					<p class="text-sm font-medium">{t('config.memory_extraction')}</p>
					<p class="text-xs text-text-muted mt-0.5">{t('config.memory_extraction_desc')}</p>
				</div>
				<button type="button"
					onclick={() => { config.memory_extraction = !config.memory_extraction; }}
					disabled={!loaded}
					aria-pressed={config.memory_extraction === true}
					aria-label={t('config.memory_extraction')}
					class="relative w-10 h-6 rounded-full transition-colors shrink-0 disabled:opacity-50 {config.memory_extraction ? 'bg-accent' : 'bg-border'}">
					<span class="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform {config.memory_extraction ? 'translate-x-4' : ''}"></span>
				</button>
			</div>

			<label class="block">
				<span class="block text-sm font-medium mb-1">{t('config.memory_half_life')}</span>
				<span class="block text-xs text-text-muted mb-1">{t('config.memory_half_life_desc')}</span>
				<input type="number" min="1" max="3650" placeholder="90"
					bind:value={config.memory_half_life_days} disabled={!loaded}
					class="w-full font-mono px-2 py-1 border border-border rounded bg-bg disabled:opacity-50" />
			</label>
		</section>

		<div class="flex justify-end">
			<button type="button" onclick={save} disabled={saving || !loaded}
				class="px-4 py-2 bg-accent text-accent-fg rounded hover:opacity-90 disabled:opacity-50">
				{saving ? t('llm.saving') : t('llm.save')}
			</button>
		</div>
	{/if}
</div>
