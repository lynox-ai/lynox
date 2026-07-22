<!--
  Header model picker (model-presets W4) — the new-chat model control, relocated
  from above the composer into the nav header to free composer space (rafael). A
  compact monochrome dropdown that offers only the BALANCED + DEEP tiers (the two
  main-chat candidates the settings strategy resolved to), each labelled with its
  concrete model ("Ausgewogen (Ministral 14B)"). Fast is intentionally omitted —
  it's the background/sub-task tier, not a main-chat choice.

  Same semantics as the former ComposerModelPicker: shown only on a NEW chat
  (parent gates on sessionId === null), no stickiness (re-mounts to default_tier
  on each new chat), sets `pendingModel` for turn 1. The engine still clamps
  server-side, so this is a UX filter, not the security boundary.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { loadTierConfig, type MainChatTiers } from '../utils/tier-config.js';
  import { availableComposerTiers, normalizeTier, type ModelTier } from '../utils/llm-main-model.js';
  import { setPendingModel } from '../stores/chat.svelte.js';
  import { t } from '../i18n.svelte.js';
  import Icon from '../primitives/Icon.svelte';

  // Balanced + deep only (drop fast — the background tier). Ordered balanced→deep.
  let tiers = $state<ModelTier[]>([]);
  let selected = $state<ModelTier>('balanced');
  let defaultTier = $state<ModelTier>('balanced');
  let modelNames = $state<MainChatTiers | undefined>(undefined);
  let loaded = $state(false);
  let open = $state(false);

  onMount(async () => {
    const cfg = await loadTierConfig();
    tiers = availableComposerTiers(cfg.maxTier).filter((tier) => tier !== 'fast');
    modelNames = cfg.mainChatTiers;
    defaultTier = normalizeTier(cfg.defaultTier) ?? 'balanced';
    // Default coerced into the balanced/deep set (a 'fast' default lands on balanced).
    selected = tiers.includes(defaultTier) ? defaultTier : (tiers[0] ?? 'balanced');
    // If the coercion moved off the default (default_tier='fast'), turn 1 would
    // otherwise route the un-set default while the header reads the coerced tier —
    // pin the pending model so display and routing agree.
    if (selected !== defaultTier) setPendingModel(selected);
    loaded = true;
  });

  function pick(tier: ModelTier): void {
    selected = tier;
    setPendingModel(tier);
    open = false;
  }

  // "Ausgewogen (Ministral 14B)" — the concrete model grounds the abstract tier.
  function tierLabel(tier: ModelTier): string {
    const model = modelNames?.[tier];
    return model ? `${t(`llm.tier.${tier}`)} (${model})` : t(`llm.tier.${tier}`);
  }
</script>

<!-- Hide when the provider has no distinct per-tier models (main_chat_tiers
     absent — a single-model custom provider) or when only one tier survives the
     ceiling: a one-option picker is noise. -->
{#if loaded && modelNames && tiers.length >= 2}
  <div class="relative">
    <button
      type="button"
      onclick={() => (open = !open)}
      class="flex items-center gap-1.5 text-xs text-text-subtle hover:text-text transition-colors rounded-[var(--radius-md)] border border-border px-2.5 py-1.5 max-w-[16rem]"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-label={t('chat.model_picker.label')}
    >
      <Icon name="brain" size="xs" />
      <span class="truncate">{tierLabel(selected)}</span>
      <Icon name="chevron_down" size="xs" />
    </button>
    {#if open}
      <!-- backdrop to close on outside click -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="fixed inset-0 z-40" onclick={() => (open = false)} onkeydown={() => {}}></div>
      <ul
        role="listbox"
        aria-label={t('chat.model_picker.label')}
        class="absolute right-0 top-full mt-1 z-50 min-w-[15rem] rounded-[var(--radius-md)] border border-border bg-bg shadow-lg py-1"
      >
        {#each tiers as tier (tier)}
          <li role="option" aria-selected={selected === tier}>
            <button
              type="button"
              onclick={() => pick(tier)}
              class="flex items-center gap-2 w-full px-3 py-2 text-xs text-left transition-colors {selected === tier ? 'text-accent-text bg-accent/10' : 'text-text-muted hover:text-text hover:bg-bg-muted'}"
            >
              <Icon name={tier === 'deep' ? 'gem' : 'scale'} size="xs" />
              <span class="flex-1 truncate">{tierLabel(tier)}</span>
              {#if tier === defaultTier}
                <span class="text-[10px] text-text-subtle">{t('chat.model_picker.recommended')}</span>
              {:else if tier === 'deep' && modelNames?.deep !== modelNames?.balanced}
                <!-- no "pricier" badge when the ladder tops out at balanced (same model) -->
                <span class="text-[10px] text-text-subtle">{t('chat.model_picker.pricier')}</span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}
