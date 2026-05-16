<!--
	Workspace Updates — startup update-check toggle.
	PRD-IA-V2 P3-PR-B: extracted from `SystemSettings.svelte:72-86`. Self-host
	only — managed instances receive updates via CP rollouts, so the toggle is
	hidden and a minimal notice shown instead.
-->
<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';

	interface ConfigResponse {
		update_check?: boolean;
		managed?: string;
	}

	let updateCheck = $state<boolean | undefined>(undefined);
	let managed = $state(false);
	let loaded = $state(false);
	let saving = $state(false);

	async function load(): Promise<void> {
		try {
			const res = await fetch(`${getApiBase()}/config`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = (await res.json()) as ConfigResponse;
			updateCheck = body.update_check;
			managed = body.managed === 'managed' || body.managed === 'managed_pro' || body.managed === 'eu';
			loaded = true;
		} catch (e) {
			addToast(e instanceof Error ? e.message : t('system.load_failed'), 'error', 5000);
		}
	}

	async function save(): Promise<void> {
		saving = true;
		try {
			const res = await fetch(`${getApiBase()}/config`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ update_check: updateCheck }),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			addToast(t('system.saved'), 'success', 3000);
		} catch (e) {
			addToast(e instanceof Error ? e.message : t('system.save_failed'), 'error', 5000);
		} finally {
			saving = false;
		}
	}

	$effect(() => { void load(); });
</script>

<div class="space-y-6 max-w-3xl mx-auto p-4">
	<header>
		<h1 class="text-2xl font-semibold mb-1">{t('settings.workspace.updates')}</h1>
		<p class="text-sm text-text-muted">{t('settings.workspace.updates_desc')}</p>
	</header>

	{#if managed}
		<section class="border border-border rounded p-4 text-sm text-text-muted">
			<p>{t('system.managed_minimal')}</p>
		</section>
	{:else if !loaded}
		<p class="text-sm text-text-muted">{t('system.loading')}</p>
	{:else}
		<section class="border-t border-border pt-6 space-y-2">
			<h2 class="text-lg font-medium">{t('system.update_heading')}</h2>
			<p class="text-xs text-text-muted">{t('system.update_subtitle')}</p>
			<label class="flex items-center gap-2 cursor-pointer">
				<input type="checkbox" disabled={saving} bind:checked={updateCheck}
					onchange={save} class="w-4 h-4" />
				<span class="text-sm">{t('system.update_label')}</span>
			</label>
		</section>
	{/if}
</div>
