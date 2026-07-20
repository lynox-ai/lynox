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
// per-thread model control (P1 §5.1b). A settings change is picked up by
// `clearTierConfigCache()` (called on a successful settings save) so the pickers
// re-fetch the new per-tier model LABELS without a full page reload — otherwise a
// stale cache shows the OLD model for a tier the user just re-pointed (e.g. still
// "Ausgewogen (Mistral Large 3)" after switching balanced to Ministral 14B). Only
// a SUCCESSFUL response is cached, so a transient failure (engine not ready yet)
// retries on the next call instead of pinning to "no ceiling".
let _cache: TierConfig | null = null;

/** Invalidate the cache so the next `loadTierConfig()` re-fetches. Call after a
 *  settings save that changes routing/tier config, so the composer + header
 *  pickers reflect the new per-tier models immediately (no full page reload). */
export function clearTierConfigCache(): void {
  _cache = null;
}

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
