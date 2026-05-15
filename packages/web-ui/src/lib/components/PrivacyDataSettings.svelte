<!--
	Privacy & Data — GDPR primitives + Bugsink error-reporting toggle.
	PRD-SETTINGS-REFACTOR Phase 3. Hosts the Stop-Gap mailto delete-request
	(Phase 5/6 swaps in synchronous DELETE /api/privacy/account).
-->
<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';

	interface Config {
		bugsink_enabled?: boolean;
		managed?: string;
	}

	let config = $state<Config>({});
	let saving = $state(false);
	let loaded = $state(false);
	let managed = $state(false);

	async function load(): Promise<void> {
		try {
			const res = await fetch(`${getApiBase()}/config`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = (await res.json()) as Config;
			config = { bugsink_enabled: body.bugsink_enabled };
			managed = body.managed === 'managed' || body.managed === 'managed_pro' || body.managed === 'eu';
			loaded = true;
		} catch (e) {
			addToast(e instanceof Error ? e.message : t('privacy.load_failed'), 'error', 5000);
		}
	}

	async function saveBugsink(): Promise<void> {
		saving = true;
		try {
			const res = await fetch(`${getApiBase()}/config`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ bugsink_enabled: config.bugsink_enabled }),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			addToast(t('privacy.saved'), 'success', 3000);
		} catch (e) {
			addToast(e instanceof Error ? e.message : t('privacy.save_failed'), 'error', 5000);
		} finally {
			saving = false;
		}
	}

	async function requestDelete(): Promise<void> {
		// Stop-gap (PRD Phase 3): server logs an audit entry, then we open
		// the mailto. Phase 6 replaces this with a synchronous DELETE flow.
		try {
			await fetch(`${getApiBase()}/privacy/delete-request`, { method: 'POST' });
		} catch { /* mailto still opens even if audit fails */ }
		const subject = encodeURIComponent('Account deletion request');
		const bodyText = encodeURIComponent('I would like my lynox account and all associated data permanently deleted under GDPR Article 17.\n\nMy account email: \n');
		window.location.href = `mailto:privacy@lynox.ai?subject=${subject}&body=${bodyText}`;
	}

	$effect(() => { void load(); });
</script>

<div class="space-y-6 max-w-3xl mx-auto p-4">
	<header>
		<h1 class="text-2xl font-semibold mb-1">{t('privacy.title')}</h1>
		<p class="text-sm text-text-muted">{t('privacy.subtitle')}</p>
	</header>

	<!-- Data export — placeholder until /api/privacy/export ships (Phase 5/6). -->
	<section class="border-t border-border pt-6 space-y-2">
		<h2 class="text-lg font-medium">{t('privacy.export_heading')}</h2>
		<p class="text-xs text-text-muted">{t('privacy.export_subtitle')}</p>
		<button type="button" disabled
			class="px-3 py-1.5 text-sm border border-border rounded opacity-50 cursor-not-allowed">
			{t('privacy.export_soon')}
		</button>
	</section>

	<!-- Audit log — placeholder. -->
	<section class="border-t border-border pt-6 space-y-2">
		<h2 class="text-lg font-medium">{t('privacy.audit_heading')}</h2>
		<p class="text-xs text-text-muted">{t('privacy.audit_subtitle')}</p>
		<p class="text-xs text-text-muted italic">{t('privacy.audit_soon')}</p>
	</section>

	<!-- Bugsink toggle (moved from old Compliance tab) -->
	<section class="border-t border-border pt-6 space-y-3">
		<h2 class="text-lg font-medium">{t('privacy.bugsink_heading')}</h2>
		<p class="text-xs text-text-muted">{t('privacy.bugsink_subtitle')}</p>
		{#if managed}
			<p class="text-sm italic text-text-muted">{t('privacy.bugsink_managed_fixed')}</p>
		{:else}
			<label class="flex items-center gap-2 cursor-pointer">
				<input type="checkbox" disabled={!loaded || saving} bind:checked={config.bugsink_enabled}
					onchange={saveBugsink} class="w-4 h-4" />
				<span class="text-sm">{t('privacy.bugsink_label')}</span>
			</label>
		{/if}
	</section>

	<!-- Account delete (Stop-Gap mailto, PRD Phase 3) -->
	<section class="border-t border-border pt-6 space-y-3">
		<h2 class="text-lg font-medium">{t('privacy.delete_heading')}</h2>
		<p class="text-xs text-text-muted">{t('privacy.delete_subtitle')}</p>
		<button type="button" onclick={requestDelete}
			class="px-3 py-1.5 text-sm border border-danger text-danger rounded hover:bg-danger/5">
			{t('privacy.delete_button')}
		</button>
	</section>
</div>
