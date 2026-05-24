<!--
	LLM Advanced (PRD-IA-V2 P3-PR-C) — final canonical home for the
	provider-adjacent dials that previously lived as collapsible panels on
	LLMSettings (effort, thinking, llm_mode, embedding_provider, experience)
	and the context-window radio that took a temporary detour through
	CostLimits.svelte (P2-PR-C interim, deleted in P3-PR-X). Backend SSoT
	stays `/api/config`; this surface PUTs the same fields the legacy
	locations did, so a stale tab cannot drift state.

	Tier-awareness audit (Settings v3 Item 2, 2026-05-19):
	| Setting              | Self-host | BYOK | Managed |
	|----------------------|-----------|------|---------|
	| llm_mode             | ✓         | ✓    | ✗ admin-only |
	| effort_level         | ✓         | ✓    | ✓        |
	| thinking_mode        | ✓         | ✓    | ✓        |
	| experience           | ✓         | ✓    | ✓        |
	| embedding_provider   | ✓         | ✓    | ✗ silent-403 → hidden |
	| max_context_window   | ✓         | ✓    | ✓ (managed caps still apply) |

	Managed-tier gotchas baked in:
	- `embedding_provider` is NOT in MANAGED_USER_WRITABLE_CONFIG (silent-403
	  on managed) → hidden behind `isManaged`.
	- `llm_mode` toggle is admin-only on managed per project_managed_llm_strategy
	  → hidden when `providerLocked` OR when Mistral capability is not wired.
	- `max_context_window_tokens` user choice clamps to model native via
	  `effectiveContextWindow()` (server-side). Settings v3 Item 6 filters the
	  radio set so users can't pick a cap above their active model's native.
-->
<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';
	import { buildContextOptions, formatContextWindow, type ContextMilestone } from '../utils/context-window.js';

	// Settings v3 PR 4.6 (2026-05-19) — `embedded=true` skips the page chrome
	// (back-link + h1 + subtitle) so this component can render inline inside
	// LLMSettings.svelte as an expandable section. Standalone /llm/advanced
	// page keeps `embedded=false` (default) for back-compat with deep links.
	let { embedded = false }: { embedded?: boolean } = $props();

	interface UserConfig {
		experience?: 'business' | 'developer';
		effort_level?: 'low' | 'medium' | 'high' | 'max';
		thinking_mode?: 'adaptive' | 'disabled';
		embedding_provider?: 'onnx' | 'local';
		llm_mode?: 'standard' | 'eu-sovereign';
		max_context_window_tokens?: number;
	}

	interface Locks {
		provider?: { reason: string; upgrade_cta?: { href: string; label: string } };
	}

	// Subset of MODEL_CAPABILITIES surfaced by /api/config — see
	// http-api.ts:`active_model` block. Web-ui has no direct dep on
	// `@lynox-ai/core` so the server pre-resolves the fields the UI needs.
	interface ActiveModel {
		id: string;
		tier: 'opus' | 'sonnet' | 'haiku' | null;
		provider: 'anthropic' | 'vertex' | 'openai' | 'custom';
		contextWindow: number;
		defaultMaxOutput: number;
		maxContinuations: number;
		features: {
			vision: boolean;
			extendedThinking: boolean;
			toolUse: boolean;
			promptCaching: boolean;
			pdfInput: boolean;
		};
		uiLabel: string;
	}

	let config = $state<UserConfig>({});
	// Snapshot of the raw server config at load-time — used by save() to
	// diff against `config` so the auto-populated engine-default values
	// (effort='high', thinking='adaptive', experience='business') aren't
	// silently written back to the server when the user touches an
	// unrelated field. Only fields the user actually changed get staged.
	let origConfig = $state<UserConfig>({});
	let locks = $state<Locks>({});
	let managed = $state<boolean | null>(null);
	let mistralAvailable = $state<boolean>(false);
	let activeModel = $state<ActiveModel | null>(null);
	let loaded = $state(false);
	let saving = $state(false);

	async function load(): Promise<void> {
		try {
			const res = await fetch(`${getApiBase()}/config`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = (await res.json()) as UserConfig & {
				locks?: Locks;
				managed?: string;
				capabilities?: { mistral_available?: boolean };
				active_model?: ActiveModel;
			};
			// UX-fix 2026-05-24: when effort_level / thinking_mode are unset in
			// stored config, prefer the engine's actual defaults so the dropdowns
			// don't display a phantom "default" option that the user can't
			// re-select. effort engine-default: 'high' on non-Haiku, non-custom
			// (agent.ts:271). thinking engine-default: 'adaptive' on Anthropic
			// (agent.ts:278). Both align with the "(empfohlen)" UI label.
			// Untouched configs are not auto-saved — values only persist when
			// the user hits Save.
			// Raw server values — used by save() to diff and only persist
			// fields the user actually touched.
			origConfig = {
				experience: body.experience,
				effort_level: body.effort_level,
				thinking_mode: body.thinking_mode,
				embedding_provider: body.embedding_provider,
				llm_mode: body.llm_mode,
				max_context_window_tokens: body.max_context_window_tokens,
			};
			// Displayed state — coalesce unset fields to the engine's actual
			// defaults so the dropdowns always have a matching selection that
			// matches the "(empfohlen)" labels.
			config = {
				experience: body.experience ?? 'business',
				effort_level: body.effort_level ?? 'high',
				thinking_mode: body.thinking_mode ?? 'adaptive',
				embedding_provider: body.embedding_provider,
				llm_mode: body.llm_mode,
				max_context_window_tokens: body.max_context_window_tokens,
			};
			locks = body.locks ?? {};
			managed = body.managed === 'managed' || body.managed === 'managed_pro' || body.managed === 'eu';
			mistralAvailable = body.capabilities?.mistral_available === true;
			activeModel = body.active_model ?? null;
			loaded = true;
		} catch (e) {
			addToast(e instanceof Error ? e.message : t('llm.load_failed'), 'error', 5000);
		}
	}

	async function save(): Promise<void> {
		if (!loaded) return;
		saving = true;
		try {
			// Diff-based staging — only persist fields the user actually
			// changed since load. The displayed `config` state coalesces
			// unset fields to engine defaults (so dropdowns render correctly),
			// but those auto-populated values must NOT be written back to
			// the server on unrelated saves, otherwise:
			//   - the user's stored config silently gains keys they never set
			//   - future engine default changes won't propagate to them
			// 2026-05-24 fix per /pr-review #578 N1.
			const update: UserConfig = {};
			if (config.experience !== origConfig.experience) update.experience = config.experience;
			if (config.effort_level !== origConfig.effort_level) update.effort_level = config.effort_level;
			if (config.thinking_mode !== origConfig.thinking_mode) update.thinking_mode = config.thinking_mode;
			// llm_mode and embedding_provider are provider-bound — only stage
			// when the UI was allowed to render them (lock + capability gates).
			if (config.llm_mode !== origConfig.llm_mode && !providerLocked) update.llm_mode = config.llm_mode;
			if (config.embedding_provider !== origConfig.embedding_provider && !isManaged) update.embedding_provider = config.embedding_provider;
			if (config.max_context_window_tokens !== origConfig.max_context_window_tokens) {
				update.max_context_window_tokens = config.max_context_window_tokens;
			}
			const res = await fetch(`${getApiBase()}/config`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(update),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			addToast(t('llm.saved'), 'success', 3000);
		} catch (e) {
			addToast(e instanceof Error ? e.message : t('llm.save_failed'), 'error', 5000);
		} finally {
			saving = false;
		}
	}

	const providerLocked = $derived(!!locks.provider);
	const isManaged = $derived(managed === true);

	$effect(() => { void load(); });

	// Context-window radio options — final canonical home for the
	// `max_context_window_tokens` radio after P3-PR-X deleted CostLimits.svelte.
	// LLMSettings used to host this literal too (pre-P3-PR-C extraction); both
	// historic surfaces PUT the same `/api/config` field, so backend SSoT was
	// never duplicated.
	//
	// Settings v3 Item 6 (2026-05-19): cap milestones strictly less than the
	// active model's native window. Pre-fix, picking "1M" on Sonnet base (200K
	// native) silently capped to 200K — UI lied about effective cap. Picking
	// "500K" on Mistral Large (131K native) did the same. Server resolves the
	// native window via MODEL_CAPABILITIES[active_model.id] and the UI filters
	// CAP_MILESTONES to those strictly below it (above-native is redundant
	// with "default"). PR 3 will switch this to show-all-grayed.
	const CAP_MILESTONES: ReadonlyArray<ContextMilestone> = [
		{ value: 32_000,    labelKey: 'llm.context_window.option.32k',  hintKey: 'llm.context_window.option.32k_hint' },
		{ value: 100_000,   labelKey: 'llm.context_window.option.100k', hintKey: 'llm.context_window.option.100k_hint' },
		{ value: 200_000,   labelKey: 'llm.context_window.option.200k', hintKey: 'llm.context_window.option.200k_hint' },
		{ value: 500_000,   labelKey: 'llm.context_window.option.500k', hintKey: 'llm.context_window.option.500k_hint' },
		{ value: 1_000_000, labelKey: 'llm.context_window.option.1m',   hintKey: 'llm.context_window.option.1m_hint' },
	];

	const DEFAULT_OPTION = {
		value: undefined as number | undefined,
		labelKey: 'llm.context_window.option.default',
		hintKey: 'llm.context_window.option.default_hint',
		disabled: false,
		hidden: false,
	};

	// Settings v3 Item 8: show-all-grayed — above-native milestones render
	// disabled with a tooltip rather than vanishing, so users see WHY they
	// can't pick 1M on Sonnet base. Below-native and exact-native are still
	// filtered (hidden) to keep the list focused; PR 2 introduced this split
	// and PR 3 only flips the above-native branch from filtered to disabled.
	// Hide native-match milestone (redundant with "Default") UNLESS the user
	// explicitly saved that exact value — otherwise the bound radio would have
	// no match and silently render as "no selection" on re-load.
	const contextOptions = $derived([
		DEFAULT_OPTION,
		...buildContextOptions(activeModel?.contextWindow, CAP_MILESTONES).filter(
			(opt) => !opt.hidden || opt.value === config.max_context_window_tokens,
		),
	]);
</script>

<div class="space-y-6 {embedded ? '' : 'max-w-3xl mx-auto p-4'}">
	{#if !embedded}
		<a href="/app/settings/llm" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('llm.back_to_llm')}</a>
		<header>
			<h1 class="text-2xl font-semibold mb-1">{t('llm.advanced.title')}</h1>
			<p class="text-sm text-text-muted">{t('llm.advanced.subtitle')}</p>
		</header>
	{/if}

	{#if !loaded}
		<p class="text-sm text-text-muted">{t('cost_limits.loading')}</p>
	{:else}
		<!-- LLM mode (capability-gated, hidden on managed where it's admin-only). -->
		{#if mistralAvailable && !providerLocked}
			<fieldset class="space-y-2 border border-border rounded p-3">
				<legend class="px-1 text-xs font-medium uppercase tracking-wider text-text-muted">{t('config.llm_mode')}</legend>
				<p class="text-xs text-text-muted">{t('config.llm_mode_desc')}</p>
				<label class="flex items-start gap-3 p-2 rounded border border-border bg-bg cursor-pointer">
					<input type="radio" name="llm-mode" value="standard"
						checked={(config.llm_mode ?? 'standard') === 'standard'}
						onchange={() => { config.llm_mode = 'standard'; }}
						class="mt-1 accent-accent shrink-0" />
					<span class="text-sm">
						<span class="font-medium block">{t('config.llm_mode_standard')}</span>
						<span class="text-xs text-text-muted">{t('config.llm_mode_standard_desc')}</span>
					</span>
				</label>
				<label class="flex items-start gap-3 p-2 rounded border border-border bg-bg cursor-pointer">
					<input type="radio" name="llm-mode" value="eu-sovereign"
						checked={config.llm_mode === 'eu-sovereign'}
						onchange={() => { config.llm_mode = 'eu-sovereign'; }}
						class="mt-1 accent-accent shrink-0" />
					<span class="text-sm">
						<span class="font-medium block">{t('config.llm_mode_eu_sovereign')}</span>
						<span class="text-xs text-text-muted">{t('config.llm_mode_eu_sovereign_desc')}</span>
					</span>
				</label>
				<p class="text-xs text-text-muted italic">{t('config.llm_mode_restart_required')}</p>
			</fieldset>
		{/if}

		<section aria-labelledby="adv-reasoning-heading" class="space-y-4">
			<h2 id="adv-reasoning-heading" class="text-lg font-medium">{t('llm.advanced.reasoning_heading')}</h2>

			<label class="block">
				<span class="block text-sm font-medium mb-1">{t('config.effort')}</span>
				<span class="block text-xs text-text-muted mb-1">{t('config.effort_desc')}</span>
				<!-- 2026-05-24 UX-fix: removed the duplicate "Standard (vom Modell)"
				     option. It was identical-behavior to 'high' on chat (engine
				     default in agent.ts:271) but the UI suggested it was a
				     model-aware option, which the engine never actually was.
				     Default-selected is now 'high' so the dropdown matches the
				     (empfohlen) label. The pre-2026-05-24 "v1.6.0 fix" of
				     putting undefined first to guard against rendering as 'low'
				     is no longer needed — 'high' is now the explicit default. -->
				<select bind:value={config.effort_level} disabled={!loaded}
					class="w-full px-2 py-1 border border-border rounded bg-bg disabled:opacity-50">
					<option value="low">{t('config.effort_low')}</option>
					<option value="medium">{t('config.effort_medium')}</option>
					<option value="high">{t('config.effort_high')}</option>
					<option value="max">{t('config.effort_max')}</option>
				</select>
			</label>

			<!-- Thinking is Anthropic-only today. On Mistral / OpenAI-compat
			     providers the engine silently ignores the toggle (extended
			     thinking blocks aren't part of the OpenAI-compat wire format).
			     Hide the dropdown there so the UI doesn't suggest a choice
			     the user doesn't actually have. -->
			{#if activeModel?.features?.extendedThinking}
				<label class="block">
					<span class="block text-sm font-medium mb-1">{t('config.thinking')}</span>
					<span class="block text-xs text-text-muted mb-1">{t('config.thinking_desc')}</span>
					<select bind:value={config.thinking_mode} disabled={!loaded}
						class="w-full px-2 py-1 border border-border rounded bg-bg disabled:opacity-50">
						<option value="disabled">{t('config.thinking_disabled')}</option>
						<option value="adaptive">{t('config.thinking_adaptive')}</option>
					</select>
				</label>
			{:else if activeModel}
				<div class="text-xs text-text-muted italic px-2 py-1 border border-dashed border-border rounded">
					{t('config.thinking')}: {t('config.anthropic_only_hint')}
				</div>
			{/if}
		</section>

		<section aria-labelledby="adv-experience-heading" class="space-y-4 border-t border-border pt-6">
			<h2 id="adv-experience-heading" class="text-lg font-medium">{t('llm.advanced.experience_heading')}</h2>

			<label class="block">
				<span class="block text-sm font-medium mb-1">{t('config.experience')}</span>
				<span class="block text-xs text-text-muted mb-1">{t('config.experience_desc')}</span>
				<!-- 2026-05-24 UX-fix: removed duplicate "Standard (vom Modell)"
				     option. Engine semantics (session.ts:1007): only 'developer'
				     triggers special behavior — undefined and 'business' are
				     identical. Defaulting the dropdown to 'business' makes the
				     UI honest about what's actually happening. -->
				<select bind:value={config.experience} disabled={!loaded}
					class="w-full px-2 py-1 border border-border rounded bg-bg disabled:opacity-50">
					<option value="business">{t('config.experience_business')}</option>
					<option value="developer">{t('config.experience_developer')}</option>
				</select>
			</label>

			<!-- embedding_provider is not in MANAGED_USER_WRITABLE_CONFIG (http-api.ts) —
			     Item 8 (show-all-grayed, 2026-05-19): rendered disabled with a tooltip
			     on managed instead of hidden, so the user can see what's gated. The
			     silent-403 UX trap is now prevented by the disabled-input state. -->
			<label class="block" title={isManaged ? t('llm.advanced.embedding_provider_managed_tooltip') : undefined}>
				<span class="block text-sm font-medium mb-1">{t('config.embedding_provider')}</span>
				<select bind:value={config.embedding_provider} disabled={!loaded || isManaged}
					class="w-full px-2 py-1 border border-border rounded bg-bg disabled:opacity-50 disabled:cursor-not-allowed">
					<option value="onnx">{t('config.embedding_onnx')}</option>
				</select>
			</label>
		</section>

		<!-- Context window — was a temporary interim on CostLimits.svelte (P2-PR-C),
		     now lands at its final canonical home. CostLimits page was deleted in
		     P3-PR-X; the legacy URL 301-redirects to `/app/settings/workspace/limits`. -->
		<section aria-labelledby="adv-context-heading" class="border-t border-border pt-6">
			<h2 id="adv-context-heading" class="text-lg font-medium mb-1">{t('llm.context_window.heading')}</h2>
			<p class="text-xs text-text-muted mb-3">{t('llm.context_window.description')}</p>
			{#if activeModel}
				<!-- Settings v3 Item 6: surface the active model so the radio set
				     below makes sense ("why is there no 500K option?" → because
				     Sonnet caps at 200K). Single line, non-intrusive. -->
				<p class="text-xs text-text-muted mb-3 italic">
					{t('llm.context_window.active_model_label')}: <span class="font-mono not-italic">{activeModel.uiLabel}</span> ({formatContextWindow(activeModel.contextWindow)} {t('llm.context_window.native')})
				</p>
			{/if}
			<div class="space-y-2">
				{#each contextOptions as opt (opt.value ?? 'default')}
					<label class="flex items-start gap-3 {opt.disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}"
						title={opt.disabled && activeModel
							? `${t('llm.context_window.option.above_native_tooltip')} (${formatContextWindow(activeModel.contextWindow)} ${t('llm.context_window.native')}).`
							: undefined}>
						<input type="radio" name="llm-context-window" value={opt.value}
							bind:group={config.max_context_window_tokens}
							disabled={!loaded || opt.disabled} class="mt-1 disabled:opacity-50" />
						<div class="flex-1">
							<div class="text-sm font-medium">{t(opt.labelKey)}</div>
							<div class="text-xs text-text-muted">{t(opt.hintKey)}</div>
						</div>
					</label>
				{/each}
			</div>
		</section>

		<div class="flex justify-end">
			<button type="button" onclick={save} disabled={saving || !loaded}
				class="px-4 py-2 bg-accent text-accent-fg rounded hover:opacity-90 disabled:opacity-50">
				{saving ? t('llm.saving') : t('llm.save')}
			</button>
		</div>
	{/if}
</div>
