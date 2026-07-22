<!--
  Per-thread model control (P1 §5.1b) — the RUNNING-thread counterpart to
  ComposerModelPicker. It reverses D1 ("the model is fixed for the conversation"):
  D18 makes a pick STICKY per thread, and this control is how the user changes it
  mid-conversation ("historische Chats auf anderem Modell weiterführen"). It doubles
  as the U2 visibility indicator — a sticky `deep` thread bills `deep` on resume, so
  showing "Läuft auf {tier}" prevents a silent cost surprise.

  Shown only once a session exists (the composer picker owns the empty-chat case)
  and only when the provider has distinct per-tier models (`main_chat_tiers` present)
  — a single-model custom/OpenAI-compat provider gets no fake 3-way control. Disabled
  while a run streams (a swap mid-turn is refused server-side with 409 anyway). The
  server clamps + guards (resolveRunModel + the downgrade-overflow pre-check), so this
  is UX, not the boundary; a refused downgrade surfaces the overflow copy inline.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { availableComposerTiers, normalizeTier, type ModelTier } from '../utils/llm-main-model.js';
  import { loadTierConfig, type MainChatTiers } from '../utils/tier-config.js';
  import { getSessionId, getSessionTier, getIsStreaming, repickSessionModel } from '../stores/chat.svelte.js';
  import { getDemoMode } from '../config.svelte.js';
  import { t } from '../i18n.svelte.js';

  let tiers = $state<ModelTier[]>([]);
  let defaultTier = $state<ModelTier>('balanced');
  let modelNames = $state<MainChatTiers | undefined>(undefined);
  let loaded = $state(false);
  let notice = $state<string | null>(null);
  let hint = $state<string | null>(null);
  let pending = $state(false);

  onMount(async () => {
    const cfg = await loadTierConfig();
    tiers = availableComposerTiers(cfg.maxTier);
    modelNames = cfg.mainChatTiers;
    defaultTier = normalizeTier(cfg.defaultTier) ?? 'balanced';
    loaded = true;
  });

  // The live thread tier (never a model-id — see getSessionTier), coerced into the
  // available set. undefined before a session exists → the control hides.
  const currentTier = $derived(normalizeTier(getSessionTier() ?? undefined));
  const show = $derived(
    loaded && getSessionId() !== null && !!modelNames && tiers.length >= 2 && currentTier !== undefined,
  );

  // Clear any transient message when the thread changes. ChatView renders this
  // control under a plain `{:else}` (not a keyed block), so a thread switch does
  // NOT remount it — only its bound tier re-derives. Without this, thread A's
  // one-time cache-hint (or an error notice) would linger on thread B's control:
  // a misleading cost signal on a thread the user never changed. Reads the session
  // id so the effect re-runs on every switch; a same-thread re-pick keeps its hint.
  $effect(() => {
    getSessionId();
    notice = null;
    hint = null;
  });

  // The cache-hint warns about the ONE next reply re-processing the conversation
  // after a mid-thread model switch (the one-time cost bump). Once that reply has
  // streamed — isStreaming goes true→false — the warning is stale and must clear,
  // instead of lingering until the user happens to switch models again. `prev` is
  // a plain (non-reactive) local so this effect depends only on getIsStreaming().
  let prevStreaming = false;
  $effect(() => {
    const streaming = getIsStreaming();
    if (prevStreaming && !streaming) hint = null;
    prevStreaming = streaming;
  });

  function tierLabel(tier: ModelTier): string {
    const model = modelNames?.[tier];
    const base = model ? `${t(`llm.tier.${tier}`)} (${model})` : t(`llm.tier.${tier}`);
    if (tier === defaultTier) return `${base} · ${t('chat.model_picker.recommended')}`;
    // The "pricier" marker is a cost signal — suppress it where the user does not
    // bear the LLM cost (demo / CP-paid), mirroring the usage-footer's
    // `!getDemoMode()` gate so cost framing stays consistent across the UI; and
    // where the ladder tops out at balanced (deep == balanced model, no surcharge).
    if (tier === 'deep' && !getDemoMode() && modelNames?.deep !== modelNames?.balanced) return `${base} · ${t('chat.model_picker.pricier')}`;
    return base;
  }

  // Revert the <select> to the actual current tier — a rejected pick must not leave
  // the control showing a tier the thread isn't running on.
  function revert(el: HTMLSelectElement): void {
    el.value = currentTier ?? defaultTier;
  }

  async function onChange(e: Event): Promise<void> {
    const el = e.currentTarget as HTMLSelectElement;
    const val = el.value as ModelTier;
    notice = null;
    hint = null;
    if (val === currentTier) return;
    if (getIsStreaming()) { notice = t('chat.thread_model.busy'); revert(el); return; }
    pending = true;
    const result = await repickSessionModel(val);
    pending = false;
    if (result.ok) {
      // A mid-thread model switch invalidates the model-specific prompt cache, so
      // the next reply re-processes the whole conversation once (a one-time cost
      // bump). Surface that honestly — but only where the user bears the cost
      // (suppressed on demo / CP-paid tenants, mirroring the usage-footer gate).
      if (!getDemoMode()) hint = t('chat.thread_model.cache_hint');
      return; // sessionTier updated → the bound value reflects the new tier
    }
    if (result.reason === 'overflow') {
      notice = t('chat.thread_model.overflow').replace('{tier}', t(`llm.tier.${result.targetTier}`));
    } else if (result.reason === 'busy') {
      notice = t('chat.thread_model.busy');
    } else {
      notice = t('chat.thread_model.error');
    }
    revert(el);
  }
</script>

{#if show}
  <div class="max-w-3xl lg:max-w-4xl xl:max-w-5xl mx-auto mb-1.5 px-1 text-xs text-text-subtle">
    <div class="flex items-center gap-2">
      <label for="thread-model-control" class="shrink-0">{t('chat.thread_model.label')}</label>
      <select
        id="thread-model-control"
        value={currentTier}
        onchange={onChange}
        disabled={pending || getIsStreaming()}
        class="bg-transparent border border-border/60 rounded-md px-2 py-1 text-text outline-none focus:border-accent cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        aria-label={t('chat.thread_model.change')}
        title={t('chat.thread_model.change')}
      >
        {#each tiers as tier (tier)}
          <option value={tier}>{tierLabel(tier)}</option>
        {/each}
      </select>
    </div>
    {#if notice}
      <p class="mt-1 text-warning" role="status">{notice}</p>
    {:else if hint}
      <p class="mt-1 text-text-subtle" role="status">{hint}</p>
    {/if}
  </div>
{/if}
