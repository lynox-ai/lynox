<script lang="ts">
	import {
		loadPreview,
		goToPlan,
		goBack,
		setTarget,
		startMigration,
		cancelMigration,
		reset,
		backToInputs,
		getStep,
		getPreview,
		getLoading,
		getError,
		getProgress,
		getVerification,
		getDoneWorkspace,
		getDoneSkipped,
		getTargetUrl,
		getRetry,
		getErrorAt,
		getErrorStep,
		getErrorCode,
		getErrorParams,
		getErrorReason,
		getErrorNotStarted,
		MIGRATION_HOLD_MS,
	} from '../stores/migration.svelte.js';
	import { t, tf, getLocale } from '../i18n.svelte.js';
	import { migrationWorkspaceNotice, skippedNextKey, visibleSkippedPath } from '../backup-coverage.js';
	import { migrationErrorView } from '../migration-error-text.js';

	const step = $derived(getStep());
	const preview = $derived(getPreview());
	const loading = $derived(getLoading());
	const error = $derived(getError());
	const progress = $derived(getProgress());
	const verification = $derived(getVerification());
	const workspaceNotice = $derived(migrationWorkspaceNotice({ workspace: getDoneWorkspace() }));
	// Files the export could not carry (row 1033, ux U-056): the count, the paths on request, and
	// the same next step as for a workspace left out. At most this many paths are listed.
	const SKIPPED_SHOWN = 50;
	const skipped = $derived(getDoneSkipped());
	const skippedNext = $derived(skippedNextKey(skipped.length));
	const targetUrl = $derived(getTargetUrl());
	const retry = $derived(getRetry());
	// The error's sentence in the UI's language, from its code, with the values set apart in boxes.
	const errorView = $derived(migrationErrorView(getErrorCode(), getErrorParams(), getErrorReason()));
	const errorNotStarted = $derived(getErrorNotStarted());
	// With `later` the target may hold its session for 30 minutes from the error; the retry opens then,
	// without a reload.
	const retryFrom = $derived(getErrorAt() + MIGRATION_HOLD_MS);
	let now = $state(Date.now());
	$effect(() => {
		if (step !== 'error' || retry !== 'later') return;
		now = Date.now();
		// run-group-starter: a per-page clock for one error card; cleared with it.
		const id = setInterval(() => { now = Date.now(); }, 15_000);
		return () => clearInterval(id);
	});
	const held = $derived(step === 'error' && retry === 'later' && now < retryFrom);
	const retryFromText = $derived(new Date(retryFrom).toLocaleTimeString(getLocale() === 'de' ? 'de-CH' : 'en-GB', { hour: '2-digit', minute: '2-digit' }));

	let manualUrl = $state('');
	let manualToken = $state('');

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
		{ key: 'transferring', idx: 2 },
		{ key: 'done', idx: 3 },
	];

	interface MigrationStepDef {
		key: string;
		idx: number;
	}

	// After an error the marks stay at the step it came from.
	const currentStepIdx = $derived(
		allSteps.find(s => s.key === (step === 'error' ? getErrorStep() : step))?.idx ?? 0,
	);

	$effect(() => {
		void loadPreview(); /* the migration store catches and sets its error */
	});

	function handleManualStart() {
		if (!canStartManual) return;
		setTarget(manualUrl, manualToken);
		void startMigration(); /* the migration store catches and sets its error */
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
				<div role="alert" class="border-t border-danger/20 bg-danger/5 px-4 py-3 text-sm text-danger">{error}</div>
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

	<!-- ═══════ Step 2: Target instance ═══════ -->
	{#if step === 'plan'}
		<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle">
			<div class="border-b border-border px-4 py-3">
				<h2 id="migration-target-title" class="text-sm font-medium text-text">{t('migration.target_title')}</h2>
				<p class="mt-1 text-xs text-text-muted">{t('migration.plan_desc')}</p>
			</div>

			<form class="px-4 py-4 space-y-3" aria-labelledby="migration-target-title" onsubmit={(e) => { e.preventDefault(); handleManualStart(); }}>
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

			{#if error}
				<div role="alert" class="border-t border-danger/20 bg-danger/5 px-4 py-3 text-sm text-danger">{error}</div>
			{/if}

			<div class="border-t border-border px-4 py-3">
				<button
					class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1.5 text-xs text-text-muted hover:text-text transition-colors"
					onclick={goBack}
				>{t('migration.back')}</button>
			</div>
		</div>
	{/if}

	<!-- ═══════ Step 3: Transferring ═══════ -->
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
						{#if progress.phase === 'collecting' || progress.phase === 'encrypting'}
							<!-- The item being packed (a database's name). The route's own phase sentences are English and say what the label above already says. -->
							<p class="text-xs text-text-subtle">{progress.message}</p>
						{/if}
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

	<!-- ═══════ Step 4: Done ═══════ -->
	{#if step === 'done' && verification}
		<div class="rounded-[var(--radius-md)] border border-success/30 bg-success/5">
			<div class="border-b border-success/20 px-4 py-3">
				<h2 class="text-sm font-medium text-success">{t('migration.success')}</h2>
				<p class="mt-1 text-xs text-text-muted">{t(workspaceNotice?.description ?? (skipped.length === 0 ? 'migration.success_desc' : skipped.length === 1 ? 'migration.success_desc_skipped_one' : 'migration.success_desc_skipped_many'))}</p>
				{#if workspaceNotice}
					<p data-testid="migration-workspace-omitted" class="mt-1 text-xs text-warning">{t(workspaceNotice.line)}</p>
				{/if}
				{#if skipped.length > 0}
					<details data-testid="migration-skipped" class="mt-1 text-xs text-warning">
						<summary class="cursor-pointer">{skipped.length === 1 ? t('migration.skipped_one') : tf('migration.skipped_many', { n: String(skipped.length) })}</summary>
						<ul class="mt-1 space-y-0.5 break-all font-mono text-text-muted">
							{#each skipped.slice(0, SKIPPED_SHOWN) as path, i (i)}<li>{visibleSkippedPath(path)}</li>{/each}
						</ul>
						{#if skipped.length > SKIPPED_SHOWN}
							<p class="mt-1 text-text-muted">{tf('migration.skipped_more', { m: String(skipped.length - SKIPPED_SHOWN) })}</p>
						{/if}
					</details>
					{#if !workspaceNotice}
						<p data-testid="migration-skipped-next" class="mt-1 text-xs text-warning">{t(skippedNext)}</p>
					{/if}
				{/if}
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
				{#if verification.memoryFilesImported > 0}
					<div class="flex items-center justify-between px-4 py-3">
						<span class="text-sm text-text">{t('migration.memory')}</span>
						<span class="rounded bg-success/15 px-2 py-0.5 text-xs font-mono text-success">{verification.memoryFilesImported}</span>
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
				<p data-testid="migration-error-title" class="text-sm font-medium text-danger">{t(errorNotStarted ? 'migration.error_title_not_started' : 'migration.error_title')}</p>
				<!-- lynox's own sentence in the UI's language. A value in it (a variable name, a path, a folder)
				     is set apart in its own isolated element, as text, never as markup. -->
				<p data-testid="migration-error-detail" class="break-words text-xs text-text-muted">{#each errorView.segments as segment, i (i)}{#if 'value' in segment}<bdi data-foreign-value class="rounded-[var(--radius-sm)] border border-text-subtle bg-bg-muted px-1 box-decoration-clone font-mono">{segment.value}</bdi>{:else}{segment.text}{/if}{/each}</p>
				{#if errorView.box}
					<!-- Someone else's words (the target's, or this instance's error text): unchanged, in their own
					     isolated element with a border, as a value rather than a sentence. They are English. -->
					<p data-testid="migration-error-reason" class="break-words text-xs text-text-muted">{errorView.box.label} <bdi data-foreign-value lang="en" class="rounded-[var(--radius-sm)] border border-text-subtle bg-bg-muted px-1 box-decoration-clone font-mono">{errorView.box.value}</bdi></p>
				{/if}
				{#if retry === 'check'}
					<p data-testid="migration-check-target" class="text-xs text-warning">{t('migration.check_target_first')}</p>
				{:else if held}
					<p data-testid="migration-retry-from" class="text-xs text-text-muted">{tf('migration.retry_from', { time: retryFromText })}</p>
				{/if}
				<div class="flex items-center justify-center gap-3">
					<!-- Where a retry would change nothing, back leads to the inputs, as they were. -->
					<button
						data-testid="migration-back"
						class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1.5 text-xs text-text-muted hover:text-text transition-colors"
						onclick={retry === 'none' ? backToInputs : reset}
					>{t('migration.back')}</button>
					{#if retry !== 'check' && retry !== 'none'}
						<button
							data-testid="migration-retry"
							class="rounded-[var(--radius-sm)] border border-accent/50 bg-accent/15 px-3 py-1.5 text-xs text-accent-text hover:bg-accent/25 disabled:opacity-30 transition-all"
							disabled={held}
							onclick={startMigration}
						>{t('migration.retry')}</button>
					{/if}
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
