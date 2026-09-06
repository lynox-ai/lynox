<script lang="ts">
	// === Google Workspace channel card ===
	//
	// Extracted from IntegrationsView.svelte during PRD-IA-V2 P3-PR-A2
	// channel route split. State lives in stores/integrations/google.svelte.ts
	// (shipped in P3-PR-A1); this component just renders the card and owns
	// the OAuth-claim side-effect (only fires on this route now).

	import { onDestroy } from 'svelte';
	import { t } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';
	import { isManaged, loadManagedStatus } from '../stores/integrations/managed.svelte.js';
	import {
		getGoogleStatus,
		isGoogleLoading,
		getDeviceFlow,
		isConnecting,
		isRevoking,
		getGoogleClientId,
		setGoogleClientId,
		getGoogleClientSecret,
		setGoogleClientSecret,
		isGoogleCredSaving,
		isGoogleCredSaved,
		getScopeMode,
		setScopeMode,
		isManagedGoogleClaiming,
		isSwitchingToManaged,
		isScopeMismatch,
		getServerScopeMode,
		grantedServices,
		loadGoogleStatus,
		saveGoogleCredentials,
		startGoogleAuth,
		startManagedGoogleOAuth,
		switchToManagedGoogle,
		revokeGoogle,
		resetGoogleCredentials,
		claimManagedGoogleTokens,
		stopAuthPoll,
	} from '../stores/integrations/google.svelte.js';

	/**
	 * A brokered tenant: the engine resolved no client pair of its own on a
	 * provisioned instance. Computed server-side — the browser can see neither
	 * the control-plane marker nor the vault.
	 */
	const isBroker = $derived(getGoogleStatus()?.managed_broker === true);
	/** The control plane holds a Google client. NOT "consent will succeed". */
	const brokerAvailable = $derived(getGoogleStatus()?.broker_available === true);
	/** A managed tenant that brought its OWN client — the D12 switch-back case. */
	const canSwitchToManaged = $derived(
		brokerAvailable && !isBroker && getGoogleStatus()?.client_source != null,
	);

	/** The destructive switch-back is parked here until the user confirms it. */
	let switchConfirmOpen = $state(false);

	async function confirmSwitchToManaged(): Promise<void> {
		switchConfirmOpen = false;
		if (await switchToManagedGoogle()) await startManagedGoogleOAuth();
	}

	/**
	 * Drive is granted, but only for the files lynox itself creates.
	 * `drive.file` is a WRITE scope that reaches nothing else, so a card that
	 * says "Drive" without this reads as access to the whole Drive.
	 */
	const driveIsAppFilesOnly = $derived.by(() => {
		const scopes = getGoogleStatus()?.scopes ?? [];
		return scopes.includes('https://www.googleapis.com/auth/drive.file')
			&& !scopes.includes('https://www.googleapis.com/auth/drive')
			&& !scopes.includes('https://www.googleapis.com/auth/drive.readonly');
	});

	let showAdvancedCredentials = $state(false);

	async function copyText(text: string) {
		await navigator.clipboard.writeText(text);
		addToast(t('common.copied'), 'success', 1500);
	}

	let oauthClaimHandled = $state(false);
	/** A claim waiting for the user to confirm it — see the effect below for why. */
	let pendingClaimNonce = $state<string | null>(null);

	function confirmPendingClaim(): void {
		const nonce = pendingClaimNonce;
		pendingClaimNonce = null;
		if (nonce) void claimManagedGoogleTokens(nonce);
	}

	$effect(() => {
		void loadManagedStatus();
		void loadGoogleStatus();

		// A pending Google claim is PARKED here, not executed. The user confirms it.
		//
		// `/oauth/google/start` takes an `instance_id` and no auth, and the signed state binds
		// only that id — nothing about the browser. So anyone who knows a tenant's instance id
		// can run the consent themselves with THEIR Google account and hand the resulting
		// link to the tenant. Claiming is authenticated, so it takes the tenant's own logged-in
		// browser to finish — which auto-claiming supplied for free: opening the link was the
		// whole attack, with no dialog, no gesture, and nothing on screen naming the account.
		// The engine cannot name it BEFORE the claim either (`getAccountInfo` reads a connection that
		// does not exist yet, and even after it returns scopes and expiry, no
		// identity), so a confirmation the user has to press is the only barrier available
		// tonight. Binding the state to the browser is the real fix; it is tracked, not promised here.
		if (!oauthClaimHandled && typeof window !== 'undefined') {
			const params = new URLSearchParams(window.location.search);
			const claimNonce = params.get('google_oauth');
			if (claimNonce && claimNonce !== 'success') {
				oauthClaimHandled = true;
				// Clean URL param without reload
				const url = new URL(window.location.href);
				url.searchParams.delete('google_oauth');
				window.history.replaceState({}, '', url.toString());
				pendingClaimNonce = claimNonce;
			}
		}
	});

	onDestroy(() => {
		stopAuthPoll();
	});
</script>

<div class="p-6 max-w-4xl mx-auto space-y-4">
	<a href="/app/settings/channels" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('settings.channels.back')}</a>
	<h1 class="text-xl font-light tracking-tight mb-6 mt-2">{t('settings.channels.google')}</h1>

	{#if pendingClaimNonce}
		<!-- Deliberately a decision, not a notice. The wording says what cannot be shown —
		     which account — because that absence is the reason the confirmation exists. -->
		<div class="rounded-[var(--radius-md)] border border-warning/20 bg-warning/10 p-5 space-y-3 text-warning">
			<p class="text-sm">{t('settings.google.claim_confirm')}</p>
			<p class="text-xs text-text-subtle">{t('settings.google.claim_confirm_hint')}</p>
			<div class="flex gap-2">
				<button class="btn-primary text-sm" onclick={confirmPendingClaim}>
					{t('settings.google.claim_confirm_yes')}
				</button>
				<button class="btn-ghost text-sm" onclick={() => { pendingClaimNonce = null; }}>
					{t('settings.google.claim_confirm_no')}
				</button>
			</div>
		</div>
	{/if}

	<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-5">
		<div class="flex items-center justify-between mb-4">
			<div>
				<h2 class="font-medium">{t('integrations.google_workspace')}</h2>
				<p class="text-xs text-text-muted mt-1">{t('integrations.google_services')}</p>
			</div>
			{#if isGoogleLoading()}
				<span class="text-xs text-text-subtle">{t('common.loading')}</span>
			{:else if getGoogleStatus()?.authenticated}
				<span class="text-xs text-success">{t('integrations.connected')}</span>
			{:else if getGoogleStatus()?.available}
				<span class="text-xs text-text-subtle">{t('integrations.not_connected')}</span>
			{:else}
				<span class="text-xs text-text-subtle">{t('integrations.not_configured')}</span>
			{/if}
		</div>

		{#if isGoogleLoading()}
			<!-- loading -->
		{:else if isManagedGoogleClaiming() || isSwitchingToManaged()}
			<div class="flex items-center gap-2 text-sm text-text-muted">
				<span class="inline-block h-4 w-4 border-2 border-accent border-t-transparent rounded-full animate-spin"></span>
				{t('integrations.connecting')}
			</div>
		{:else if isBroker && !getGoogleStatus()?.authenticated}
			<!-- Brokered tenant, no grant yet. ONE button; no scope toggle, because
			     the consent set is lynox's and the tenant cannot widen it here. -->
			<div class="space-y-3">
				{#if brokerAvailable}
					<p class="text-sm text-text-muted">{t('integrations.google_broker_desc')}</p>
					<button
						onclick={startManagedGoogleOAuth}
						disabled={isConnecting()}
						class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm text-accent-fg hover:opacity-90 disabled:opacity-50"
					>
						{t('integrations.google_broker_connect')}
					</button>
				{:else}
					<p class="text-sm text-text-muted">{t('integrations.google_broker_unavailable')}</p>
				{/if}
				<button
					onclick={() => { showAdvancedCredentials = !showAdvancedCredentials; }}
					class="block text-xs text-text-subtle hover:text-text-muted transition-colors"
				>
					{t('integrations.google_advanced')}
				</button>
				{#if showAdvancedCredentials}
					<div class="space-y-2 border-l border-border pl-3">
						<input
							value={getGoogleClientId()}
							oninput={(e) => setGoogleClientId((e.currentTarget as HTMLInputElement).value)}
							type="password"
							placeholder="Client ID"
							class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm font-mono outline-none focus:border-border-hover"
						/>
						<input
							value={getGoogleClientSecret()}
							oninput={(e) => setGoogleClientSecret((e.currentTarget as HTMLInputElement).value)}
							type="password"
							placeholder="Client Secret"
							class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm font-mono outline-none focus:border-border-hover"
						/>
						<button
							onclick={saveGoogleCredentials}
							disabled={!getGoogleClientId().trim() || !getGoogleClientSecret().trim() || isGoogleCredSaving()}
							class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm text-accent-fg hover:opacity-90 disabled:opacity-50"
						>
							{isGoogleCredSaving() ? t('settings.saving') : t('integrations.save_credentials')}
						</button>
					</div>
				{/if}
			</div>
		{:else if !getGoogleStatus()?.available}
			<!-- Manual credential setup (managed: Web app + redirect URI, self-hosted: Desktop app) -->
			<div class="space-y-3">
				{#if isGoogleCredSaved()}
					<p class="text-sm text-success">{t('integrations.credentials_saved')}</p>
				{:else}
					<p class="text-xs text-text-muted mb-3">
						{isManaged() ? t('integrations.google_setup_guide_suffix_managed') : t('integrations.google_setup_guide_suffix')}:
					</p>
					<a
						href="https://docs.lynox.ai/integrations/google-workspace/#setup"
						target="_blank"
						rel="noopener noreferrer"
						class="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border border-border bg-bg px-3 py-1.5 text-xs font-medium text-accent-text hover:border-border-hover hover:bg-bg-hover transition-colors mb-4"
					>
						{t('integrations.google_setup_guide')}
						<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
					</a>
					{#if isManaged()}
						<div class="mb-3">
							<p class="text-xs text-text-muted mb-1">{t('integrations.google_redirect_uri_label')}</p>
							<button onclick={() => copyText(`${window.location.origin}/api/google/callback`)} class="w-full text-left rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-xs font-mono text-text-muted hover:border-border-hover cursor-pointer" title={t('common.copy')}>
								{window.location.origin}/api/google/callback
							</button>
						</div>
					{/if}
					<p class="text-xs text-text-muted mb-2">{t('integrations.google_paste_credentials')}</p>
					<div class="space-y-2">
						<input
							value={getGoogleClientId()}
							oninput={(e) => setGoogleClientId((e.currentTarget as HTMLInputElement).value)}
							type="password"
							placeholder="Client ID"
							class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm font-mono outline-none focus:border-border-hover"
						/>
						<input
							value={getGoogleClientSecret()}
							oninput={(e) => setGoogleClientSecret((e.currentTarget as HTMLInputElement).value)}
							type="password"
							placeholder="Client Secret"
							class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm font-mono outline-none focus:border-border-hover"
						/>
					</div>
					<button
						onclick={saveGoogleCredentials}
						disabled={!getGoogleClientId().trim() || !getGoogleClientSecret().trim() || isGoogleCredSaving()}
						class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm text-accent-fg hover:opacity-90 disabled:opacity-50"
					>
						{isGoogleCredSaving() ? t('settings.saving') : t('integrations.save_credentials')}
					</button>
				{/if}
			</div>
		{:else if getGoogleStatus()?.authenticated}
			<!-- Connected -->
			<div class="space-y-3">
				<!-- Scope mode toggle. A brokered connection has none: the consent set
				     belongs to lynox's client and the tenant cannot widen it here, so a
				     toggle would offer a change nothing can carry out. -->
				{#if !isBroker}
					<div>
						<p class="text-xs font-mono uppercase tracking-widest text-text-subtle mb-1.5">{t('integrations.access_level')}</p>
						<div class="inline-flex rounded-[var(--radius-md)] border border-border overflow-hidden">
							<button
								onclick={() => setScopeMode('standard')}
								class="px-3 py-1.5 text-xs transition-colors {getScopeMode() === 'standard' ? 'bg-accent text-accent-fg' : 'bg-bg text-accent-fg-muted hover:bg-bg-hover'}"
							>{t('integrations.scope_standard')}</button>
							<button
								onclick={() => setScopeMode('full')}
								class="px-3 py-1.5 text-xs transition-colors {getScopeMode() === 'full' ? 'bg-accent text-accent-fg' : 'bg-bg text-accent-fg-muted hover:bg-bg-hover'}"
							>{t('integrations.scope_full')}</button>
						</div>
						{#if getScopeMode() === 'full'}
							<p class="text-xs text-text-subtle mt-1">{t('integrations.scope_full_desc')}</p>
						{/if}
						{#if getServerScopeMode() === 'legacy'}
							<!-- Stated, not flagged: a grant taken before the named sets
							     existed is not a mismatch, because nobody chose anything. -->
							<p class="text-xs text-text-subtle mt-1">{t('integrations.scope_mode_legacy')}</p>
						{/if}
					</div>
				{/if}
				{#if isScopeMismatch()}
					<button
						onclick={startGoogleAuth}
						disabled={isConnecting()}
						class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm text-accent-fg hover:opacity-90 disabled:opacity-50"
					>
						{isConnecting() ? t('integrations.connecting') : t('integrations.reconnect_google')}
					</button>
					<p class="text-xs text-warning">{t('integrations.scope_change_hint')}</p>
				{/if}
				{#if driveIsAppFilesOnly}
					<!-- The remedy for a narrow Drive grant lives on the CARD, not in the
					     tool string: it differs per tenant, and a tool string is read by
					     the model rather than by the person who can act on it. Branched on
					     BROKER MODE — a brokered connection cannot widen its grant here at
					     all, so telling it to "switch to Full" would point at a control it
					     does not render. -->
					<p class="text-xs text-text-subtle">
						{isBroker
							? t('integrations.drive_app_files_only_broker')
							: t('integrations.drive_app_files_only_byo')}
					</p>
				{/if}
				{#if getGoogleStatus()?.scopes && getGoogleStatus()!.scopes!.length > 0}
					<!-- One line per product, labelled per SCOPE. The label used to be
					     derived with `s.includes('/drive') && !s.includes('.readonly')`,
					     which `drive.file` satisfies — so a grant of "the files lynox
					     creates" was announced as full Drive read-write. -->
					<div class="flex flex-wrap gap-x-4 gap-y-1">
						{#each grantedServices(getGoogleStatus()!.scopes!) as svc}
							<span class="text-xs text-text-muted">
								<span class="text-text">{svc.name}</span> — {t(svc.labelKey)}
							</span>
						{/each}
					</div>
				{/if}
				<div class="flex flex-wrap gap-2">
					<button
						onclick={revokeGoogle}
						disabled={isRevoking()}
						class="rounded-[var(--radius-sm)] border border-danger/30 bg-danger/15 px-3 py-1.5 text-sm text-danger hover:bg-danger/25 disabled:opacity-50"
					>
						{isRevoking() ? t('integrations.disconnecting') : t('integrations.disconnect')}
					</button>
					{#if canSwitchToManaged}
						<button
							onclick={() => { switchConfirmOpen = true; }}
							class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1.5 text-sm text-text-muted hover:bg-bg-hover"
						>
							{t('integrations.google_switch_to_managed')}
						</button>
					{/if}
				</div>
				{#if switchConfirmOpen}
					<!-- The confirm IS the safety mechanism, not a courtesy: the pair is
					     deleted before anything replaces it, and neither the broker
					     consent nor a way back is guaranteed. So it names both costs
					     rather than asking "are you sure". -->
					<div class="rounded-[var(--radius-md)] border border-warning/20 bg-warning/10 p-5 space-y-3 text-warning">
						<p class="text-sm font-medium">{t('integrations.google_switch_confirm_title')}</p>
						<p class="text-xs">{t('integrations.google_switch_confirm_body')}</p>
						<p class="text-xs text-text-subtle">{t('integrations.google_grant_stays')}</p>
						<div class="flex gap-2">
							<button class="btn-primary text-sm" onclick={confirmSwitchToManaged}>
								{t('integrations.google_switch_confirm_yes')}
							</button>
							<button class="btn-ghost text-sm" onclick={() => { switchConfirmOpen = false; }}>
								{t('settings.google.claim_confirm_no')}
							</button>
						</div>
					</div>
				{/if}
			</div>
		{:else if getDeviceFlow()}
			<!-- Device flow active -->
			{@const flow = getDeviceFlow()!}
			<div class="space-y-3">
				<p class="text-sm text-text-muted">{t('integrations.device_flow_hint')}</p>
				<div class="rounded-[var(--radius-md)] border border-accent/30 bg-accent/5 p-4 text-center space-y-2">
					<a href={flow.verificationUrl} target="_blank" rel="noopener noreferrer" class="text-accent-text hover:opacity-80 text-sm break-all">
						{flow.verificationUrl}
					</a>
					<button onclick={() => copyText(flow.userCode)} class="text-2xl font-mono font-bold text-text tracking-widest hover:text-accent-text transition-colors cursor-pointer" title={t('common.copy')}>{flow.userCode}</button>
				</div>
				<p class="text-xs text-text-subtle">{t('integrations.waiting_auth')}</p>
			</div>
		{:else}
			<!-- Credentials set, not connected -->
			<div class="space-y-2">
				<div class="mb-1">
					<p class="text-xs font-mono uppercase tracking-widest text-text-subtle mb-1.5">{t('integrations.access_level')}</p>
					<div class="inline-flex rounded-[var(--radius-md)] border border-border overflow-hidden">
						<button
							onclick={() => setScopeMode('standard')}
							class="px-3 py-1.5 text-xs transition-colors {getScopeMode() === 'standard' ? 'bg-accent text-accent-fg' : 'bg-bg text-accent-fg-muted hover:bg-bg-hover'}"
						>{t('integrations.scope_standard')}</button>
						<button
							onclick={() => setScopeMode('full')}
							class="px-3 py-1.5 text-xs transition-colors {getScopeMode() === 'full' ? 'bg-accent text-accent-fg' : 'bg-bg text-accent-fg-muted hover:bg-bg-hover'}"
						>{t('integrations.scope_full')}</button>
					</div>
					{#if getScopeMode() === 'full'}
						<p class="text-xs text-text-subtle mt-1">{t('integrations.scope_full_desc')}</p>
					{/if}
				</div>
				<button
					onclick={startGoogleAuth}
					disabled={isConnecting()}
					class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm text-accent-fg hover:opacity-90 disabled:opacity-50"
				>
					{isConnecting() ? t('integrations.connecting') : t('integrations.connect_google')}
				</button>
				<p class="text-xs text-text-subtle">{isManaged() ? t('integrations.redirect_flow_preview') : t('integrations.device_flow_preview')}</p>
				<button
					onclick={resetGoogleCredentials}
					class="text-xs text-text-subtle hover:text-text-muted transition-colors"
				>
					{t('integrations.change_credentials')}
				</button>
			</div>
		{/if}
	</div>
</div>
