<!--
	LLM Advanced (PRD-IA-V2 P3-PR-C) — final canonical home for the
	provider-adjacent dials that previously lived as collapsible panels on
	LLMSettings (effort, thinking, llm_mode, embedding_provider, experience)
	and the context-window radio that took a temporary detour through
	CostLimits.svelte (P2-PR-C interim). Backend SSoT stays `/api/config`;
	this surface PUTs the same fields the legacy locations did, so a stale
	tab cannot drift state.

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

	let config = $state<UserConfig>({});
	let locks = $state<Locks>({});
	let managed = $state<boolean | null>(null);
	let mistralAvailable = $state<boolean>(false);
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
			};
			config = {
				experience: body.experience,
				effort_level: body.effort_level,
				thinking_mode: body.thinking_mode,
				embedding_provider: body.embedding_provider,
				llm_mode: body.llm_mode,
				max_context_window_tokens: body.max_context_window_tokens,
			};
			locks = body.locks ?? {};
			managed = body.managed === 'managed' || body.managed === 'managed_pro' || body.managed === 'eu';
			mistralAvailable = body.capabilities?.mistral_available === true;
			loaded = true;
		} catch (e) {
			addToast(e instanceof Error ? e.message : t('llm.load_failed'), 'error', 5000);
		}
	}

	async function save(): Promise<void> {
		if (!loaded) return;
		saving = true;
		try {
			// Per-field staging — `undefined` is a meaningful value for
			// max_context_window_tokens (= model default), so we send the field
			// whenever the key is present on `config` (the radio has been touched).
			const update: UserConfig = {};
			if (config.experience) update.experience = config.experience;
			if (config.effort_level) update.effort_level = config.effort_level;
			if (config.thinking_mode) update.thinking_mode = config.thinking_mode;
			// llm_mode and embedding_provider are provider-bound — only stage
			// when the UI was allowed to render them (lock + capability gates).
			if (config.llm_mode && !providerLocked) update.llm_mode = config.llm_mode;
			if (config.embedding_provider && !isManaged) update.embedding_provider = config.embedding_provider;
			if ('max_context_window_tokens' in config) {
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

	// Context-window radio options — mirrors `CONTEXT_OPTIONS` in CostLimits.svelte
	// (interim home) and the equivalent literal that used to live on LLMSettings.
	// All three surfaces PUT the same `max_context_window_tokens` field; this is
	// the final canonical home after P3-PR-X deletes CostLimits.
	const CONTEXT_OPTIONS: ReadonlyArray<{ value: number | undefined; labelKey: string; hintKey: string }> = [
		{ value: undefined,  labelKey: 'llm.context_window.option.default', hintKey: 'llm.context_window.option.default_hint' },
		{ value: 200_000,    labelKey: 'llm.context_window.option.200k',    hintKey: 'llm.context_window.option.200k_hint' },
		{ value: 500_000,    labelKey: 'llm.context_window.option.500k',    hintKey: 'llm.context_window.option.500k_hint' },
		{ value: 1_000_000,  labelKey: 'llm.context_window.option.1m',      hintKey: 'llm.context_window.option.1m_hint' },
	];
</script>

<div class="space-y-6 max-w-3xl mx-auto p-4">
	<a href="/app/settings/llm" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('llm.back_to_llm')}</a>
	<header>
		<h1 class="text-2xl font-semibold mb-1">{t('llm.advanced.title')}</h1>
		<p class="text-sm text-text-muted">{t('llm.advanced.subtitle')}</p>
	</header>

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
				<select bind:value={config.effort_level} disabled={!loaded}
					class="w-full px-2 py-1 border border-border rounded bg-bg disabled:opacity-50">
					<option value="low">{t('config.effort_low')}</option>
					<option value="medium">{t('config.effort_medium')}</option>
					<option value="high">{t('config.effort_high')}</option>
					<option value="max">{t('config.effort_max')}</option>
				</select>
			</label>

			<label class="block">
				<span class="block text-sm font-medium mb-1">{t('config.thinking')}</span>
				<span class="block text-xs text-text-muted mb-1">{t('config.thinking_desc')}</span>
				<select bind:value={config.thinking_mode} disabled={!loaded}
					class="w-full px-2 py-1 border border-border rounded bg-bg disabled:opacity-50">
					<option value="disabled">{t('config.thinking_disabled')}</option>
					<option value="adaptive">{t('config.thinking_adaptive')}</option>
				</select>
			</label>
		</section>

		<section aria-labelledby="adv-experience-heading" class="space-y-4 border-t border-border pt-6">
			<h2 id="adv-experience-heading" class="text-lg font-medium">{t('llm.advanced.experience_heading')}</h2>

			<label class="block">
				<span class="block text-sm font-medium mb-1">{t('config.experience')}</span>
				<span class="block text-xs text-text-muted mb-1">{t('config.experience_desc')}</span>
				<select bind:value={config.experience} disabled={!loaded}
					class="w-full px-2 py-1 border border-border rounded bg-bg disabled:opacity-50">
					<option value="business">{t('config.experience_business')}</option>
					<option value="developer">{t('config.experience_developer')}</option>
				</select>
			</label>

			{#if !isManaged}
				<!-- embedding_provider is not in MANAGED_USER_WRITABLE_CONFIG (http-api.ts) —
				     hidden on managed to avoid the silent-403 UX trap. -->
				<label class="block">
					<span class="block text-sm font-medium mb-1">{t('config.embedding_provider')}</span>
					<select bind:value={config.embedding_provider} disabled={!loaded}
						class="w-full px-2 py-1 border border-border rounded bg-bg disabled:opacity-50">
						<option value="onnx">{t('config.embedding_onnx')}</option>
					</select>
				</label>
			{/if}
		</section>

		<!-- Context window — was a temporary interim on CostLimits.svelte (P2-PR-C),
		     now lands at its final canonical home. CostLimits-Page deprecation banner
		     points users here; the page itself stays live until P3-PR-X deletes it. -->
		<section aria-labelledby="adv-context-heading" class="border-t border-border pt-6">
			<h2 id="adv-context-heading" class="text-lg font-medium mb-1">{t('llm.context_window.heading')}</h2>
			<p class="text-xs text-text-muted mb-3">{t('llm.context_window.description')}</p>
			<div class="space-y-2">
				{#each CONTEXT_OPTIONS as opt (opt.value ?? 'default')}
					<label class="flex items-start gap-3 cursor-pointer">
						<input type="radio" name="llm-context-window" value={opt.value}
							bind:group={config.max_context_window_tokens}
							disabled={!loaded} class="mt-1 disabled:opacity-50" />
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
