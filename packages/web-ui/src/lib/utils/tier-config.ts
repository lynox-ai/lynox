import { getApiBase } from '../config.svelte.js';

/** The active provider's per-tier model labels ({fast,balanced,deep} → label), or
 *  undefined when the provider has no distinct per-tier models (a single-model
 *  custom / OpenAI-compat proxy). Undefined ⇒ hide any tier picker. */
export type MainChatTiers = { fast?: string; balanced?: string; deep?: string };

export type TierConfig = {
  defaultTier: string | undefined;
  maxTier: string | undefined;
  mainChatTiers: MainChatTiers | undefined;
};

// Module-level cache: config rarely changes and the pickers re-mount often, so
// fetch /api/config once across BOTH the composer picker (new chat) and the
// per-thread model control (P1 §5.1b). A settings change to default_tier/max_tier
// takes effect on the next full page load — acceptable for a picker default. Only
// a SUCCESSFUL response is cached, so a transient failure (engine not ready yet)
// retries on the next call instead of pinning to "no ceiling".
let _cache: TierConfig | null = null;

export async function loadTierConfig(): Promise<TierConfig> {
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
