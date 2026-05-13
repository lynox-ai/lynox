<script lang="ts">
	// === Calendar settings — Multi-Step Wizard (Phase 1a) ===
	//
	// Add-Account wizard: pick provider → credentials → test → save.
	// PRD §U15 — Card-Grid for preset selection (Step 1 visual), then a
	// single form page for credentials with inline Test-Connection button.
	//
	// Existing accounts render as rows above the "+ Add Calendar" button.
	// Each row exposes: set-default-writable, delete (Phase 1a). Edit-mode
	// (rename, switch preset, change password) lands in Phase 2.
	//
	// Account-Error-Surface (PRD §U16): Settings-row Red-Dot when
	// `has_credentials === false`; Toast on tool-call failure (wired by
	// the calling page); agent-message-wording happens at the engine layer.

	import { onMount } from 'svelte';
	import { getApiBase } from '../config.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';
	import {
		listCalDavPresets,
		listCalendarAccounts,
		addCalendarAccount,
		testCalendarAccount,
		deleteCalendarAccount,
		setDefaultWritableAccount,
		type CalDavPreset,
		type CalDavPresetSlug,
		type CalendarAccountView,
		type AddAccountInput,
	} from '../api/calendar-accounts.js';

	let presets = $state<CalDavPreset[]>([]);
	let accounts = $state<CalendarAccountView[]>([]);
	let loading = $state(true);

	// Wizard state. 'list' is the default landing pane; the rest are the
	// Add-Account flow steps. Cancel always returns to 'list'.
	type Step = 'list' | 'pick' | 'form';
	let step = $state<Step>('list');

	// Selection from Step 1: either a CalDAV preset or the ICS-Feed escape hatch.
	type Selection =
		| { kind: 'caldav'; slug: CalDavPresetSlug | 'custom'; preset: CalDavPreset | null }
		| { kind: 'ics-feed' };
	let selection = $state<Selection | null>(null);

	// Step 2 form fields. Reset on every wizard restart.
	let formDisplayName = $state('');
	let formUsername = $state('');
	let formPassword = $state('');
	let formServerUrl = $state(''); // custom-only
	let formIcsUrl = $state('');
	let formPollIntervalMin = $state(10);
	let formIsDefaultWritable = $state(false);

	let saving = $state(false);
	let testing = $state(false);
	let testResult = $state<{ ok: boolean; error?: string; code?: string } | null>(null);

	onMount(() => {
		void reload();
	});

	async function reload(): Promise<void> {
		loading = true;
		try {
			const apiBase = getApiBase();
			[presets, accounts] = await Promise.all([
				listCalDavPresets(apiBase),
				listCalendarAccounts(apiBase),
			]);
		} finally {
			loading = false;
		}
	}

	function startWizard(): void {
		resetForm();
		step = 'pick';
	}

	function cancelWizard(): void {
		resetForm();
		step = 'list';
	}

	function resetForm(): void {
		selection = null;
		formDisplayName = '';
		formUsername = '';
		formPassword = '';
		formServerUrl = '';
		formIcsUrl = '';
		formPollIntervalMin = 10;
		formIsDefaultWritable = false;
		testResult = null;
	}

	function pickPreset(slug: CalDavPresetSlug | 'custom'): void {
		const preset = slug === 'custom' ? null : (presets.find((p) => p.slug === slug) ?? null);
		selection = { kind: 'caldav', slug, preset };
		// Pre-fill display name with the preset label as a starting point.
		formDisplayName = preset?.display_name ?? '';
		step = 'form';
	}

	function pickIcsFeed(): void {
		selection = { kind: 'ics-feed' };
		formDisplayName = '';
		step = 'form';
	}

	function buildInput(): AddAccountInput | null {
		if (selection === null) return null;
		if (!formDisplayName.trim()) return null;

		if (selection.kind === 'caldav') {
			if (!formUsername.trim() || !formPassword) return null;
			if (selection.slug === 'custom' && !formServerUrl.trim()) return null;
			const base = {
				provider: 'caldav' as const,
				display_name: formDisplayName.trim(),
				preset_slug: selection.slug,
				username: formUsername.trim(),
				password: formPassword,
				is_default_writable: formIsDefaultWritable,
			};
			return selection.slug === 'custom'
				? { ...base, server_url: formServerUrl.trim() }
				: base;
		}

		if (!formIcsUrl.trim()) return null;
		return {
			provider: 'ics-feed',
			display_name: formDisplayName.trim(),
			ics_url: formIcsUrl.trim(),
			poll_interval_minutes: formPollIntervalMin,
		};
	}

	async function runTest(): Promise<void> {
		const input = buildInput();
		if (!input) {
			testResult = { ok: false, error: 'Bitte erst alle Felder ausfüllen' };
			return;
		}
		testing = true;
		testResult = null;
		try {
			testResult = await testCalendarAccount(getApiBase(), input);
		} catch (err) {
			testResult = { ok: false, error: err instanceof Error ? err.message : String(err) };
		} finally {
			testing = false;
		}
	}

	async function save(): Promise<void> {
		const input = buildInput();
		if (!input) {
			addToast('Bitte alle Pflichtfelder ausfüllen', 'error');
			return;
		}
		saving = true;
		try {
			const result = await addCalendarAccount(getApiBase(), input);
			if (!result.ok) {
				addToast(`Speichern fehlgeschlagen: ${result.error}`, 'error');
				return;
			}
			const calendarCount = result.account.enabled_calendars?.length;
			const msg = calendarCount !== undefined && calendarCount > 0
				? `Connected: ${calendarCount} Kalender erkannt`
				: 'Calendar verbunden';
			addToast(msg, 'success');
			cancelWizard();
			await reload();
		} finally {
			saving = false;
		}
	}

	async function removeAccount(id: string, displayName: string): Promise<void> {
		// eslint-disable-next-line no-alert
		if (!confirm(`"${displayName}" wirklich entfernen? Kalender-Cache wird gelöscht.`)) return;
		const ok = await deleteCalendarAccount(getApiBase(), id);
		if (!ok) {
			addToast('Löschen fehlgeschlagen', 'error');
			return;
		}
		addToast('Calendar entfernt', 'success');
		await reload();
	}

	async function makeDefault(id: string): Promise<void> {
		const ok = await setDefaultWritableAccount(getApiBase(), id);
		if (!ok) {
			addToast('Default setzen fehlgeschlagen', 'error');
			return;
		}
		await reload();
	}

	function residencyLabel(r: 'EU' | 'US' | 'AU' | 'user-controlled' | undefined): string {
		if (r === 'EU') return '🇪🇺 EU';
		if (r === 'user-controlled') return '🇪🇺 self-host';
		if (r === 'US') return '🌍 US';
		if (r === 'AU') return '🌍 AU';
		return '';
	}
</script>

<section class="calendar-settings">
	<header>
		<h2>Kalender</h2>
		<p class="hint">
			Verbinde deinen Kalender mit lynox. CalDAV-Provider (iCloud, Fastmail, Nextcloud,
			mailbox.org, Posteo, Zoho, Yahoo) unterstützen vollen Lese-/Schreibzugriff.
			Google Workspace + Microsoft 365 funktionieren via ICS-Feed (read-only).
		</p>
	</header>

	{#if loading}
		<p class="muted">Lade…</p>
	{:else if step === 'list'}
		{#if accounts.length === 0}
			<p class="empty">Noch keine Kalender verbunden.</p>
		{:else}
			<ul class="accounts">
				{#each accounts as account (account.id)}
					<li class:no-creds={!account.has_credentials}>
						<div class="row">
							<div class="primary">
								<strong>{account.display_name}</strong>
								<span class="provider-chip">{account.provider}</span>
								{#if account.data_residency}
									<span class="residency-chip">{residencyLabel(account.data_residency)}</span>
								{/if}
								{#if account.is_default_writable}
									<span class="default-chip">Default</span>
								{/if}
								{#if !account.has_credentials}
									<span class="error-chip" title="Anmeldedaten fehlen — bitte erneut verbinden">●</span>
								{/if}
							</div>
							<div class="meta">
								{#if account.provider === 'caldav'}
									<span>{account.username}</span>
								{:else}
									<span>poll alle {account.poll_interval_minutes ?? 10}min</span>
								{/if}
							</div>
							<div class="actions">
								{#if account.provider === 'caldav' && !account.is_default_writable}
									<button type="button" onclick={() => makeDefault(account.id)}>Als Default</button>
								{/if}
								<button type="button" class="danger" onclick={() => removeAccount(account.id, account.display_name)}>
									Entfernen
								</button>
							</div>
						</div>
					</li>
				{/each}
			</ul>
		{/if}
		<button type="button" class="primary-action" onclick={startWizard}>+ Kalender hinzufügen</button>
	{:else if step === 'pick'}
		<div class="wizard">
			<p class="step-label">Schritt 1 von 2 — Anbieter wählen</p>
			<div class="preset-grid">
				{#each presets as preset (preset.slug)}
					<button
						type="button"
						class="preset-card"
						onclick={() => pickPreset(preset.slug)}
					>
						<div class="preset-title">{preset.display_name}</div>
						<div class="preset-meta">
							<span class="residency-chip">{residencyLabel(preset.data_residency)}</span>
							{#if preset.auth_style === 'app-password'}
								<span class="auth-chip">App-Passwort</span>
							{/if}
						</div>
					</button>
				{/each}
				<button type="button" class="preset-card" onclick={() => pickPreset('custom')}>
					<div class="preset-title">Anderer CalDAV-Server</div>
					<div class="preset-meta">URL selbst eingeben</div>
				</button>
				<button type="button" class="preset-card ics" onclick={pickIcsFeed}>
					<div class="preset-title">ICS-Feed (read-only)</div>
					<div class="preset-meta">Google Workspace, Outlook, geteilte Kalender</div>
				</button>
			</div>
			<div class="wizard-actions">
				<button type="button" onclick={cancelWizard}>Abbrechen</button>
			</div>
		</div>
	{:else if step === 'form'}
		<div class="wizard">
			<p class="step-label">Schritt 2 von 2 — Zugangsdaten</p>

			<label class="field">
				<span>Anzeigename</span>
				<input type="text" bind:value={formDisplayName} placeholder="Privat / Arbeit / …" />
			</label>

			{#if selection?.kind === 'caldav'}
				{#if selection.slug === 'custom'}
					<label class="field">
						<span>CalDAV Server-URL</span>
						<input type="url" bind:value={formServerUrl} placeholder="https://example.com/caldav/" />
					</label>
				{:else if selection.preset?.server_url}
					<p class="muted">Server: <code>{selection.preset.server_url}</code></p>
				{/if}

				<label class="field">
					<span>Benutzername / E-Mail</span>
					<input type="text" bind:value={formUsername} autocomplete="username" />
				</label>

				<label class="field">
					<span>Passwort</span>
					<input type="password" bind:value={formPassword} autocomplete="current-password" />
				</label>

				{#if selection.preset?.auth_style === 'app-password' && selection.preset.app_password_help_url}
					<p class="help-text">
						{selection.preset.display_name} verlangt ein App-spezifisches Passwort.
						<a href={selection.preset.app_password_help_url} target="_blank" rel="noopener noreferrer">
							Hier erstellen →
						</a>
					</p>
				{/if}

				<label class="checkbox-field">
					<input type="checkbox" bind:checked={formIsDefaultWritable} />
					Als Default-Kalender für neue Termine setzen
				</label>
			{:else if selection?.kind === 'ics-feed'}
				<label class="field">
					<span>Secret-iCal-URL</span>
					<input type="url" bind:value={formIcsUrl} placeholder="https://calendar.google.com/calendar/ical/.../basic.ics" />
				</label>
				<p class="help-text">
					Google Calendar: Settings → Settings for my calendars → &lt;Kalender&gt; →
					„Secret address in iCal format". Bei Workspace muss external sharing erlaubt sein,
					sonst gibt der Server 404 zurück.
				</p>
				<label class="field">
					<span>Poll-Interval (Minuten)</span>
					<input type="number" min="5" max="60" bind:value={formPollIntervalMin} />
				</label>
			{/if}

			{#if testResult}
				<div class="test-result" class:ok={testResult.ok} class:fail={!testResult.ok}>
					{#if testResult.ok}
						✓ Verbindung erfolgreich
					{:else}
						✗ {testResult.error ?? 'Verbindung fehlgeschlagen'}
						{#if testResult.code}<span class="code">({testResult.code})</span>{/if}
					{/if}
				</div>
			{/if}

			<div class="wizard-actions">
				<button type="button" onclick={cancelWizard}>Abbrechen</button>
				<button type="button" onclick={runTest} disabled={testing}>
					{testing ? 'Teste…' : 'Verbindung testen'}
				</button>
				<button type="button" class="primary-action" onclick={save} disabled={saving}>
					{saving ? 'Speichere…' : 'Speichern'}
				</button>
			</div>
		</div>
	{/if}
</section>

<style>
	.calendar-settings { display: flex; flex-direction: column; gap: 1rem; }
	header h2 { margin: 0 0 0.25rem; }
	.hint { color: var(--text-muted, #888); font-size: 0.9rem; margin: 0; }
	.muted { color: var(--text-muted, #888); font-size: 0.9rem; }
	.empty { color: var(--text-muted, #888); font-style: italic; }

	.accounts { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.5rem; }
	.accounts li { border: 1px solid var(--border, rgba(255,255,255,0.1)); border-radius: 0.5rem; padding: 0.75rem; }
	.accounts li.no-creds { border-color: var(--danger, #e55); }
	.row { display: flex; flex-direction: column; gap: 0.25rem; }
	.primary { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
	.meta { font-size: 0.85rem; color: var(--text-muted, #888); }
	.actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; }

	.provider-chip, .residency-chip, .auth-chip, .default-chip {
		font-size: 0.75rem; padding: 0.1rem 0.4rem; border-radius: 0.25rem;
		background: var(--chip-bg, rgba(255,255,255,0.08));
	}
	.default-chip { background: var(--accent, #5af); color: white; }
	.error-chip { color: var(--danger, #e55); font-size: 1rem; line-height: 1; }

	.primary-action {
		background: var(--accent, #5af); color: white; border: none;
		padding: 0.5rem 1rem; border-radius: 0.25rem; cursor: pointer;
	}
	.danger { color: var(--danger, #e55); border-color: var(--danger, #e55); }

	.wizard { display: flex; flex-direction: column; gap: 1rem; }
	.step-label { color: var(--text-muted, #888); font-size: 0.85rem; margin: 0; }
	.wizard-actions { display: flex; gap: 0.5rem; justify-content: flex-end; }

	.preset-grid {
		display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 0.5rem;
	}
	.preset-card {
		display: flex; flex-direction: column; align-items: flex-start; gap: 0.25rem;
		padding: 0.75rem; border: 1px solid var(--border, rgba(255,255,255,0.1));
		border-radius: 0.5rem; background: transparent; cursor: pointer; text-align: left;
	}
	.preset-card:hover { border-color: var(--accent, #5af); }
	.preset-card.ics { grid-column: 1 / -1; border-style: dashed; }
	.preset-title { font-weight: 600; }
	.preset-meta { display: flex; gap: 0.5rem; font-size: 0.75rem; color: var(--text-muted, #888); }

	.field { display: flex; flex-direction: column; gap: 0.25rem; }
	.field span { font-size: 0.85rem; color: var(--text-muted, #888); }
	.field input { padding: 0.5rem; border-radius: 0.25rem; border: 1px solid var(--border, rgba(255,255,255,0.1)); background: var(--input-bg, rgba(0,0,0,0.2)); color: inherit; }
	.checkbox-field { display: flex; gap: 0.5rem; align-items: center; }
	.help-text { font-size: 0.85rem; color: var(--text-muted, #888); margin: 0; }
	.help-text a { color: var(--accent, #5af); }

	.test-result { padding: 0.5rem; border-radius: 0.25rem; font-size: 0.9rem; }
	.test-result.ok { background: rgba(80, 200, 120, 0.15); color: #5c5; }
	.test-result.fail { background: rgba(229, 85, 85, 0.15); color: var(--danger, #e55); }
	.test-result .code { opacity: 0.7; margin-left: 0.5rem; }
</style>
