<!--
	Bulk runs' on/off for the owner (UX-031, wording ux U-053). Mounted above the tool list on
	/app/settings/policy-tools, for the owner only: the page leaves it out for a mandate, and the
	server refuses a mandate's `PUT /api/config` anyway. What the switch shows comes from
	`bulkRunsView`; after every save the page reads the config again, so it shows what the engine
	runs, not what was sent.
-->
<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';
	import { bulkRunsView, type BulkRunsView } from './bulk-runs-setting.js';

	let view = $state<BulkRunsView | null>(null);
	let saving = $state(false);

	async function load(): Promise<void> {
		try {
			const res = await fetch(`${getApiBase()}/config`);
			if (!res.ok) return;
			view = bulkRunsView(await res.json());
		} catch {
			// The tool list below reports a config it cannot load; this section just stays away.
		}
	}

	async function toggle(): Promise<void> {
		if (!view || view.lockedKey !== null || saving) return;
		const next = !view.on;
		view = { ...view, on: next };
		saving = true;
		try {
			const res = await fetch(`${getApiBase()}/config`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ bulk_runs_enabled: next }),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			addToast(t('tools.saved'), 'success', 2000);
		} catch {
			view = { ...view, on: !next };
			addToast(t('tools.save_failed'), 'error', 5000);
		} finally {
			saving = false;
			await load();
		}
	}

	$effect(() => { void load(); });
</script>

{#if view}
	<section aria-labelledby="bulk-runs-heading" class="space-y-2 px-4 pt-4 max-w-3xl mx-auto" data-bulk-runs-setting>
		<h2 id="bulk-runs-heading" class="text-lg font-medium">{t('bulk.setting.title')}</h2>
		<p class="text-xs text-text-muted">{t('bulk.setting.description')}</p>
		<div class="flex items-center gap-3 p-3 border border-border rounded">
			<span id="bulk-runs-switch-label" class="flex-1 min-w-0 text-sm font-medium">{t('bulk.setting.switch')}</span>
			<button
				type="button"
				role="switch"
				aria-checked={view.on}
				aria-labelledby="bulk-runs-switch-label"
				aria-describedby={view.lockedKey ? 'bulk-runs-locked' : undefined}
				disabled={saving || view.lockedKey !== null}
				onclick={() => void toggle()}
				class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed {view.on ? 'bg-accent' : 'bg-border'}"
			>
				<span class="inline-block h-5 w-5 transform rounded-full bg-bg shadow transition-transform {view.on ? 'translate-x-5' : 'translate-x-0.5'}"></span>
			</button>
		</div>
		{#if view.lockedKey}
			<p id="bulk-runs-locked" class="text-xs text-text-muted">{t(view.lockedKey)}{#if view.lockedNextKey} {t(view.lockedNextKey)}{/if}</p>
		{/if}
		{#if view.shopifyKey}
			<p class="text-xs text-text-muted" data-bulk-runs-shopify>{t(view.shopifyKey)}</p>
		{/if}
	</section>
{/if}
