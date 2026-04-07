<script lang="ts">
	import {
		loadPreview,
		initFromParams,
		goToPlan,
		goBack,
		setTarget,
		getCheckoutUrl,
		startProvisioningPoll,
		startMigration,
		cancelMigration,
		reset,
		getStep,
		getPreview,
		getLoading,
		getError,
		getProgress,
		getVerification,
		getTargetUrl,
		getMigrationToken,
		getProvisioningElapsed,
	} from '../stores/migration.svelte.js';
	import { t } from '../i18n.svelte.js';

	const step = $derived(getStep());
	const preview = $derived(getPreview());
	const loading = $derived(getLoading());
	const error = $derived(getError());
	const progress = $derived(getProgress());
	const verification = $derived(getVerification());
	const targetUrl = $derived(getTargetUrl());
	const provisioningElapsed = $derived(getProvisioningElapsed());

	let manualUrl = $state('');
	let manualToken = $state('');
	let showManualEntry = $state(false);

	const canStartManual = $derived(
		manualUrl.trim().length > 0 && /^[a-f0-9]{64}$/.test(manualToken.trim()),
	);

	const totalDataItems = $derived(
		(preview?.secrets ?? 0) +
		(preview?.databases.length ?? 0) +
		(preview?.artifacts ?? 0) +
		(preview?.hasConfig ? 1 : 0),
	);

	const allSteps: MigrationStepDef[] = [
		{ key: 'preview', idx: 0 },
		{ key: 'plan', idx: 1 },
		{ key: 'provisioning', idx: 2 },
		{ key: 'transferring', idx: 3 },
		{ key: 'done', idx: 4 },
	];

	interface MigrationStepDef {
		key: string;
		idx: number;
	}

	const currentStepIdx = $derived(
		allSteps.find(s => s.key === step)?.idx ?? 0,
	);

	$effect(() => {
		loadPreview();

		// Check URL parameters (checkout return flow)
		if (typeof window !== 'undefined') {
			const params = new URLSearchParams(window.location.search);
			if (initFromParams(params)) {
				// Clean URL without reloading (remove sensitive token from address bar)
				const cleanUrl = window.location.pathname;
				window.history.replaceState({}, '', cleanUrl);
				// Instance may still be provisioning — start polling
				startProvisioningPoll();
			}
		}
	});

	function handleManualStart() {
		if (!canStartManual) return;
		setTarget(manualUrl, manualToken);
		startMigration();
	}

	function handleCheckout(plan: 'starter' | 'eu') {
		window.open(getCheckoutUrl(plan), '_blank');
	}

	function progressPercent(): number {
		if (!progress?.total || !progress?.current) return 0;
		return Math.round((progress.current / progress.total) * 100);
	}

	function phaseLabel(phase: string): string {
		switch (phase) {
			case 'preview': return t('migration.starting');
			case 'handshake':
			case 'handshake_done': return t('migration.handshake');
			case 'collecting':
			case 'encrypting':
			case 'exporting': return t('migration.encrypting');
			case 'transferring': return t('migration.transferring');
			case 'restoring': return t('migration.restoring');
			default: return progress?.message ?? '';
		}
	}

	function formatElapsed(s: number): string {
		const min = Math.floor(s / 60);
		const sec = s % 60;
		return min > 0 ? `${String(min)}:${String(sec).padStart(2, '0')}` : `${String(sec)}s`;
	}
</script>

<div class="mx-auto max-w-xl space-y-6 px-4 py-8">
	<!-- Header -->
	<div>
		<h1 class="text-lg font-medium text-text">{t('migration.title')}</h1>
		<p class="mt-1 text-sm text-text-muted">{t('migration.subtitle')}</p>
	</div>

	<!-- ═══════ Step 1: Preview ═══════ -->
	{#if step === 'preview'}
		<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle">
			<div class="border-b border-border px-4 py-3">
				<h2 class="text-sm font-medium text-text">{t('migration.preview_title')}</h2>
			</div>

			{#if loading}
				<div class="px-4 py-8 text-center">
					<div class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent"></div>
				</div>
			{:else if preview && totalDataItems > 0}
				<div class="divide-y divide-border">
					{#if preview.databases.length > 0}
						<div class="flex items-center justify-between px-4 py-3">
							<span class="text-sm text-text">{t('migration.databases')}</span>
							<span class="rounded bg-accent/10 px-2 py-0.5 text-xs font-mono text-accent-text">{preview.databases.length}</span>
						</div>
					{/if}
					{#if preview.secrets > 0}
						<div class="flex items-center justify-between px-4 py-3">
							<span class="text-sm text-text">{t('migration.secrets')}</span>
							<span class="rounded bg-accent/10 px-2 py-0.5 text-xs font-mono text-accent-text">{preview.secrets}</span>
						</div>
					{/if}
					{#if preview.artifacts > 0}
						<div class="flex items-center justify-between px-4 py-3">
							<span class="text-sm text-text">{t('migration.artifacts')}</span>
							<span class="rounded bg-accent/10 px-2 py-0.5 text-xs font-mono text-accent-text">{preview.artifacts}</span>
						</div>
					{/if}
					{#if preview.hasConfig}
						<div class="flex items-center justify-between px-4 py-3">
							<span class="text-sm text-text">{t('migration.config')}</span>
							<span class="rounded bg-success/10 px-2 py-0.5 text-[10px] font-mono uppercase text-success">&#x2713;</span>
						</div>
					{/if}
				</div>
			{:else if preview}
				<div class="px-4 py-6 text-center text-sm text-text-muted">{t('migration.no_data')}</div>
			{/if}

			{#if error}
				<div class="border-t border-danger/20 bg-danger/5 px-4 py-3 text-sm text-danger">{error}</div>
			{/if}

			<div class="border-t border-border px-4 py-3 flex justify-end">
				<button
					class="rounded-[var(--radius-sm)] border border-accent/50 bg-accent/15 px-4 py-1.5 text-xs text-accent-text hover:bg-accent/25 disabled:opacity-30 transition-all"
					disabled={!preview || totalDataItems === 0}
					onclick={goToPlan}
				>{t('migration.next')}</button>
			</div>
		</div>

		<div class="rounded-[var(--radius-md)] border border-success/20 bg-success/5 px-4 py-3">
			<p class="text-xs text-success/80">{t('migration.security_note')}</p>
		</div>
	{/if}

	<!-- ═══════ Step 2: Plan Selection ═══════ -->
	{#if step === 'plan'}
		<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle">
			<div class="border-b border-border px-4 py-3">
				<h2 class="text-sm font-medium text-text">{t('migration.plan_title')}</h2>
				<p class="mt-1 text-xs text-text-muted">{t('migration.plan_desc')}</p>
			</div>

			<!-- Plan Cards -->
			<div class="grid grid-cols-2 gap-3 px-4 py-4">
				<!-- Starter -->
				<button
					class="group rounded-[var(--radius-md)] border border-border bg-bg p-4 text-left hover:border-accent/50 transition-all"
					onclick={() => handleCheckout('starter')}
				>
					<div class="text-sm font-medium text-text">{t('migration.plan_starter')}</div>
					<div class="mt-1 text-xs text-text-muted">{t('migration.plan_starter_desc')}</div>
					<div class="mt-3 text-lg font-medium text-accent-text">{t('migration.plan_starter_price')}</div>
					<div class="mt-3 rounded-[var(--radius-sm)] border border-accent/30 bg-accent/10 px-3 py-1.5 text-center text-xs text-accent-text group-hover:bg-accent/20 transition-colors">
						{t('migration.plan_select')}
					</div>
				</button>

				<!-- EU Managed -->
				<button
					class="group rounded-[var(--radius-md)] border border-accent/30 bg-accent/5 p-4 text-left hover:border-accent/60 transition-all"
					onclick={() => handleCheckout('eu')}
				>
					<div class="text-sm font-medium text-text">{t('migration.plan_eu')}</div>
					<div class="mt-1 text-xs text-text-muted">{t('migration.plan_eu_desc')}</div>
					<div class="mt-3 text-lg font-medium text-accent-text">{t('migration.plan_eu_price')}</div>
					<div class="mt-3 rounded-[var(--radius-sm)] border border-accent/50 bg-accent/15 px-3 py-1.5 text-center text-xs text-accent-text group-hover:bg-accent/25 transition-colors">
						{t('migration.plan_select')}
					</div>
				</button>
			</div>

			<!-- Manual Entry Toggle -->
			<div class="border-t border-border">
				<button
					class="w-full px-4 py-3 text-center text-xs text-text-muted hover:text-text transition-colors"
					onclick={() => (showManualEntry = !showManualEntry)}
				>
					{t('migration.have_instance')} {showManualEntry ? '▴' : '▾'}
				</button>

				{#if showManualEntry}
					<form class="border-t border-border/50 px-4 py-4 space-y-3" onsubmit={(e) => { e.preventDefault(); handleManualStart(); }}>
						<p class="text-xs text-text-subtle">{t('migration.manual_desc')}</p>
						<div>
							<label for="target-url" class="mb-1 block text-xs font-medium text-text-muted">{t('migration.target_url')}</label>
							<input
								id="target-url"
								type="url"
								bind:value={manualUrl}
								placeholder={t('migration.target_url_placeholder')}
								autocomplete="url"
								class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2.5 text-sm text-text font-mono placeholder:text-text-subtle focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent"
							/>
						</div>
						<div>
							<label for="migration-token" class="mb-1 block text-xs font-medium text-text-muted">{t('migration.token')}</label>
							<input
								id="migration-token"
								type="password"
								bind:value={manualToken}
								placeholder={t('migration.token_placeholder')}
								autocomplete="off"
								class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2.5 text-sm text-text font-mono placeholder:text-text-subtle focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent"
							/>
						</div>
						<div class="flex justify-end">
							<button
								type="submit"
								class="rounded-[var(--radius-sm)] border border-accent/50 bg-accent/15 px-4 py-1.5 text-xs text-accent-text hover:bg-accent/25 disabled:opacity-30 transition-all"
								disabled={!canStartManual}
							>{t('migration.start')}</button>
						</div>
					</form>
				{/if}
			</div>

			{#if error}
				<div class="border-t border-danger/20 bg-danger/5 px-4 py-3 text-sm text-danger">{error}</div>
			{/if}

			<div class="border-t border-border px-4 py-3">
				<button
					class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1.5 text-xs text-text-muted hover:text-text transition-colors"
					onclick={goBack}
				>{t('migration.back')}</button>
			</div>
		</div>
	{/if}

	<!-- ═══════ Step 3: Provisioning Wait ═══════ -->
	{#if step === 'provisioning'}
		<div class="rounded-[var(--radius-md)] border border-accent/30 bg-accent/5">
			<div class="border-b border-accent/20 px-4 py-3">
				<h2 class="text-sm font-medium text-text">{t('migration.provisioning_title')}</h2>
				<p class="mt-1 text-xs text-text-muted">{t('migration.provisioning_desc')}</p>
			</div>

			<div class="space-y-4 px-4 py-6">
				<!-- Spinner + elapsed -->
				<div class="flex flex-col items-center gap-3">
					<div class="h-8 w-8 animate-spin rounded-full border-2 border-accent border-t-transparent"></div>
					<div class="text-sm text-text-muted">
						{t('migration.provisioning_elapsed')}: <span class="font-mono text-accent-text">{formatElapsed(provisioningElapsed)}</span>
					</div>
				</div>

				<!-- Progress steps -->
				<div class="space-y-2 rounded-[var(--radius-md)] bg-bg/50 px-4 py-3">
					<div class="flex items-center gap-2 text-xs">
						<span class="text-success">&#x2713;</span>
						<span class="text-text-muted">Checkout abgeschlossen</span>
					</div>
					<div class="flex items-center gap-2 text-xs">
						{#if provisioningElapsed > 30}
							<span class="text-success">&#x2713;</span>
						{:else}
							<span class="inline-block h-3 w-3 animate-spin rounded-full border border-accent border-t-transparent"></span>
						{/if}
						<span class="text-text-muted">Server wird erstellt</span>
					</div>
					<div class="flex items-center gap-2 text-xs">
						{#if provisioningElapsed > 90}
							<span class="text-success">&#x2713;</span>
						{:else if provisioningElapsed > 30}
							<span class="inline-block h-3 w-3 animate-spin rounded-full border border-accent border-t-transparent"></span>
						{:else}
							<span class="text-text-subtle">&#x25CB;</span>
						{/if}
						<span class="text-text-muted">DNS + HTTPS konfigurieren</span>
					</div>
					<div class="flex items-center gap-2 text-xs">
						{#if provisioningElapsed > 120}
							<span class="inline-block h-3 w-3 animate-spin rounded-full border border-accent border-t-transparent"></span>
						{:else}
							<span class="text-text-subtle">&#x25CB;</span>
						{/if}
						<span class="text-text-muted">Engine starten</span>
					</div>
				</div>

				<div class="text-center">
					<button
						class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1.5 text-xs text-text-muted hover:text-text transition-colors"
						onclick={cancelMigration}
					>{t('migration.cancel')}</button>
				</div>
			</div>
		</div>
	{/if}

	<!-- ═══════ Step 4: Transferring ═══════ -->
	{#if step === 'transferring'}
		<div class="rounded-[var(--radius-md)] border border-accent/30 bg-accent/5">
			<div class="border-b border-accent/20 px-4 py-3">
				<h2 class="text-sm font-medium text-text">{t('migration.transferring')}</h2>
			</div>

			<div class="space-y-4 px-4 py-6">
				{#if progress}
					<div class="space-y-2">
						<div class="flex items-center justify-between text-xs">
							<span class="text-text-muted">{phaseLabel(progress.phase)}</span>
							{#if progress.total && progress.current}
								<span class="font-mono text-accent-text">{progress.current}/{progress.total}</span>
							{/if}
						</div>
						<div class="h-1.5 w-full overflow-hidden rounded-full bg-border">
							{#if progress.total && progress.current}
								<div class="h-full rounded-full bg-accent transition-all duration-300" style="width: {progressPercent()}%"></div>
							{:else}
								<div class="h-full w-1/3 animate-pulse rounded-full bg-accent/50"></div>
							{/if}
						</div>
						<p class="text-xs text-text-subtle">{progress.message}</p>
					</div>
				{/if}

				<div class="text-center">
					<button
						class="rounded-[var(--radius-sm)] border border-danger/30 bg-danger/10 px-3 py-1.5 text-xs text-danger hover:bg-danger/20 transition-colors"
						onclick={cancelMigration}
					>{t('migration.cancel')}</button>
				</div>
			</div>
		</div>
	{/if}

	<!-- ═══════ Step 5: Done ═══════ -->
	{#if step === 'done' && verification}
		<div class="rounded-[var(--radius-md)] border border-success/30 bg-success/5">
			<div class="border-b border-success/20 px-4 py-3">
				<h2 class="text-sm font-medium text-success">{t('migration.success')}</h2>
				<p class="mt-1 text-xs text-text-muted">{t('migration.success_desc')}</p>
			</div>

			<div class="divide-y divide-success/10">
				{#if verification.databasesRestored.length > 0}
					<div class="flex items-center justify-between px-4 py-3">
						<span class="text-sm text-text">{t('migration.databases')}</span>
						<span class="rounded bg-success/15 px-2 py-0.5 text-xs font-mono text-success">{verification.databasesRestored.length}</span>
					</div>
				{/if}
				{#if verification.secretsImported > 0}
					<div class="flex items-center justify-between px-4 py-3">
						<span class="text-sm text-text">{t('migration.secrets')}</span>
						<span class="rounded bg-success/15 px-2 py-0.5 text-xs font-mono text-success">{verification.secretsImported}</span>
					</div>
				{/if}
				{#if verification.artifactsImported > 0}
					<div class="flex items-center justify-between px-4 py-3">
						<span class="text-sm text-text">{t('migration.artifacts')}</span>
						<span class="rounded bg-success/15 px-2 py-0.5 text-xs font-mono text-success">{verification.artifactsImported}</span>
					</div>
				{/if}
			</div>

			<div class="border-t border-success/20 px-4 py-3 flex justify-center">
				<a
					href={targetUrl}
					target="_blank"
					rel="noopener noreferrer"
					class="rounded-[var(--radius-sm)] border border-success/50 bg-success/15 px-4 py-1.5 text-xs text-success hover:bg-success/25 transition-all"
				>{t('migration.open_instance')} &rarr;</a>
			</div>
		</div>
	{/if}

	<!-- ═══════ Error State ═══════ -->
	{#if step === 'error'}
		<div class="rounded-[var(--radius-md)] border border-danger/30 bg-danger/5">
			<div class="px-4 py-6 text-center space-y-3">
				<p class="text-sm text-danger">{error}</p>
				<div class="flex items-center justify-center gap-3">
					<button
						class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1.5 text-xs text-text-muted hover:text-text transition-colors"
						onclick={reset}
					>{t('migration.back')}</button>
					<button
						class="rounded-[var(--radius-sm)] border border-accent/50 bg-accent/15 px-3 py-1.5 text-xs text-accent-text hover:bg-accent/25 transition-all"
						onclick={startMigration}
					>{t('migration.retry')}</button>
				</div>
			</div>
		</div>
	{/if}

	<!-- Step indicators -->
	<div class="flex items-center justify-center gap-2">
		{#each allSteps as s}
			<div
				class="h-1.5 rounded-full transition-all duration-300 {
					s.idx === currentStepIdx ? 'w-6 bg-accent' :
					s.idx < currentStepIdx ? 'w-1.5 bg-accent/50' :
					'w-1.5 bg-border'
				}"
			></div>
		{/each}
	</div>
</div>
