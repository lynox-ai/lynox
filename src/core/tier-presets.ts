/**
 * `tier_preset` — the combinator, packaged (PRD `model-presets.md`, Wave 2).
 *
 * A named hybrid strategy that materializes to `{routing_mode:'hybrid', tier_set}`
 * at config-load (the expander in `config.ts`). This module is the ONE shared
 * source of truth for that mapping: the `loadConfig` expander (W2, self-host) AND
 * the managed write-gate (W3) both import `TIER_PRESETS`, so the picker can never
 * advertise a preset the engine routes differently (the false-compliance the
 * write-gate exists to prevent).
 *
 * Slot shape — {provider, model_id, api_base_url?}:
 *  - Anthropic slots name the native provider only (default endpoint).
 *  - Mistral + Fireworks (openai-compat) slots pin `provider:'openai'` + an
 *    explicit `api_base_url`: the openai wire needs the endpoint to reach the
 *    right host (an omitted base URL defaults to OpenAI), and the self-host key
 *    resolves from that endpoint via `pinnedVaultSlotForEndpoint` (catalog.ts) —
 *    MISTRAL_API_KEY / FIREWORKS_API_KEY, no `api_key` in the preset. `'fireworks'`
 *    is NOT a registered provider descriptor, so a `provider:'fireworks'` slot
 *    would fall back to the anthropic wire — hence `'openai'` + the endpoint.
 *
 * CN-provenance models (GLM/DeepSeek) appear ONLY via the Fireworks host (US) —
 * the affirmative sourcing rule; never a direct-CN API. The host's data-processing
 * posture (residency / retention) is disclosed separately + R2-gated in
 * `host-disclosure.ts` — this module makes no retention claim.
 *
 * Model choice is driven by COST + SOVEREIGNTY + CONTEXT, not a quality claim:
 * the fitness harness cannot separate the strong fleet at reachable difficulty
 * (`DEF-model-fitness-frontier-hard`), so the cheap CN-via-Fireworks deep models
 * are harness-equivalent to Sonnet 5 on lynox long-horizon jobs. The main/balanced
 * slot, however, is now measured DIRECTLY (WS2 Session-faithful wire-replay, 2026-07-21):
 * Ministral 14B was the best tool-ROUTER but is BELOW the R1/R3 orchestration floor — on a
 * faithful replay of the real managed request it answers deep-worthy tasks INLINE (2/22
 * escalate across 3 tasks) instead of delegating. The main is now mistral-medium (clears
 * R1/R3 22/22 + R9 artefact quality, the fastest floor-clearer measured); this raises the
 * R8 per-turn cost since the main runs every turn.
 */
import type { ModelTier, TierSet, TierSlot } from '../types/index.js';
import { MISTRAL_API_BASE } from '../types/index.js';

/** Canonical Fireworks endpoint — mirrors the catalog `base_url_default`
 *  (catalog.ts). Exported so the managed write-gate + load-hardening (W3) pin the
 *  SAME host. A test asserts it equals the catalog value (catches a path drift the
 *  host-only allowlist would miss) and that every preset endpoint is allowlisted. */
export const FIREWORKS_API_BASE = 'https://api.fireworks.ai/inference/v1';

/**
 * Canary opt-in (model-presets W3): a MANAGED instance may route a preset's
 * Fireworks-hosted slot (⚡ efficient's deep model) ONLY when the operator sets
 * `LYNOX_MANAGED_FIREWORKS_ENABLED` in the CP env. Default OFF → broad managed
 * stays Anthropic/Mistral-only (Fireworks is a new sub-processor, DPA-gated); ON =
 * the rafael canary. Read via direct `process.env` (mirrors the config.ts boolean
 * -flag cluster); it is NOT a config field, so a tenant's project config cannot
 * self-grant it. Self-host is unaffected — this gate only runs on cp_supplied.
 */
export function managedFireworksEnabled(): boolean {
  const v = process.env['LYNOX_MANAGED_FIREWORKS_ENABLED'];
  return v === 'true' || v === '1';
}

/** A named hybrid strategy: config-sugar over `{routing_mode, tier_set}`. Slots
 *  omit `api_key` — self-host resolves it from the endpoint (pinnedVaultSlot). */
export interface TierPreset {
  routing_mode: 'hybrid';
  tier_set: Partial<Record<ModelTier, Omit<TierSlot, 'api_key'>>>;
}

const anthropic = (model_id: string): Omit<TierSlot, 'api_key'> => ({ provider: 'anthropic', model_id });
const mistral = (model_id: string): Omit<TierSlot, 'api_key'> => ({ provider: 'openai', model_id, api_base_url: MISTRAL_API_BASE });
const fireworks = (model_id: string): Omit<TierSlot, 'api_key'> => ({ provider: 'openai', model_id, api_base_url: FIREWORKS_API_BASE });

export const TIER_PRESETS: Record<string, TierPreset> = {
  // ⚡ efficient — cheapest coherent set: EU Mistral fast + the cheapest R1/R3+R9
  // floor-clearing main (mistral-medium; Ministral 14B was BELOW the floor — WS2), a
  // cheap 1M-context CN-via-Fireworks model for deep/big-context.
  efficient: {
    routing_mode: 'hybrid',
    tier_set: {
      fast: mistral('ministral-8b-2512'),
      balanced: mistral('mistral-medium-2604'),
      deep: fireworks('accounts/fireworks/models/glm-5p2'),
    },
  },
  // ⚖️ balanced — the default hybrid: Anthropic Haiku fast + an EU-Mistral main that
  // clears the R1/R3 orchestration floor (mistral-medium; Ministral 14B did NOT — WS2) +
  // Sonnet 5 deep. haiku-4.5 also clears the floor and is the Anthropic alternative for
  // the main, but that would collapse fast==main — mistral-medium keeps a genuine
  // fast→main→deep ladder and an EU-sovereign main.
  balanced: {
    routing_mode: 'hybrid',
    tier_set: {
      fast: anthropic('claude-haiku-4-5-20251001'),
      balanced: mistral('mistral-medium-2604'),
      deep: anthropic('claude-sonnet-5'),
    },
  },
  // 💎 max-quality — all-Anthropic flagship set. Deep = Fable 5, Anthropic's most
  // capable model (demanding reasoning + long-horizon agentic work); it is invoked
  // deliberately (sub-agent escalation), never the main chat, so its $10/$50 rate is
  // bounded. Opus stays selectable as a deep option in the catalog for those who prefer it.
  'max-quality': {
    routing_mode: 'hybrid',
    tier_set: {
      fast: anthropic('claude-haiku-4-5-20251001'),
      balanced: anthropic('claude-sonnet-5'),
      deep: anthropic('claude-fable-5'),
    },
  },
};

/** Expand a `tier_preset` name to its `{routing_mode, tier_set}`, or `undefined`
 *  if the name is unknown (the caller decides — the loadConfig expander throws). */
export function expandTierPreset(name: string): { routing_mode: 'hybrid'; tier_set: TierSet } | undefined {
  // `Object.hasOwn`, not a truthy `TIER_PRESETS[name]` lookup: a prototype-chain name
  // (`__proto__`, `constructor`, `toString`) resolves to a truthy Object.prototype member
  // via bracket access, which would slip past an unknown-name guard and expand to a
  // garbage `{routing_mode: undefined, tier_set: undefined}` (a silent routing wipe).
  if (!Object.hasOwn(TIER_PRESETS, name)) return undefined;
  const preset = TIER_PRESETS[name];
  if (!preset) return undefined;
  return { routing_mode: preset.routing_mode, tier_set: preset.tier_set };
}
