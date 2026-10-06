/**
 * The (endpoint, model) slots the tier presets pin, outside the `.test.ts` file so the
 * offline check (tests/online-guards.test.ts) can import it without registering the online suite.
 */
import { TIER_PRESETS } from '../../src/core/tier-presets.js';
import type { TierSlot } from '../../src/types/index.js';

export const FIREWORKS_HOST = 'api.fireworks.ai';

/** Every distinct (endpoint, model) a preset pins, with the presets that pin it. */
export function pinnedSlots(): Array<{ modelId: string; baseUrl: string; presets: string[] }> {
  const byKey = new Map<string, { modelId: string; baseUrl: string; presets: Set<string> }>();
  for (const [presetName, preset] of Object.entries(TIER_PRESETS)) {
    for (const slot of Object.values(preset.tier_set) as Array<TierSlot | undefined>) {
      if (!slot?.model_id || !slot.api_base_url) continue;
      const key = `${slot.api_base_url}::${slot.model_id}`;
      const entry = byKey.get(key) ?? { modelId: slot.model_id, baseUrl: slot.api_base_url, presets: new Set<string>() };
      entry.presets.add(presetName);
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()].map(e => ({ modelId: e.modelId, baseUrl: e.baseUrl, presets: [...e.presets].sort() }));
}
