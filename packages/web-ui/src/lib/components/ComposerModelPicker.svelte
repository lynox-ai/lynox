<script module lang="ts">
  import { getApiBase } from '../config.svelte.js';

  // Module-level cache: config rarely changes and the picker re-mounts on every
  // new chat, so fetch /api/config once. A settings change to default_tier takes
  // effect on the next full page load — acceptable for a new-chat default. Only a
  // SUCCESSFUL response is cached, so a transient failure (engine not ready yet)
  // retries on the next mount instead of pinning the picker to "no ceiling".
  let _cache: { defaultTier: string | undefined; maxTier: string | undefined } | null = null;

  async function loadTierConfig(): Promise<{ defaultTier: string | undefined; maxTier: string | undefined }> {
    if (_cache) return _cache;
    try {
      const res = await fetch(`${getApiBase()}/config`);
      if (!res.ok) return { defaultTier: undefined, maxTier: undefined };
      const data = (await res.json()) as { default_tier?: string; max_tier?: string };
      _cache = { defaultTier: data.default_tier, maxTier: data.max_tier };
      return _cache;
    } catch {
      return { defaultTier: undefined, maxTier: undefined };
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
  security boundary. Model-name enrichment + hiding for single-model custom
  providers are deferred (DEF-0082).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { availableComposerTiers, normalizeTier, type ModelTier } from '../utils/llm-main-model.js';
  import { setPendingModel } from '../stores/chat.svelte.js';
  import { t } from '../i18n.svelte.js';

  let tiers = $state<ModelTier[]>([]);
  let selected = $state<ModelTier>('balanced');
  let loaded = $state(false);

  onMount(async () => {
    const cfg = await loadTierConfig();
    tiers = availableComposerTiers(cfg.maxTier);
    // Default to the configured default_tier, coerced into the available set
    // (a default above the ceiling shouldn't be pre-selected).
    const def = normalizeTier(cfg.defaultTier) ?? 'balanced';
    selected = tiers.includes(def) ? def : (tiers[0] ?? 'balanced');
    loaded = true;
  });

  function onChange(e: Event): void {
    const val = (e.currentTarget as HTMLSelectElement).value as ModelTier;
    selected = val;
    setPendingModel(val);
  }
</script>

{#if loaded && tiers.length >= 2}
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
        <option value={tier}>{t(`llm.tier.${tier}`)}</option>
      {/each}
    </select>
  </div>
{/if}
