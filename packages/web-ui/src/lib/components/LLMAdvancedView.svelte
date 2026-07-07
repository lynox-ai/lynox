<!--
	LLM Advanced (PRD-IA-V2 P3-PR-C) — canonical home for the provider-adjacent
	dials that previously lived as collapsible panels on LLMSettings (effort,
	thinking, llm_mode, embedding_provider, experience). Backend SSoT stays
	`/api/config`; this surface PUTs the same fields the legacy locations did,
	so a stale tab cannot drift state.

	The Sonnet-variant picker (`balanced_model`) moved to the main "Main chat
	model" picker on LLMSettings — a served Sonnet is just one balanced-band
	choice there. The context-window radios (`max_context_window_tokens`) were
	removed entirely: every model now uses its native window, so a user-facing
	cap is redundant; the field stays honored as a config-file-only escape hatch
	(superseded by `compaction_token_budget`).

	Tier-awareness audit (Settings v3 Item 2, 2026-05-19):
	| Setting              | Self-host | BYOK | Managed |
	|----------------------|-----------|------|---------|
	| llm_mode             | ✓         | ✓    | ✗ admin-only |
	| effort_level         | ✓         | ✓    | ✓        |
	| thinking_mode        | ✓         | ✓    | ✓        |
	| experience           | ✓         | ✓    | ✓        |
	| embedding_provider   | ✓         | ✓    | ✗ silent-403 → hidden |

	Managed-tier gotchas baked in:
	- `embedding_provider` is NOT in MANAGED_USER_WRITABLE_CONFIG (silent-403
	  on managed) → hidden behind `isManaged`.
	- `llm_mode` toggle is admin-only on managed per project_managed_llm_strategy
	  → hidden when `providerLocked` OR when Mistral capability is not wired.
-->
<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';

	// Settings v3 PR 4.6 (2026-05-19) — `embedded=true` skips the page chrome
	// (back-link + h1 + subtitle) so this component can render inline inside
	// LLMSettings.svelte as an expandable section. Standalone /llm/advanced
	// page keeps `embedded=false` (default) for back-compat with deep links.
	// `pendingProvider` (2026-05-25, user feedback): when embedded inside
	// LLMSettings, the parent passes its in-flight tile selection so the
	// provider-aware sections (Nachdenken visibility, etc.) re-render the
	// moment the user clicks a tile — without waiting for save+restart.
	// Standalone (not embedded) leaves it undefined and the persisted
	// activeModel is the source of truth.
	let {
		embedded = false,
		pendingProvider = undefined,
	}: {
		embedded?: boolean;
		pendingProvider?: 'anthropic' | 'vertex' | 'openai' | 'custom' | null | undefined;
	} = $props();

	interface UserConfig {
		experience?: 'business' | 'developer';
		effort_level?: 'low' | 'medium' | 'high' | 'max';
		thinking_mode?: 'adaptive' | 'disabled';
		embedding_provider?: 'onnx' | 'local';
		llm_mode?: 'standard' | 'eu-sovereign';
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
			};
			locks = body.locks ?? {};
			managed = body.managed === 'managed' || body.managed === 'managed_pro' || body.managed === 'eu';
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
			// `balanced_model` (Sonnet variant) + `max_context_window_tokens` moved
			// off this view — the main-chat picker owns the former; the latter is now
			// a config-file-only escape hatch (native windows made the UI knob moot).
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

	// Form-reactive provider-aware gating (2026-05-25, #51).
	// When embedded in LLMSettings, the parent passes its in-flight tile
	// selection so we can preview the gate result BEFORE save+restart.
	// Falls back to the persisted activeModel.features when no pending
	// state is available (standalone mode, or before parent first selects).
	// `vertex` ≡ Anthropic in capability terms (same Claude features).
	const effectiveExtendedThinking = $derived.by(() => {
		if (pendingProvider === 'anthropic' || pendingProvider === 'vertex') return true;
		if (pendingProvider === 'openai' || pendingProvider === 'custom') return false;
		return activeModel?.features?.extendedThinking ?? false;
	});

	$effect(() => { void load(); });
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
		<!-- 2026-05-24 UX-fix: removed LLM-MODE radio fieldset (Standard /
		     EU-Sovereign). It was a functional duplicate of the Provider tile
		     picker on the main LLM Settings page — both wrote to overlapping
		     state (`provider` + `llm_mode`) and on managed instances the user
		     saw two parallel controls for the same choice. The Provider tile
		     picker is now the single source. `llm_mode` config field stays
		     intact: managed-CP bootstrap reads it from env, and the engine
		     derives `provider`/`api_key`/`api_base_url` from it
		     (config.ts:190). Power-users can still set `llm_mode` directly
		     in ~/.lynox/config.json. -->


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
			{#if effectiveExtendedThinking}
				<label class="block">
					<span class="block text-sm font-medium mb-1">{t('config.thinking')}</span>
					<span class="block text-xs text-text-muted mb-1">{t('config.thinking_desc')}</span>
					<select bind:value={config.thinking_mode} disabled={!loaded}
						class="w-full px-2 py-1 border border-border rounded bg-bg disabled:opacity-50">
						<option value="disabled">{t('config.thinking_disabled')}</option>
						<option value="adaptive">{t('config.thinking_adaptive')}</option>
					</select>
				</label>
			{:else if activeModel || pendingProvider}
				<div class="text-xs text-text-muted italic px-2 py-1 border border-dashed border-border rounded">
					{t('config.thinking')}: {t('config.anthropic_only_hint')}
				</div>
			{/if}
		</section>

		<section aria-labelledby="adv-experience-heading" class="space-y-4 border-t border-border pt-6">
			<h2 id="adv-experience-heading" class="text-lg font-medium">{t('llm.advanced.experience_heading')}</h2>

			<!-- 2026-05-24 UX-hide: Business/Developer experience toggle hidden
			     pre-HN-launch. The 'developer' mode appends DEVELOPER_PROMPT_SUFFIX
			     (CLI commands, env vars, JSON schemas) at session.ts:1007 — wired
			     but functionally untested. Hiding the UI reduces HN bug-report
			     surface; the engine code stays so power-users can set
			     `experience: 'developer'` directly in ~/.lynox/config.json. The
			     diff-based save() preserves any existing user value untouched. -->

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

		<!-- The Sonnet-variant picker (Sonnet 4.6 ↔ 5) moved to the main "Main chat
		     model" picker on the LLM Settings page — a served-Sonnet is just one
		     balanced-band choice there. The `balanced_model` config field is
		     unchanged; this view no longer owns it.

		     The context-window radios were removed too: every model now uses its
		     native window (`resolveNativeContextWindow`), so a user-facing cap is
		     redundant. `max_context_window_tokens` stays honored as a config-file-
		     only escape hatch (superseded by `compaction_token_budget`); it simply
		     has no UI control anymore. -->

		<div class="flex justify-end">
			<button type="button" onclick={save} disabled={saving || !loaded}
				class="px-4 py-2 bg-accent text-accent-fg rounded hover:opacity-90 disabled:opacity-50">
				{saving ? t('llm.saving') : t('llm.save')}
			</button>
		</div>
	{/if}
</div>
