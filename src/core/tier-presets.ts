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
 *  - Fireworks (openai-compat) slots pin `provider:'openai'` + an
 *    (Mistral slots did the same; the `mistral()` helper was dropped with the EU
 *    preset on 2026-08-11 rather than kept unused — it returns with that preset.)
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
 * are harness-equivalent to Sonnet 5 on lynox long-horizon jobs.
 *
 * WHAT THE MAIN SLOT IS **NOT** CHOSEN BY, corrected 2026-08-10. This header used to
 * cite the WS2 wire-replay R1/R3 "orchestration floor" (does the main DELEGATE a
 * deep-worthy task?) as the direct measurement behind the main slot. Two things
 * broke that:
 *  1. The floor measures DELEGATION BEHAVIOUR, never answer quality. Its judge
 *     (`replay.ts:136`) classifies exactly two states — delegated vs started it
 *     itself — and `expect: 'escalate'` is, in the script's own words, "the
 *     HYPOTHESIS this replay has to confirm, not a result". A main that is
 *     STRONGER than the captured model is right to answer inline, and the floor
 *     scores that as failure.
 *  2. Proactive deep escalation is OFF. The code default is `'proactive-deep': false`
 *     (features.ts), read from `LYNOX_FEATURE_PROACTIVE_DEEP`; the control plane
 *     emits that per instance from its own `LYNOX_MANAGED_PROACTIVE_DEEP` (pro,
 *     `packages/managed/src/config.ts` — a subdomain allowlist, not a boolean), and
 *     that CP value was cleared fleet-wide on 2026-08-10. Both names are given
 *     because neither grep finds the other: the CP var does not appear in core.
 *     A main that never proactively delegates cannot be ranked on whether it does.
 * The floor stays a valid NEGATIVE signal at adequate n — Ministral 14B answered
 * deep-worthy tasks inline in 20 of 22 replays AND lost on R9 artefact quality,
 * which is two independent findings, not one. It is not a positive ranking signal,
 * and per-model rates below n≈8 are noise (GLM measured 0/2, then 1/2, then 2/8 on
 * the same body). Slot choices below therefore cite the /model-smoke chat sweep,
 * the fast-slot bench, and price — or say plainly that they are operator decisions.
 */
import type { ModelTier, TierSet, TierSlot } from '../types/index.js';
import type { TierPresetName } from '../contract/vocab.js';
import { isTierPresetName } from '../contract/vocab.js';

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
const fireworks = (model_id: string): Omit<TierSlot, 'api_key'> => ({ provider: 'openai', model_id, api_base_url: FIREWORKS_API_BASE });

// Keyed on the CONTRACT's name type, not `string`: that is what makes the two
// halves impossible to drift. A preset added here without a name in
// `TIER_PRESET_NAMES` fails to build, and a name added there without a preset
// here fails too (a Record must be total). The control plane validates incoming
// names against that same list, so a typo is a 400 rather than a tenant whose
// container will not boot.
//
// THE LADDER (reshaped 2026-08-10). Two Fireworks sets that differ in EXACTLY ONE
// slot — the main — plus an EU set and an Anthropic set:
//
//   ⚡ efficient     deepseek-flash · minimax-m3 · kimi-k3
//   ⚖️ balanced      deepseek-flash · glm-5p2    · kimi-k3
// (An EU-only set was drafted and PULLED on 2026-08-11: a preset whose identity
//  IS a residency promise must fail closed, and this one degraded silently to the
//  base provider when a Mistral slot was dropped, while the disclosure panel kept
//  showing the EU chips. See the security-gate findings on core#1185.)
//   💎 max-quality   haiku-4.5      · sonnet-5   · opus-5
//
// efficient→balanced buys a stronger main for 3.7× the output price ($1.20 → $4.40
// per M). That is the whole difference, and it is the slot that runs every turn —
// which is why it is the only axis worth a separate preset. Both Fireworks sets
// need `LYNOX_MANAGED_FIREWORKS_ENABLED`; without it a managed tenant sees only
// max-quality. Since 2026-08-10 the CP can also NAME a preset via
// `LYNOX_TIER_PRESET`, so that unlock no longer silently leaves an instance on
// default Anthropic routing.
export const TIER_PRESETS: Record<TierPresetName, TierPreset> = {
  // ⚡ efficient — the cheapest coherent set, and now genuinely the cheapest: open
  // weights on Fireworks, 1M context in the fast and deep slots (minimax-m3 is 512k
  // — see its registry entry; an earlier draft of this comment claimed 1M everywhere and was
  // contradicted by the catalog note this same PR wrote). The old set paid $7.50/M
  // output for a main (mistral-medium) that the /model-smoke sweep found weakest on
  // open turns, while its deep slot already routed here.
  //   fast  — deepseek-v4-flash: fast-bench HOLD at 89.1% literal recall against a
  //           90.4% haiku-4.5 reference, with the BEST judge score of the field
  //           (7.83 vs 7.13), at $0.14/$0.28 instead of haiku's $1/$5. This is the
  //           fast SLOT only — it was never benched as a main (rafael 2026-08-10).
  //   main  — minimax-m3: one of only two models in the sweep that re-verified
  //           figures against the web before answering (with kimi-k3), and the
  //           cheapest main in the field at $0.30/$1.20 — below qwen3.7-plus
  //           ($0.40/$1.60), which it also beat on sweep quality. Qwen is faster
  //           (4-7s vs 8-27s) and that is the only axis it wins; rafael 2026-08-10:
  //           "qualität ist aktuell höher gewichtet als geschwindigkeit".
  //   deep  — kimi-k3: best grounding in the sweep. Operator decision 2026-08-10 to
  //           pin it without a deep bench — see the guard note in
  //           tier-presets.test.ts; the evidence is the chat sweep, not a replay.
  // Everything here is CN-provenance served from the US Fireworks host — the
  // affirmative sourcing rule holds, and eu-sovereign below exists so that choice
  // stays explicit rather than hidden inside "efficient".
  efficient: {
    routing_mode: 'hybrid',
    tier_set: {
      fast: fireworks('accounts/fireworks/models/deepseek-v4-flash'),
      balanced: fireworks('accounts/fireworks/models/minimax-m3'),
      deep: fireworks('accounts/fireworks/models/kimi-k3'),
    },
  },
  // ⚖️ balanced — ⚡ efficient with a stronger main, and nothing else changed. Same
  // fast slot, same deep slot; GLM 5.2 replaces minimax-m3 in the band that runs
  // every turn, at $1.40/$4.40 against $0.30/$1.20. Buying quality in exactly one
  // slot is the point: it makes the upgrade legible ("the model you talk to gets
  // stronger") instead of shuffling three variables at once. Operator decision
  // (rafael 2026-08-10, "glm main auch") on the strength of the /model-smoke sweep,
  // where GLM grounded task state correctly and carried a 1M window.
  //
  // NOT chosen on the R1/R3 replay floor — see the header. GLM's escalation rate
  // there (2/8 on body-a) measures whether it DELEGATES, which is both noisy at that
  // n and moot while proactive deep escalation is off.
  //
  // ⚠️ CONSEQUENCE, stated because it is not obvious: like ⚡ efficient this is an
  // all-Fireworks set, so it requires `LYNOX_MANAGED_FIREWORKS_ENABLED` (a DPA-gated
  // sub-processor, OFF unless the CP opts an instance in). A managed tenant without
  // it sees only 🇪🇺 eu-sovereign and 💎 max-quality. Mistral Large 3 was the drafted
  // Fireworks-free alternative and was rejected on quality (rafael 2026-08-10:
  // "mistral large ist kein starker main"); no measurement of it as a main exists
  // either way — it was never in the sweep.
  balanced: {
    routing_mode: 'hybrid',
    tier_set: {
      fast: fireworks('accounts/fireworks/models/deepseek-v4-flash'),
      balanced: fireworks('accounts/fireworks/models/glm-5p2'),
      deep: fireworks('accounts/fireworks/models/kimi-k3'),
    },
  },
  // 💎 max-quality — all-Anthropic flagship set. Deep is Opus 5 ($5/$25), not Fable 5
  // ($10/$50): a preset is a default someone lands on, and Fable's rate is twice
  // Opus's for a slot that a sub-agent escalation can enter without a deliberate
  // choice (rafael 2026-08-10, "fable ist zu teuer um default zu sein"). Fable stays
  // selectable in the catalog for anyone who wants it explicitly.
  'max-quality': {
    routing_mode: 'hybrid',
    tier_set: {
      fast: anthropic('claude-haiku-4-5-20251001'),
      balanced: anthropic('claude-sonnet-5'),
      deep: anthropic('claude-opus-5'),
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
  // `isTierPresetName` narrows to the contract's union, which is what lets the
  // lookup below be a typed index instead of a `string` one. `Object.hasOwn`
  // stays: the two answer different questions — hasOwn keeps a prototype-chain
  // name out, the narrowing keeps the table's key type honest — and the
  // prototype guard is the one with the security reason above.
  if (!isTierPresetName(name)) return undefined;
  const preset = TIER_PRESETS[name];
  return { routing_mode: preset.routing_mode, tier_set: preset.tier_set };
}

/** One band where the live `tier_set` does not run what its `tier_preset` names.
 *  `null` on either side means "no slot for this band" — the preset does not
 *  pin it, or the managed constraints dropped the one it did. */
export interface TierPresetSlotDeviation {
  expected: string | null;
  actual: string | null;
}

/** A `tier_preset` name that no longer describes the set it labels. */
export interface TierPresetDeviation {
  /** The preset still named by `tier_preset` — kept, not nulled (see below). */
  preset: string;
  /** ONLY the bands that differ. Never empty: no differences ⇒ no deviation. */
  slots: Partial<Record<ModelTier, TierPresetSlotDeviation>>;
}

/**
 * Which bands of `effectiveTierSet` disagree with the preset `presetName` claims.
 *
 * A `tier_preset` is not a lock: an explicit `tier_set` slot overrides it
 * per-band by design, and the managed constraints may drop a band the CP cannot
 * back (`config.ts:485`, `:491`). That is correct behaviour — the defect is that
 * the NAME survives the override unchanged, so `tier_preset: "efficient"` can
 * label a hand mixture and nothing says so. Measured on a hosted test instance
 * 2026-08-11: the field read `efficient` (canonically three Fireworks models)
 * while the live set ran Mistral / Fireworks / **Anthropic** — and that last slot
 * pointed at a provider with no credit, so every deep escalation died. An
 * outage the label could not have shown.
 *
 * Direction (b) of the two the register weighed: keep the name and state the
 * deviation beside it. (a) — null the field on the first override — is more
 * honest in isolation but destroys the provenance the settings preset-cards need
 * to render at all, and a card that cannot name its preset is a worse regression
 * than a name that needs a footnote.
 *
 * Returns `undefined` when there is nothing to report: no preset named, an
 * unknown name (unreachable through `loadConfig`, which throws — defensive
 * here), or a set that matches its preset band for band. Absence is therefore
 * the machine-readable "this label is faithful", which is what keeps the caller
 * from having to diff two fields itself.
 *
 * Compares MODEL IDS only. The slot objects carry per-slot `api_key`s and this
 * result is serialized into `GET /api/config`, whose redaction pass only ever
 * sees the RAW file config — never the loader output this reads.
 */
export function tierPresetDeviation(
  presetName: string | undefined,
  effectiveTierSet: TierSet | undefined,
): TierPresetDeviation | undefined {
  if (!presetName) return undefined;
  const expanded = expandTierPreset(presetName);
  if (!expanded) return undefined;
  const slots: Partial<Record<ModelTier, TierPresetSlotDeviation>> = {};
  for (const tier of ['fast', 'balanced', 'deep'] as const) {
    const expected = expanded.tier_set[tier]?.model_id ?? null;
    const actual = effectiveTierSet?.[tier]?.model_id ?? null;
    if (expected !== actual) slots[tier] = { expected, actual };
  }
  return Object.keys(slots).length > 0 ? { preset: presetName, slots } : undefined;
}
