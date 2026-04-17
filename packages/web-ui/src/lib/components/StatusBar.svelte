<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { formatCost } from '../format.js';
	import { t, getLocale } from '../i18n.svelte.js';
	import { onDestroy } from 'svelte';
	import { getContextBudget, getSessionModel, getAuthError } from '../stores/chat.svelte.js';
	import { ensureVoiceInfoProbed, isTtsAvailable } from '../stores/voice-info.svelte.js';
	import { isAutoSpeakEnabled, toggleAutoSpeak } from '../stores/autospeak.svelte.js';
	import { getSpeakState } from '../stores/speak.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';

	void ensureVoiceInfoProbed();
	const ttsAvailable = $derived(isTtsAvailable());
	const autoSpeakOn = $derived(isAutoSpeakEnabled());
	const speakState = $derived(getSpeakState());

	type Indicator = 'none' | 'minor' | 'major' | 'critical' | 'unknown';
	interface ProviderEntry { indicator: Indicator; description: string; provider: string }

	let engineOk = $state<boolean | null>(null);
	let engineVersion = $state<string | null>(null);
	let apiStatus = $state<Indicator | null>(null);
	let providerName = $state('Anthropic API');
	let providers = $state<ProviderEntry[]>([]);
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
		if (apiStatus === 'minor') return 'bg-warning';
		if (apiStatus === 'major' || apiStatus === 'critical') return 'bg-danger';
		return 'bg-text-subtle animate-pulse';
	}
	function apiStatusLabel(): string {
		if (hasAuthError) return t('status.api_key_invalid');
		if (apiStatus === 'none') return t('status.api_ok');
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
					const data = (await healthRes.json()) as { version?: unknown };
					if (typeof data.version === 'string' && data.version.length > 0) {
						engineVersion = data.version;
						maybeNotifyStaleBundle(data.version);
					}
				} catch { /* non-JSON body — ignore */ }
			}

			if (providersRes?.ok) {
				const data = (await providersRes.json()) as { providers: ProviderEntry[] };
				providers = Array.isArray(data.providers) ? data.providers : [];
				const primary = providers[0];
				if (primary) {
					const ind = primary.indicator;
					apiStatus = ind === 'none' || ind === 'minor' || ind === 'major' || ind === 'critical'
						? ind : 'unknown';
					if (primary.provider) providerName = primary.provider;
				} else {
					apiStatus = 'unknown';
				}
			} else {
				apiStatus = 'unknown';
				providers = [];
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

	// Stale-bundle detection — the build-time web-ui version baked in by Vite.
	// After a deploy, returning users may still be running yesterday's JS
	// against a newer engine; drifted response shapes silently break things
	// (thread list, SSE events). One toast per session is enough — a reload
	// either clears the cache or confirms the user has intentionally pinned.
	const BUILT_VERSION: string = typeof __LYNOX_WEB_UI_VERSION__ === 'string' ? __LYNOX_WEB_UI_VERSION__ : '';
	let staleBundleNotified = false;
	function maybeNotifyStaleBundle(engineV: string): void {
		if (staleBundleNotified) return;
		if (!BUILT_VERSION || BUILT_VERSION === engineV) return;
		staleBundleNotified = true;
		addToast(t('status.stale_bundle'), 'info', 30_000);
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

<!-- Mobile: minimal engine indicator -->
<div class="flex md:hidden items-center justify-center border-t border-border bg-bg-subtle h-7 px-2">
	<button onclick={togglePanel} class="flex items-center gap-1.5 text-[11px] font-mono text-text-subtle hover:text-text transition-colors">
		<span class="inline-block h-1.5 w-1.5 rounded-full {engineOk === true ? 'bg-success' : engineOk === false ? 'bg-danger' : 'bg-text-subtle animate-pulse'}"></span>
		{engineOk === true ? t('status.engine_ok') : engineOk === false ? t('status.engine_error') : '...'}
		<span class="text-border mx-1">|</span>
		<span class="inline-block h-1.5 w-1.5 rounded-full {apiStatusClass()}"></span>
		{apiStatusLabel()}
		<span class="text-border mx-1">|</span>
		{formatCost(todayCost)}
	</button>
</div>

<!-- Desktop: full status bar -->
<div class="hidden md:flex items-center gap-px border-t border-border bg-bg-subtle text-[11px] font-mono text-text-subtle h-8 px-1 overflow-x-auto scrollbar-none">
	<!-- Engine Status (clickable) -->
	<button onclick={togglePanel} class="flex items-center gap-1.5 px-3 py-1 hover:text-text transition-colors shrink-0">
		<span class="inline-block h-1.5 w-1.5 rounded-full {engineOk === true ? 'bg-success' : engineOk === false ? 'bg-danger' : 'bg-text-subtle animate-pulse'}"></span>
		{engineOk === true ? t('status.engine_ok') : engineOk === false ? t('status.engine_error') : '...'}
	</button>

	<span class="text-border">|</span>

	<!-- API Status -->
	<span class="flex items-center gap-1.5 px-3 py-1 shrink-0" title={providerName}>
		<span class="inline-block h-1.5 w-1.5 rounded-full {apiStatusClass()}"></span>
		{apiStatusLabel()}
	</span>

	<span class="text-border">|</span>

	<!-- Active Tasks -->
	<a href="/app/activity?tab=tasks" class="flex items-center gap-1.5 px-3 py-1 hover:text-text transition-colors shrink-0">
		<span class="text-accent-text">{activeTasks}</span> {t('status.tasks_active')}
	</a>

	<span class="text-border">|</span>

	<!-- Today's Cost -->
	<a href="/app/activity?tab=history" class="flex items-center gap-1.5 px-3 py-1 hover:text-text transition-colors shrink-0">
		{formatCost(todayCost)} {t('status.today')}
	</a>

	<span class="text-border">|</span>

	<!-- Today's Runs -->
	<a href="/app/activity?tab=history" class="flex items-center gap-1.5 px-3 py-1 hover:text-text transition-colors shrink-0">
		{todayRuns} {t('status.runs')} {t('status.today')}
	</a>

	<span class="text-border">|</span>

	<!-- Auto-speak toggle — hidden entirely when no TTS provider is available -->
	{#if ttsAvailable}
		<button
			onclick={toggleAutoSpeak}
			class="flex items-center gap-1 px-2 py-1 hover:text-text transition-colors shrink-0 {autoSpeakOn ? 'text-accent-text' : 'text-text-subtle'}"
			title={autoSpeakOn ? (speakState === 'playing' ? t('status.autospeak_playing') : t('status.autospeak_on')) : t('status.autospeak_off')}
			aria-label={autoSpeakOn ? t('status.autospeak_on') : t('status.autospeak_off')}
			aria-pressed={autoSpeakOn}
		>
			{#if autoSpeakOn}
				<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5 {speakState === 'playing' ? 'motion-safe:animate-pulse' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" /></svg>
			{:else}
				<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M17.25 9.75L19.5 12m0 0l2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-10.5-6l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" /></svg>
			{/if}
		</button>
	{/if}

	<!-- Mobile Access shortcut -->
	<a href="/app/settings/mobile" class="flex items-center gap-1 px-2 py-1 hover:text-text transition-colors shrink-0" title={t('mobile.title')}>
		<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M7 2a2 2 0 00-2 2v12a2 2 0 002 2h6a2 2 0 002-2V4a2 2 0 00-2-2H7zm3 14a1 1 0 100-2 1 1 0 000 2z"/></svg>
	</a>

	<!-- Context Window -->
	{#if getContextBudget()}
		{@const pct = getContextBudget()?.usagePercent ?? 0}
		{@const color = pct >= 80 ? 'bg-danger' : pct >= 50 ? 'bg-warning' : 'bg-accent'}
		{@const textColor = pct >= 80 ? 'text-danger' : pct >= 50 ? 'text-warning' : 'text-text-subtle'}
		<span class="text-border">|</span>
		<div class="flex items-center gap-1.5 px-3 py-1 shrink-0" title="{getContextBudget()?.totalTokens ?? 0} / {getContextBudget()?.maxTokens ?? 0} tokens{getSessionModel() ? ` · ${getSessionModel()}` : ''}">
			<div class="w-16 h-1 rounded-full bg-border overflow-hidden">
				<div class="{color} h-full rounded-full transition-all duration-500" style="width: {Math.min(pct, 100)}%"></div>
			</div>
			<span class="text-[10px] font-mono {textColor}">{pct}%</span>
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
	<button class="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" onclick={closePanel} aria-label="Close"></button>
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
							['telegram', t('status.telegram')],
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

			<!-- Usage Today -->
			<div>
				<p class="text-xs uppercase tracking-wider text-text-subtle mb-2">{t('status.usage_today')}</p>
				<div class="grid grid-cols-2 gap-2">
					<div class="bg-bg-muted rounded-[var(--radius-sm)] px-3 py-2">
						<p class="text-lg font-semibold text-text">{formatCost(todayCost)}</p>
						<p class="text-xs text-text-subtle">{t('status.cost')}</p>
					</div>
					<div class="bg-bg-muted rounded-[var(--radius-sm)] px-3 py-2">
						<p class="text-lg font-semibold text-text">{todayRuns}</p>
						<p class="text-xs text-text-subtle">{t('status.runs')}</p>
					</div>
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
					<a href="/app/activity?tab=tasks" onclick={closePanel} class="text-accent-text hover:underline">{activeTasks} Tasks</a>
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
