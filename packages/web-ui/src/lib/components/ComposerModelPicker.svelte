<script module lang="ts">
  import { loadTierConfig, type MainChatTiers } from '../utils/tier-config.js';
</script>

<!--
  Composer model picker (new-chat only). A thin control above the composer that
  lets the user choose the capability tier for THIS new chat — "das Modell nach
  Aufgabe wählen, nicht in den Settings". Shown only while the chat is empty
  (sessionId === null, owned by the parent); once the chat starts it disappears
  (D1: pick before turn 1). No stickiness — newChat() resets the pick to the
  configured default_tier (D2).

  Minimal by design: it offers the three capability TIERS (deep/balanced/fast),
  gated by the tenant's max_tier ceiling. The engine ALSO clamps server-side (the
  Session ctor delegates to resolveRunModel), so this is a UX filter, not the
  security boundary. Each tier is labelled with its concrete model (DEF-0082a,
  "Tief (Opus 4.6)") from the server's `main_chat_tiers`; when that field is
  absent (a single-model custom / OpenAI-compat provider whose tiers all resolve
  to one model) the picker hides entirely rather than offer three fake choices
  (DEF-0082b).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { availableComposerTiers, normalizeTier, type ModelTier } from '../utils/llm-main-model.js';
  import { setPendingModel } from '../stores/chat.svelte.js';
  import { t } from '../i18n.svelte.js';

  let tiers = $state<ModelTier[]>([]);
  let selected = $state<ModelTier>('balanced');
  let defaultTier = $state<ModelTier>('balanced');
  let modelNames = $state<MainChatTiers | undefined>(undefined);
  let loaded = $state(false);

  onMount(async () => {
    const cfg = await loadTierConfig();
    tiers = availableComposerTiers(cfg.maxTier);
    modelNames = cfg.mainChatTiers;
    // Default to the configured default_tier, coerced into the available set
    // (a default above the ceiling shouldn't be pre-selected).
    defaultTier = normalizeTier(cfg.defaultTier) ?? 'balanced';
    selected = tiers.includes(defaultTier) ? defaultTier : (tiers[0] ?? 'balanced');
    loaded = true;
  });

  function onChange(e: Event): void {
    const val = (e.currentTarget as HTMLSelectElement).value as ModelTier;
    selected = val;
    setPendingModel(val);
  }

  // Steer a non-technical user away from always picking the most expensive tier:
  // mark the configured default as recommended, and flag deep as pricier (unless
  // deep IS the default — then "recommended" wins, no double signal). Each tier
  // also carries its concrete model name ("Tief (Opus 4.6)") so the choice is
  // grounded in what actually runs, not an abstract capability word.
  function tierLabel(tier: ModelTier): string {
    const model = modelNames?.[tier];
    const base = model ? `${t(`llm.tier.${tier}`)} (${model})` : t(`llm.tier.${tier}`);
    if (tier === defaultTier) return `${base} · ${t('chat.model_picker.recommended')}`;
    // "pricier" only when deep actually runs a different model than balanced — a
    // ladder that tops out at its balanced pick (Mistral: both Medium 3.5) would
    // otherwise claim a surcharge that does not exist.
    if (tier === 'deep' && modelNames?.deep !== modelNames?.balanced) return `${base} · ${t('chat.model_picker.pricier')}`;
    return base;
  }
</script>

<!-- Hide when the provider has no distinct per-tier models (main_chat_tiers
     absent) — a single-model custom provider gets no fake 3-way picker. -->
{#if loaded && modelNames && tiers.length >= 2}
  <div class="max-w-3xl lg:max-w-4xl xl:max-w-5xl mx-auto mb-1.5 flex items-center gap-2 px-1 text-xs text-text-subtle">
    <label for="composer-model-picker" class="shrink-0">{t('chat.model_picker.label')}</label>
    <select
      id="composer-model-picker"
      value={selected}
      onchange={onChange}
      class="bg-transparent border border-border/60 rounded-md px-2 py-1 text-text outline-none focus:border-accent cursor-pointer"
      aria-label={t('chat.model_picker.label')}
    >
      {#each tiers as tier (tier)}
        <option value={tier}>{tierLabel(tier)}</option>
      {/each}
    </select>
  </div>
{/if}
