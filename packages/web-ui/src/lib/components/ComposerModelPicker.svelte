<script module lang="ts">
  import { getApiBase } from '../config.svelte.js';

  // The active provider's per-tier model labels ({fast,balanced,deep} → label),
  // or undefined when the provider has no distinct per-tier models (a
  // single-model custom / OpenAI-compat proxy). Undefined ⇒ hide the picker.
  type MainChatTiers = { fast?: string; balanced?: string; deep?: string };
  type TierConfig = {
    defaultTier: string | undefined;
    maxTier: string | undefined;
    mainChatTiers: MainChatTiers | undefined;
  };

  // Module-level cache: config rarely changes and the picker re-mounts on every
  // new chat, so fetch /api/config once. A settings change to default_tier takes
  // effect on the next full page load — acceptable for a new-chat default. Only a
  // SUCCESSFUL response is cached, so a transient failure (engine not ready yet)
  // retries on the next mount instead of pinning the picker to "no ceiling".
  let _cache: TierConfig | null = null;

  async function loadTierConfig(): Promise<TierConfig> {
    if (_cache) return _cache;
    try {
      const res = await fetch(`${getApiBase()}/config`);
      if (!res.ok) return { defaultTier: undefined, maxTier: undefined, mainChatTiers: undefined };
      const data = (await res.json()) as {
        default_tier?: string;
        max_tier?: string;
        main_chat_tiers?: MainChatTiers;
      };
      _cache = { defaultTier: data.default_tier, maxTier: data.max_tier, mainChatTiers: data.main_chat_tiers };
      return _cache;
    } catch {
      return { defaultTier: undefined, maxTier: undefined, mainChatTiers: undefined };
    }
  }
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
    if (tier === 'deep') return `${base} · ${t('chat.model_picker.pricier')}`;
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
