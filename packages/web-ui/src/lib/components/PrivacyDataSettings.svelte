<!--
	Privacy & Data — GDPR primitives + Bugsink error-reporting toggle.
	PRD-SETTINGS-REFACTOR Phase 3. Hosts the Stop-Gap mailto delete-request
	(Phase 5/6 swaps in synchronous DELETE /api/privacy/account).
-->
<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';

	let managed = $state(false);
	let loaded = $state(false);
	let saving = $state(false);
	let bugsinkEnabled = $state(true);
	let bugsinkDsnConfigured = $state(false);
	// Extended debug capture (operator surface) — opt-in, default OFF.
	let debugWireCapture = $state(false);
	let savingWire = $state(false);
	// LYNOX_DEBUG_WIRE_CAPTURE pins the field via env and wins over config.json, so
	// the toggle must show the effective state and disable itself (writing disk would
	// be a silent no-op). Mirrors the provider env-override pattern in LLMSettings.
	let wireCaptureEnvPinned = $state(false);

	async function load(): Promise<void> {
		try {
			const res = await fetch(`${getApiBase()}/config`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = (await res.json()) as { managed?: string; bugsink_enabled?: boolean; bugsink_dsn_configured?: boolean; debug_wire_capture?: boolean; env_overrides?: { debug_wire_capture?: boolean } };
			managed = body.managed === 'managed' || body.managed === 'managed_pro' || body.managed === 'eu';
			bugsinkEnabled = body.bugsink_enabled !== false;
			bugsinkDsnConfigured = body.bugsink_dsn_configured === true;
			// The server surfaces the EFFECTIVE value (env override applied), so this
			// reflects what actually runs even when config.json says otherwise.
			debugWireCapture = body.debug_wire_capture === true;
			wireCaptureEnvPinned = body.env_overrides?.debug_wire_capture === true;
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
				body: JSON.stringify({ bugsink_enabled: bugsinkEnabled }),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			addToast(t('privacy.saved'), 'success', 3000);
		} catch (e) {
			addToast(e instanceof Error ? e.message : t('privacy.save_failed'), 'error', 5000);
		} finally {
			saving = false;
		}
	}

	async function saveDebugWireCapture(): Promise<void> {
		savingWire = true;
		try {
			const res = await fetch(`${getApiBase()}/config`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ debug_wire_capture: debugWireCapture }),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			addToast(t('privacy.saved'), 'success', 3000);
		} catch (e) {
			// Roll the checkbox back to the persisted value on failure so the UI
			// never claims an unsaved state is saved.
			debugWireCapture = !debugWireCapture;
			addToast(e instanceof Error ? e.message : t('privacy.save_failed'), 'error', 5000);
		} finally {
			savingWire = false;
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
	<a href="/app/settings" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('settings.back')}</a>
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

	<!-- Bugsink toggle — properly wired in T4 of the deferred-batch.
	     On managed the CP pre-configures the DSN; on self-host the user supplies
	     LYNOX_BUGSINK_DSN. Either way the on/off toggle is user-controlled —
	     GDPR Art. 21 right to object overrides the DPIA's "always-on" framing,
	     and the server-side allowlist (`MANAGED_USER_WRITABLE_CONFIG` includes
	     `bugsink_enabled`) accepts the opt-out from managed users too. -->
	<section class="border-t border-border pt-6 space-y-3">
		<h2 class="text-lg font-medium">{t('privacy.bugsink_heading')}</h2>
		<p class="text-xs text-text-muted">{t('privacy.bugsink_subtitle')}</p>
		{#if !bugsinkDsnConfigured && !managed}
			<p class="text-sm italic text-text-muted">{t('privacy.bugsink_self_host_env')}</p>
		{:else}
			<label class="flex items-center gap-2 cursor-pointer">
				<input type="checkbox" disabled={!loaded || saving} bind:checked={bugsinkEnabled}
					onchange={saveBugsink} class="w-4 h-4" />
				<span class="text-sm">{t('privacy.bugsink_label')}</span>
			</label>
		{/if}
	</section>

	<!-- Extended debug capture (operator surface) — opt-in, default OFF. Persists a
	     REDACTED per-turn snapshot of the fully-assembled request ("what the model
	     received", secrets scrubbed) to this instance's OWN history.db, bundled into
	     the OWN debug export. Owner-scoped, same data-retention class as the Bugsink
	     toggle. See pro docs/internal/prd/extended-debug-capture.md. -->
	<section class="border-t border-border pt-6 space-y-3">
		<h2 class="text-lg font-medium">{t('privacy.wire_capture_heading')}</h2>
		<p class="text-xs text-text-muted">{t('privacy.wire_capture_subtitle')}</p>
		<label class="flex items-center gap-2" class:cursor-pointer={!wireCaptureEnvPinned}>
			<input type="checkbox" disabled={!loaded || savingWire || wireCaptureEnvPinned} bind:checked={debugWireCapture}
				onchange={saveDebugWireCapture} class="w-4 h-4" />
			<span class="text-sm">{t('privacy.wire_capture_label')}</span>
		</label>
		{#if wireCaptureEnvPinned}
			<p class="text-xs text-warning">{t('privacy.wire_capture_env_pinned')}</p>
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
