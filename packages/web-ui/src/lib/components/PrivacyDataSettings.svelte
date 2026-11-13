<!--
	Privacy & Data — GDPR primitives + Bugsink error-reporting toggle.
	PRD-SETTINGS-REFACTOR Phase 3. Hosts the Stop-Gap mailto delete-request
	(Phase 5/6 swaps in synchronous DELETE /api/privacy/account).
-->
<script lang="ts">
	import { cpSuppliesLLMKey, isHostedInstance } from '../utils/billing-tier.js';
	import { ACCOUNT_PAGE_URL } from '../account-page.js';
	import { getApiBase } from '../config.svelte.js';
	import { saveFailedText, throwIfRefused } from '../api/save-refusal.js';
	import { t } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';
	import { isMandateSession, viewerNote } from '../stores/settings-viewer.svelte.js';
	import OwnerOnlyNotice from './settings-readonly/OwnerOnlyNotice.svelte';
	import ReadOnlyRows from './settings-readonly/ReadOnlyRows.svelte';
	import { onOff } from './settings-readonly/values.js';

	let managed = $state(false);
	// Every CP-provisioned instance, BYOK `hosted` included: they all have the account page. `managed`
	// above is narrower (the CP supplies the LLM key) and decides the error-reporting rows only.
	let hosted = $state(false);
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
			const noteViewer = viewerNote();
			const res = await fetch(`${getApiBase()}/config`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = (await res.json()) as { managed?: string; bugsink_enabled?: boolean; bugsink_dsn_configured?: boolean; debug_wire_capture?: boolean; env_overrides?: { debug_wire_capture?: boolean } };
			noteViewer(body);
			managed = cpSuppliesLLMKey(body.managed);
			hosted = isHostedInstance(body.managed);
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
			await throwIfRefused(res);
			addToast(t('privacy.saved'), 'success', 3000);
		} catch (e) {
			addToast(saveFailedText(e, t('privacy.save_failed')), 'error', 5000);
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
			await throwIfRefused(res);
			addToast(t('privacy.saved'), 'success', 3000);
		} catch (e) {
			// Roll the checkbox back to the persisted value on failure so the UI
			// never claims an unsaved state is saved.
			debugWireCapture = !debugWireCapture;
			addToast(saveFailedText(e, t('privacy.save_failed')), 'error', 5000);
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

	// A mandate's session (ux U-104): the switches as text. Error reporting only where the owner's
	// page shows its switch (a DSN is set, or the instance is managed).
	const mandateRows = $derived([
		...(!bugsinkDsnConfigured && !managed ? [] : [{ label: t('privacy.bugsink_label'), value: onOff(bugsinkEnabled) }]),
		{ label: t('privacy.wire_capture_label'), value: onOff(debugWireCapture) },
	]);
</script>

<div class="space-y-6 max-w-3xl mx-auto p-4">
	<a href="/app/settings" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('settings.back')}</a>
	<header>
		<h1 class="text-2xl font-semibold mb-1">{t('privacy.title')}</h1>
		<p class="text-sm text-text-muted">{t('privacy.subtitle')}</p>
	</header>

	{#if isMandateSession()}
		<!-- PUT /api/config is the owner's, and so is the account the delete request names. -->
		<OwnerOnlyNotice />
		{#if loaded}
			<ReadOnlyRows rows={mandateRows} />
		{/if}
	{:else}
	<!-- Data export. A CP-provisioned instance (BYOK `hosted` included) exports from the account
	     page; self-host has no export from the app yet and is told so, without a date. Nothing is
	     said until the config has loaded, so neither text shows on a guess. -->
	{#if loaded}
	<section class="border-t border-border pt-6 space-y-2">
		<h2 class="text-lg font-medium">{t('privacy.export_heading')}</h2>
		{#if hosted}
			<p class="text-xs text-text-muted">{t('privacy.export_subtitle_managed')}</p>
			<a href={ACCOUNT_PAGE_URL} target="_blank" rel="noopener" class="inline-block text-sm text-accent-text hover:underline">{t('privacy.export_link')}</a>
		{:else}
			<p class="text-xs text-text-muted">{t('privacy.export_subtitle_selfhost')}</p>
		{/if}
	</section>
	{/if}

	<!-- The instance log: what people the owner gave access to did here, never content. The page
	     lives in the owner's branch only, as does the log itself (GET /api/access-trail). -->
	<section class="border-t border-border pt-6 space-y-2">
		<h2 class="text-lg font-medium">{t('privacy.audit_heading')}</h2>
		<p class="text-xs text-text-muted">{t('privacy.audit_subtitle')}</p>
		<a href="/app/settings/account/access-log" class="inline-block text-sm text-accent-text hover:underline">{t('privacy.audit_open')}</a>
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
	{/if}
</div>
