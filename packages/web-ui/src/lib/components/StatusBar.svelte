<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { formatCost } from '../format.js';
	import { t, getLocale } from '../i18n.svelte.js';
	import { onDestroy } from 'svelte';
	import { getContextBudget, getSessionModel, getAuthError } from '../stores/chat.svelte.js';
	import { ensureVoiceInfoProbed, isTtsAvailable, getSttProvider } from '../stores/voice-info.svelte.js';
	import { isAutoSpeakEnabled, toggleAutoSpeak } from '../stores/autospeak.svelte.js';
	import { isVoiceAutoSendEnabled, toggleVoiceAutoSend } from '../stores/voice-autosend.svelte.js';
	import { getSpeakState } from '../stores/speak.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';
	import Icon from '../primitives/Icon.svelte';

	void ensureVoiceInfoProbed();
	const ttsAvailable = $derived(isTtsAvailable());
	const sttAvailable = $derived(getSttProvider() !== null);
	const autoSpeakOn = $derived(isAutoSpeakEnabled());
	const autoSendOn = $derived(isVoiceAutoSendEnabled());
	const speakState = $derived(getSpeakState());

	type Indicator = 'none' | 'not-configured' | 'minor' | 'major' | 'critical' | 'unknown';
	interface ProviderEntry { indicator: Indicator; description: string; provider: string }

	// Hoisted out of the 30s poll loop so we don't re-allocate the literal on
	// every tick. Severity ranking: critical > major > minor > not-configured >
	// unknown > none. `not-configured` is ranked above `unknown` so a tenant
	// missing its key wins over a stalled providers-status poll for a separate
	// provider — clearer signal for the user that the actionable problem is
	// "no key" not "transient outage".
	const INDICATOR_RANK: Record<Indicator, number> = {
		none: 0,
		unknown: 1,
		'not-configured': 1.5,
		minor: 2,
		major: 3,
		critical: 4,
	};

	let engineOk = $state<boolean | null>(null);
	let engineVersion = $state<string | null>(null);
	let apiStatus = $state<Indicator | null>(null);
	// Display name of the active provider. Default reads "API" so we never show
	// a stale "Anthropic API" label when the active provider is actually
	// Mistral / OpenAI-compatible / etc. /api/providers/status fills this on
	// first poll with the real provider name (e.g. "Mistral AI").
	let providerName = $state('API');
	let providers = $state<ProviderEntry[]>([]);
	// Tooltip text for the API-status pill — surfaces "Last run failed" (or
	// equivalent provider description) so the user knows WHY the dot is red
	// without having to open the status panel. Falls back to the provider
	// name when no description is available.
	let apiStatusTooltip = $state('');
	let activeTasks = $state(0);
	let todayCost = $state(0);
	let todayRuns = $state(0);
	let panelOpen = $state(false);

	interface SecretsStatus { configured: Record<string, boolean>; count: number; managed?: string | null }
	interface KgStats {
		memoryCount: number;
		entityCount: number;
		relationCount: number;
		communityCount: number;
		patternCount?: number;
	}

	let secrets = $state<SecretsStatus | null>(null);
	let kgStats = $state<KgStats | null>(null);

	const isManaged = $derived(!!secrets?.managed);

	const hasAuthError = $derived(getAuthError());
	function apiStatusClass(): string {
		if (hasAuthError) return 'bg-danger';
		if (apiStatus === 'none') return 'bg-success';
		if (apiStatus === 'not-configured') return 'bg-warning';
		if (apiStatus === 'minor') return 'bg-warning';
		if (apiStatus === 'major' || apiStatus === 'critical') return 'bg-danger';
		return 'bg-text-subtle animate-pulse';
	}
	function apiStatusLabel(): string {
		if (hasAuthError) return t('status.api_key_invalid');
		if (apiStatus === 'none') return t('status.api_ok');
		if (apiStatus === 'not-configured') return t('status.api_not_configured');
		if (apiStatus === 'minor') return t('status.api_degraded');
		if (apiStatus === 'major' || apiStatus === 'critical') return t('status.api_down');
		return t('status.api_unknown');
	}

	async function poll() {
		try {
			const [healthRes, tasksRes, dailyRes, providersRes] = await Promise.all([
				fetch(`${getApiBase()}/health`).catch(() => null),
				fetch(`${getApiBase()}/tasks?status=in_progress`).catch(() => null),
				fetch(`${getApiBase()}/history/cost/daily?days=1`).catch(() => null),
				fetch(`${getApiBase()}/providers/status`).catch(() => null),
			]);

			engineOk = healthRes?.ok ?? false;
			if (healthRes?.ok) {
				try {
					const data = (await healthRes.json()) as { version?: unknown; build_sha?: unknown };
					if (typeof data.version === 'string' && data.version.length > 0) {
						engineVersion = data.version;
						const sha = typeof data.build_sha === 'string' ? data.build_sha : '';
						maybeNotifyStaleBundle(data.version, sha);
					}
				} catch { /* non-JSON body — ignore */ }
			}

			if (providersRes?.ok) {
				const data = (await providersRes.json()) as { providers: ProviderEntry[] };
				providers = Array.isArray(data.providers) ? data.providers : [];
				const primary = providers[0];
				if (primary?.provider) providerName = primary.provider;

				// Aggregate worst-state across ALL configured providers — when one
				// provider (e.g. Mistral with an expired key) is failing, the bar
				// must reflect that even if the primary (Anthropic) is healthy.
				// Pre-fix this read only providers[0], so a failing Mistral was
				// invisible while the status bar misled with "OpenAI-compatible
				// · API OK" (the prod symptom that triggered this fix).
				//
				// Seed from primary (providers[0]) so the all-healthy `none`
				// case lands on green "API OK". Seeding from `unknown` would
				// lock out `none` since the loop's strict-greater check can
				// never step DOWN in severity. Strict `>` (not `>=`) makes the
				// FIRST failing provider win ties — keeps tooltip selection
				// stable across polls.
				const narrowIndicator = (raw: string | undefined): Indicator =>
					raw === 'none' || raw === 'not-configured' || raw === 'minor'
						|| raw === 'major' || raw === 'critical'
						? raw
						: 'unknown';
				let worst: Indicator = primary ? narrowIndicator(primary.indicator) : 'none';
				let worstDescription = primary?.description ?? '';
				let worstProvider = primary?.provider ?? '';
				for (let i = 1; i < providers.length; i++) {
					const p = providers[i]!;
					const ind = narrowIndicator(p.indicator);
					if (INDICATOR_RANK[ind] > INDICATOR_RANK[worst]) {
						worst = ind;
						worstDescription = p.description ?? '';
						worstProvider = p.provider ?? '';
					}
				}
				if (providers.length === 0) {
					apiStatus = 'unknown';
					apiStatusTooltip = providerName;
				} else {
					apiStatus = worst;
					// If the worst entry isn't the primary, prefix with its name
					// so the tooltip explains which provider is degraded.
					apiStatusTooltip = worstProvider && worstProvider !== providerName
						? `${worstProvider}: ${worstDescription || worstProvider}`
						: (worstDescription || providerName);
				}
			} else {
				apiStatus = 'unknown';
				providers = [];
				apiStatusTooltip = providerName;
			}

			if (tasksRes?.ok) {
				const data = (await tasksRes.json()) as { tasks: unknown[] };
				activeTasks = data.tasks.length;
			}

			if (dailyRes?.ok) {
				const rows = (await dailyRes.json()) as Array<{ day: string; cost_usd: number; run_count: number }>;
				const today = new Date().toISOString().slice(0, 10);
				const todayRow = rows.find(r => r.day === today);
				todayCost = todayRow?.cost_usd ?? 0;
				todayRuns = todayRow?.run_count ?? 0;
			}
		} catch { /* silent */ }
	}

	async function loadPanelData() {
		try {
			const [secretsRes, kgRes] = await Promise.all([
				fetch(`${getApiBase()}/secrets/status`).catch(() => null),
				fetch(`${getApiBase()}/kg/stats`).catch(() => null),
			]);
			if (secretsRes?.ok) secrets = (await secretsRes.json()) as SecretsStatus;
			if (kgRes?.ok) kgStats = (await kgRes.json()) as KgStats;
		} catch { /* silent */ }
	}

	function togglePanel() {
		panelOpen = !panelOpen;
		if (panelOpen) void loadPanelData();
	}

	function closePanel() {
		panelOpen = false;
	}

	// Stale-bundle detection — the build-time web-ui version + git SHA baked
	// in by Vite. After a deploy, returning users may still be running
	// yesterday's JS against a newer engine; drifted response shapes silently
	// break things (thread list, SSE events, lazy-loaded route chunks → 404,
	// "voice message reloads but doesn't send" — see bug 2026-05-05).
	//
	// We compare on EITHER axis. Most patches don't bump `version` but every
	// rebuild has a new SHA, and chunk hashes drift with every build, so the
	// SHA arm catches the realistic case where two same-version deploys
	// produce incompatible bundles. One toast per session — a reload either
	// clears the cache or confirms the user has intentionally pinned.
	const BUILT_VERSION: string = typeof __LYNOX_WEB_UI_VERSION__ === 'string' ? __LYNOX_WEB_UI_VERSION__ : '';
	const BUILT_SHA: string = typeof __LYNOX_BUILD_SHA__ === 'string' ? __LYNOX_BUILD_SHA__ : '';
	let staleBundleNotified = false;
	function maybeNotifyStaleBundle(engineV: string, engineSha: string): void {
		if (staleBundleNotified) return;
		const versionMismatch = !!BUILT_VERSION && BUILT_VERSION !== engineV;
		// Only fire the SHA arm when both sides have a SHA — local dev
		// builds without BUILD_SHA and engines started without BUILD_SHA env
		// would otherwise toast on every poll.
		const shaMismatch = !!BUILT_SHA && !!engineSha && BUILT_SHA !== engineSha;
		if (!versionMismatch && !shaMismatch) return;
		staleBundleNotified = true;
		addToast(t('status.stale_bundle'), 'info', 30_000, {
			label: t('status.stale_bundle_action'),
			// Bare `location.reload()` is honoured by Chrome but iOS WKWebView
			// (PWA + Safari) often serves the same cached HTML — Rafael hit this
			// when canarying v1.3.10. Match the cold-start guard's pattern:
			// `location.replace` with a cache-bust query param forces iOS to
			// treat it as a new resource. Combined with the no-store HTML
			// Cache-Control added in v1.3.11 hooks, this is belt-and-suspenders.
			handler: () => {
				const url = new URL(location.href);
				url.searchParams.set('_v', engineSha.slice(0, 8));
				location.replace(url.toString());
			},
		});
	}

	let pollInterval: ReturnType<typeof setInterval> | null = null;

	function startPolling() {
		if (pollInterval) return;
		poll();
		pollInterval = setInterval(poll, 30_000);
	}

	function stopPolling() {
		if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
	}

	startPolling();

	// Pause polling when tab is hidden to save battery/network
	$effect(() => {
		function onVisibility() {
			if (document.hidden) stopPolling();
			else startPolling();
		}
		document.addEventListener('visibilitychange', onVisibility);
		return () => document.removeEventListener('visibilitychange', onVisibility);
	});

	onDestroy(() => stopPolling());

	$effect(() => {
		if (!panelOpen) return;
		function onKey(e: KeyboardEvent) { if (e.key === 'Escape') closePanel(); }
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});
</script>

{#snippet autoSpeakBtn()}
	{#if ttsAvailable}
		<button
			onclick={toggleAutoSpeak}
			class="flex items-center gap-1 px-2 py-1 hover:text-text transition-colors shrink-0 {autoSpeakOn ? 'text-accent-text' : 'text-text-muted'}"
			title={autoSpeakOn ? (speakState === 'playing' ? t('status.autospeak_playing') : t('status.autospeak_on')) : t('status.autospeak_off')}
			aria-label={autoSpeakOn ? t('status.autospeak_on') : t('status.autospeak_off')}
			aria-pressed={autoSpeakOn}
		>
			{#if autoSpeakOn}
				<Icon name="volume_on" size="xs" class={speakState === 'playing' ? 'motion-safe:animate-pulse' : ''} />
			{:else}
				<Icon name="volume_off" size="xs" />
			{/if}
		</button>
	{/if}
{/snippet}

{#snippet voiceAutoSendBtn()}
	{#if sttAvailable}
		<button
			onclick={toggleVoiceAutoSend}
			class="flex items-center gap-1 px-2 py-1 hover:text-text transition-colors shrink-0 {autoSendOn ? 'text-accent-text' : 'text-text-muted'}"
			title={autoSendOn ? t('status.autosend_on') : t('status.autosend_off')}
			aria-label={autoSendOn ? t('status.autosend_on') : t('status.autosend_off')}
			aria-pressed={autoSendOn}
		>
			{#if autoSendOn}
				<!-- Paper airplane: voice goes straight to the agent. -->
				<Icon name="send" size="xs" />
			{:else}
				<!-- Pencil-square: voice lands in the input for review/edit. -->
				<Icon name="pencil" size="xs" />
			{/if}
		</button>
	{/if}
{/snippet}

<!-- Mobile: minimal engine indicator + voice auto-send + auto-speak toggles.
	Previously added `pb-[env(safe-area-inset-bottom)]` (~34px on iPhone) which
	produced wasted black space below the status text. The iOS Home Indicator
	bar visually overlaps the bottom edge now, but the status text sits above
	the indicator and stays legible. -->
<div class="flex md:hidden items-center justify-center gap-1 border-t border-border bg-bg-subtle min-h-7 px-2">
	<button onclick={togglePanel} class="flex items-center gap-1.5 text-[11px] font-mono text-text-subtle hover:text-text transition-colors" title={apiStatusTooltip || providerName}>
		<span class="inline-block h-1.5 w-1.5 rounded-full {engineOk === true ? 'bg-success' : engineOk === false ? 'bg-danger' : 'bg-text-subtle animate-pulse'}"></span>
		{engineOk === true ? t('status.engine_ok') : engineOk === false ? t('status.engine_error') : '...'}
		<span class="text-border mx-1">|</span>
		<!-- Aggregated worst-state across all configured providers (mobile mirror
		     of the desktop pill). Pre-fix this used providers[0] only, so a
		     failing Mistral was invisible on mobile too. -->
		<span class="inline-block h-1.5 w-1.5 rounded-full {apiStatusClass()}"></span>
		{providerName} · {apiStatusLabel()}
		<span class="text-border mx-1">|</span>
		{formatCost(todayCost)}
	</button>
	{@render voiceAutoSendBtn()}
	{@render autoSpeakBtn()}
</div>

<!-- Desktop: full status bar. No safe-area-inset — desktop has no Home Indicator
	zone, and adding the env() call still consumed a few px on browsers that
	report a non-zero value for the gesture pad (some macOS Safari builds). -->
<div class="hidden md:flex items-center gap-px border-t border-border bg-bg-subtle text-[11px] font-mono text-text-subtle min-h-8 px-1 overflow-x-auto scrollbar-none">
	<!-- Engine Status (clickable) -->
	<button onclick={togglePanel} class="flex items-center gap-1.5 px-3 py-1 hover:text-text transition-colors shrink-0">
		<span class="inline-block h-1.5 w-1.5 rounded-full {engineOk === true ? 'bg-success' : engineOk === false ? 'bg-danger' : 'bg-text-subtle animate-pulse'}"></span>
		{engineOk === true ? t('status.engine_ok') : engineOk === false ? t('status.engine_error') : '...'}
	</button>

	<span class="text-border">|</span>

	<!-- API Status — shows active provider name + aggregated worst-state across
		all configured providers. Tooltip surfaces the failing provider's
		description (e.g. "Mistral AI: Last run failed") so the user knows
		which provider is degraded without opening the status panel. -->
	<span class="flex items-center gap-1.5 px-3 py-1 shrink-0" title={apiStatusTooltip || providerName}>
		<span class="inline-block h-1.5 w-1.5 rounded-full {apiStatusClass()}"></span>
		{providerName} · {apiStatusLabel()}
	</span>

	<span class="text-border">|</span>

	<!-- Active Tasks -->
	<a href="/app/hub?section=tasks" class="flex items-center gap-1.5 px-3 py-1 hover:text-text transition-colors shrink-0">
		<span class="text-accent-text">{activeTasks}</span> {t('status.tasks_active')}
	</a>

	<span class="text-border">|</span>

	<!-- Today's Cost — points to the canonical Activity Overview.
	     Per PRD-IA-CONSOLIDATION-V2 Phase 2 P2-PR-B the click target moves
	     from the legacy hub cost-limits route to /app/activity. Edit-limits
	     SSoT now lives in /app/settings/workspace/limits (P3-PR-X). -->
	<a href="/app/activity" class="flex items-center gap-1.5 px-3 py-1 hover:text-text transition-colors shrink-0">
		{formatCost(todayCost)} {t('status.today')}
	</a>

	<span class="text-border">|</span>

	<!-- Today's Runs — points to Activity History tab.
	     Per PRD-IA-CONSOLIDATION-V2 P2-PR-B the target moves from the
	     legacy hub activity-tab query to /app/activity?tab=history. -->
	<a href="/app/activity?tab=history" class="flex items-center gap-1.5 px-3 py-1 hover:text-text transition-colors shrink-0">
		{todayRuns} {t('status.runs')} {t('status.today')}
	</a>

	<span class="text-border">|</span>

	<!-- Voice auto-send toggle — hidden when no STT provider is available -->
	{@render voiceAutoSendBtn()}

	<!-- Auto-speak toggle — hidden entirely when no TTS provider is available -->
	{@render autoSpeakBtn()}

	<!-- Mobile Access shortcut -->
	<a href="/app/settings/account/mobile" class="flex items-center gap-1 px-2 py-1 hover:text-text transition-colors shrink-0" title={t('mobile.title')}>
		<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M7 2a2 2 0 00-2 2v12a2 2 0 002 2h6a2 2 0 002-2V4a2 2 0 00-2-2H7zm3 14a1 1 0 100-2 1 1 0 000 2z"/></svg>
	</a>

	<!-- Context Window -->
	{#if getContextBudget()}
		{@const pct = getContextBudget()?.usagePercent ?? 0}
		{@const color = pct >= 75 ? 'bg-danger' : pct >= 60 ? 'bg-warning' : 'bg-accent'}
		{@const textColor = pct >= 75 ? 'text-danger' : pct >= 60 ? 'text-warning' : 'text-text-subtle'}
		<span class="text-border">|</span>
		<div class="flex items-center gap-1.5 px-3 py-1 shrink-0" title="{getContextBudget()?.totalTokens ?? 0} / {getContextBudget()?.maxTokens ?? 0} tokens{getSessionModel() ? ` · ${getSessionModel()}` : ''}">
			<div class="w-16 h-1 rounded-full bg-border overflow-hidden">
				<div class="{color} h-full rounded-full transition-all duration-500" style="width: {Math.min(pct, 100)}%"></div>
			</div>
			<span class="text-[10px] font-mono {textColor}">{Math.min(pct, 100)}%</span>
		</div>
	{/if}

	<!-- Legal + version (right-aligned) -->
	<div class="flex items-center gap-2 ml-auto px-3 shrink-0">
		{#if engineVersion}
			<span class="text-text-subtle/70 font-mono" title={t('status.engine_version')}>v{engineVersion}</span>
			<span class="text-border">·</span>
		{/if}
		<a href="https://lynox.ai/{getLocale() === 'de' ? 'de/agb/' : 'terms'}" target="_blank" rel="noopener" class="hover:text-text transition-colors">{t('legal.terms')}</a>
		<span class="text-border">·</span>
		<a href="https://lynox.ai/{getLocale() === 'de' ? 'de/datenschutz/' : 'privacy'}" target="_blank" rel="noopener" class="hover:text-text transition-colors">{t('legal.privacy')}</a>
		<span class="text-border">·</span>
		<a href="https://lynox.ai/{getLocale() === 'de' ? 'de/avv/' : 'dpa'}" target="_blank" rel="noopener" class="hover:text-text transition-colors">{t('legal.dpa')}</a>
		<span class="text-border">·</span>
		<a href="https://lynox.ai/{getLocale() === 'de' ? 'de/impressum/' : 'imprint'}" target="_blank" rel="noopener" class="hover:text-text transition-colors">{t('legal.imprint')}</a>
	</div>
</div>

<!-- Status Panel Overlay -->
{#if panelOpen}
	<button class="fixed inset-0 z-50 bg-bg-overlay/60 backdrop-blur-sm" onclick={closePanel} aria-label="Close"></button>
	<div class="fixed z-50 bottom-8 md:bottom-9 left-2 right-2 md:left-auto md:right-auto md:w-96 bg-bg-subtle border border-border rounded-[var(--radius-lg)] shadow-2xl overflow-hidden" style="md:margin-left: 0.5rem;">
		<!-- Header -->
		<div class="flex items-center justify-between px-4 py-3 border-b border-border">
			<h3 class="text-sm font-semibold text-text">{t('status.panel_title')}</h3>
			<button onclick={closePanel} class="h-6 w-6 flex items-center justify-center rounded text-text-subtle hover:text-text hover:bg-bg-muted transition-colors">&times;</button>
		</div>

		<div class="max-h-[60vh] overflow-y-auto scrollbar-thin p-4 space-y-4 text-sm">
			<!-- Engine Connection -->
			<div class="flex items-center gap-2">
				<span class="inline-block h-2 w-2 rounded-full {engineOk === true ? 'bg-success' : engineOk === false ? 'bg-danger' : 'bg-text-subtle animate-pulse'}"></span>
				<span class="font-medium text-text">Engine: {engineOk === true ? t('status.connected') : t('status.disconnected')}</span>
			</div>

			<!-- Provider API Status — one row per configured provider -->
			<div>
				<p class="text-xs uppercase tracking-wider text-text-subtle mb-2">{t('status.api_status')}</p>
				<div class="space-y-1.5">
					{#if providers.length === 0}
						<div class="flex items-center gap-2 text-sm">
							<span class="inline-block h-2 w-2 rounded-full {apiStatusClass()}"></span>
							<span class="font-medium text-text">{providerName}: {apiStatusLabel()}</span>
						</div>
					{:else}
						{#each providers as p, i (p.provider)}
							<div class="flex items-center gap-2 text-sm" title={p.description}>
								<span class="inline-block h-2 w-2 rounded-full {
									hasAuthError && i === 0 ? 'bg-danger'
									: p.indicator === 'none' ? 'bg-success'
									: p.indicator === 'minor' ? 'bg-warning'
									: p.indicator === 'major' || p.indicator === 'critical' ? 'bg-danger'
									: 'bg-text-subtle animate-pulse'
								}"></span>
								<span class="font-medium text-text">{p.provider}</span>
								<span class="text-xs text-text-subtle">— {p.description}</span>
							</div>
						{/each}
					{/if}
				</div>
			</div>

			<!-- API Keys -->
			{#if secrets}
				<div>
					<p class="text-xs uppercase tracking-wider text-text-subtle mb-2">{t('status.api_keys')}</p>
					<div class="grid grid-cols-2 gap-1.5">
						{#each [
							['api_key', isManaged ? t('status.api_key_managed') : t('status.api_key')],
							['search', t('status.search')],
							['google', t('status.google')],
							...(!isManaged ? [['bugsink', t('status.bugsink')]] : []),
						] as [key, label]}
							<div class="flex items-center gap-1.5 text-xs">
								{#if secrets.configured[key]}
									<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5 text-success shrink-0" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" /></svg>
								{:else}
									<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5 text-text-subtle shrink-0" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clip-rule="evenodd" /></svg>
								{/if}
								<span class="{secrets.configured[key] ? 'text-text' : 'text-text-subtle'}">{label}</span>
							</div>
						{/each}
					</div>
				</div>
			{/if}

			<!-- Usage Today — each card links to the canonical Activity surface.
			     Per PRD-IA-CONSOLIDATION-V2 P2-PR-B the status-panel "Usage Today"
			     navigates to `/app/activity` (Overview tab). -->
			<div>
				<p class="text-xs uppercase tracking-wider text-text-subtle mb-2">{t('status.usage_today')}</p>
				<div class="grid grid-cols-2 gap-2">
					<a
						href="/app/activity"
						onclick={closePanel}
						class="bg-bg-muted rounded-[var(--radius-sm)] px-3 py-2 hover:bg-bg hover:text-text transition-colors"
					>
						<p class="text-lg font-semibold text-text">{formatCost(todayCost)}</p>
						<p class="text-xs text-text-subtle">{t('status.cost')}</p>
					</a>
					<a
						href="/app/activity?tab=history"
						onclick={closePanel}
						class="bg-bg-muted rounded-[var(--radius-sm)] px-3 py-2 hover:bg-bg hover:text-text transition-colors"
					>
						<p class="text-lg font-semibold text-text">{todayRuns}</p>
						<p class="text-xs text-text-subtle">{t('status.runs')}</p>
					</a>
				</div>
			</div>

			<!-- Knowledge Graph -->
			{#if kgStats && (kgStats.entityCount > 0 || kgStats.memoryCount > 0)}
				<div>
					<p class="text-xs uppercase tracking-wider text-text-subtle mb-2">{t('status.knowledge')}</p>
					<div class="grid grid-cols-2 gap-1.5 text-xs">
						<div class="flex justify-between bg-bg-muted rounded-[var(--radius-sm)] px-3 py-1.5">
							<span class="text-text-subtle">{t('status.entities')}</span>
							<span class="text-text font-medium">{kgStats.entityCount}</span>
						</div>
						<div class="flex justify-between bg-bg-muted rounded-[var(--radius-sm)] px-3 py-1.5">
							<span class="text-text-subtle">{t('status.relations')}</span>
							<span class="text-text font-medium">{kgStats.relationCount}</span>
						</div>
						<div class="flex justify-between bg-bg-muted rounded-[var(--radius-sm)] px-3 py-1.5">
							<span class="text-text-subtle">{t('status.memories')}</span>
							<span class="text-text font-medium">{kgStats.memoryCount}</span>
						</div>
						{#if kgStats.communityCount > 0}
							<div class="flex justify-between bg-bg-muted rounded-[var(--radius-sm)] px-3 py-1.5">
								<span class="text-text-subtle">{t('status.communities')}</span>
								<span class="text-text font-medium">{kgStats.communityCount}</span>
							</div>
						{/if}
						{#if kgStats.patternCount != null && kgStats.patternCount > 0}
							<div class="flex justify-between bg-bg-muted rounded-[var(--radius-sm)] px-3 py-1.5">
								<span class="text-text-subtle">{t('status.patterns')}</span>
								<span class="text-text font-medium">{kgStats.patternCount}</span>
							</div>
						{/if}
					</div>
				</div>
			{/if}

			<!-- Active Tasks -->
			{#if activeTasks > 0}
				<div class="flex items-center justify-between text-xs">
					<span class="text-text-subtle">{t('status.tasks_active')}</span>
					<a href="/app/hub?section=tasks" onclick={closePanel} class="text-accent-text hover:underline">{activeTasks} Tasks</a>
				</div>
			{/if}

			<!-- Legal -->
			<div class="flex items-center gap-3 pt-3 border-t border-border text-[11px] text-text-subtle">
				<a href="https://lynox.ai/{getLocale() === 'de' ? 'de/agb/' : 'terms'}" target="_blank" rel="noopener" class="hover:text-text transition-colors">{t('legal.terms')}</a>
				<span class="text-border">·</span>
				<a href="https://lynox.ai/{getLocale() === 'de' ? 'de/datenschutz/' : 'privacy'}" target="_blank" rel="noopener" class="hover:text-text transition-colors">{t('legal.privacy')}</a>
				<span class="text-border">·</span>
				<a href="https://lynox.ai/{getLocale() === 'de' ? 'de/avv/' : 'dpa'}" target="_blank" rel="noopener" class="hover:text-text transition-colors">{t('legal.dpa')}</a>
				<span class="text-border">·</span>
				<a href="https://lynox.ai/{getLocale() === 'de' ? 'de/impressum/' : 'imprint'}" target="_blank" rel="noopener" class="hover:text-text transition-colors">{t('legal.imprint')}</a>
			</div>
		</div>
	</div>
{/if}
