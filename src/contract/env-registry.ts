/**
 * Cross-repo env-ABI registry — SINGLE SOURCE OF TRUTH for every environment
 * variable that crosses the control-plane → engine wire.
 *
 * VENDORED DOWNSTREAM — edit ONLY here (`core/src/contract/`; a vendored copy
 * of this file is read-only, synced via the consumer's sync script). The
 * private control plane vendors a byte-identical copy and drives its
 * emit-matrix test off these rows; core generates forward (row → real read
 * site) and reverse (read → row) drift tests from them
 * (`tests/contract-env.test.ts`). Imports nothing outside `src/contract/`
 * (only `vocab.ts`).
 *
 * WHY: the emit side lives in the private control plane, the consume side in
 * this repo; each repo only tested its own half, which is how three real bugs
 * shipped (a consumed-but-never-emitted tier var, two emitted-but-unread
 * worker vars, one documented phantom). The registry pins BOTH halves.
 *
 * Row semantics:
 * - `emitPolicy` — the CP's emit stance. `operator-only`: the engine reads it
 *   but the CP must NOT emit it (an operator/self-host knob). `denylist`: must
 *   never be emitted (phantom guard / parked feature).
 * - `engineConsumed` — the read form + repo-relative READ SITE the forward test
 *   asserts. `sdk-internal` is the only consuming kind without a readSite
 *   (consumed inside SDK constructors — justify in `note`). `none` = not read
 *   by the engine at all; the forward test asserts ABSENCE from the read
 *   inventory. `pair-resolver` = read as one half of a credential PAIR via
 *   the `resolveClientPair` helper. `pair` names BOTH members of one credential,
 *   as DATA: each member's row declares the same descriptor, so which two names
 *   belong together is readable here without parsing code.
 *
 *   This file deliberately does NOT describe what the forward test asserts from
 *   that, nor what core's compile welds do. Three attempts to summarise it here
 *   each shipped a false sentence — the mechanisms live in other files and move
 *   independently of this one, so a summary written here is stale the moment
 *   either changes. `tests/contract-env.test.ts` documents its own form,
 *   and `src/core/google-client-pair-welds.ts` documents what it welds.
 *
 *   The direct `process.env` form is accepted only at `alsoReadAt` sites, so the
 *   primary read site stays pinned to the resolver.
 * - `secret.redact` — `exact-name`: the env-preview masks this key's value.
 *   `whole-value`: the value embeds secrets under OTHER names (e.g. a JSON
 *   blob with api_key fields) and must be masked as a whole.
 * - `secret.preserveAcrossSyncEnv` — per-provisioning secret that cannot be
 *   regenerated; sync-env must carry it over from the existing .env.
 * - `skewPolicy` — what an OLDER engine does when it receives the var; absent
 *   means "unknown names are ignored" (the env default).
 * - Ops intel (where a secret is retrievable, emit-site internals) stays in
 *   the control plane's manifest layer — `note` carries wire-relevant facts.
 */

import type { BillingTier } from './vocab.js';

/** The value-vocabulary an emitted var carries. */
export type EnvValueKind =
  | 'opaque' // free-form (secrets, ids, ports, locales) — not vocab-checked
  | 'billing-tier' // hosted|managed|managed_pro|managed_max (+ legacy starter|eu)
  | 'model-tier' // fast|balanced|deep (+ legacy haiku|sonnet|opus)
  | 'account-tier' // standard|pro
  | 'llm-provider' // anthropic|openai|vertex|custom
  | 'network-policy' // allow-all|allow-list|deny-all|guarded
  | 'usd-amount' // stringified non-negative number
  | 'bool' // 'true' | '1'
  | 'bool-off' // '0' | 'false' — a flag the CP pins OFF, against an engine default of on
  | 'url' // http(s) URL
  | 'json'; // serialized JSON object

export type EmitPolicy =
  | 'always' // emitted unconditionally for every provisioned tier
  | 'tier' // emitted unconditionally for the tiers in `requiredForTier`
  | 'when-true' // emitted only when the per-tenant flag is true (false never clobbers a hand-flipped .env)
  | 'when-non-default' // emitted only when configured / non-default / present
  | 'operator-only' // engine read exists; the CP must NOT emit
  | 'denylist'; // must never be emitted (phantom / parked)

export type EngineReadKind =
  | 'config' // process.env['NAME'] in src/core/config.ts (loadConfig)
  | 'features' // feature-flag literal in src/core/features.ts
  | 'env-alias' // readEnvAlias('NAME') / envTier('NAME') via src/core/env.ts
  | 'env-float' // envFloat('NAME')
  | 'direct' // process.env read at an arbitrary core site
  | 'pair-resolver' // resolveClientPair(<branded pair descriptor>) — one half of a credential pair
  | 'web-ui' // read inside packages/web-ui/src (runs in the engine process)
  | 'sdk-internal' // consumed inside an SDK constructor — no greppable readSite
  | 'none'; // not read by the engine (denylisted phantoms)

export interface EngineConsumption {
  kind: EngineReadKind;
  /** Repo-relative file whose read the forward drift test asserts. */
  readSite?: string;
  /** Additional read sites the forward test also asserts (e.g. web-ui next to core). */
  alsoReadAt?: string[];
  /** For `pair-resolver` rows: both members of the pair. */
  pair?: { id: string; secret: string };
  /**
   * For `features` rows: the flag slug + a real consumer call-site. The forward
   * test asserts BOTH the env-name map entry in features.ts AND
   * `isFeatureEnabled('<slug>')` at the consumer — a dead flag whose map entry
   * survives no longer passes.
   */
  featureFlag?: { slug: string; consumerSite: string };
}

export interface EnvRegistryRow {
  /** The exact env-var name on the wire. */
  name: string;
  valueKind: EnvValueKind;
  /** For `json` rows: the `shapes.ts` type both sides round-trip (fixture: `fixtures/model-profile.json`). */
  valueSchema?: 'ModelProfile';
  emitPolicy: EmitPolicy;
  engineConsumed: EngineConsumption;
  secret?: { redact: 'whole-value' | 'exact-name'; preserveAcrossSyncEnv?: boolean };
  /** Tiers for which the var is unconditionally present after the standard managed emit path. */
  requiredForTier?: BillingTier[];
  /** Legacy env names still accepted at read boundaries (src/core/env.ts ENV_ALIASES) — read-aliases are permanent. */
  legacyReadAliases?: string[];
  /** Behavior of an OLDER engine receiving this var, when it differs from "ignored". */
  skewPolicy?: string;
  note?: string;
}

const ALL_TIERS: BillingTier[] = ['hosted', 'managed', 'managed_pro', 'managed_max'];
const MANAGED_TIERS: BillingTier[] = ['managed', 'managed_pro', 'managed_max'];

export const ENV_REGISTRY: readonly EnvRegistryRow[] = [
  // ── Base secrets (all tiers) ──────────────────────────────────────────────
  { name: 'LYNOX_HTTP_SECRET', valueKind: 'opaque', emitPolicy: 'always', requiredForTier: ALL_TIERS, secret: { redact: 'exact-name', preserveAcrossSyncEnv: true }, engineConsumed: { kind: 'direct', readSite: 'src/server/http-api.ts', alsoReadAt: ['packages/web-ui/src/hooks.server.ts'] }, note: 'Cookie/session signing; the web-ui server hooks read it too (web-ui runs in the engine process).' },
  { name: 'LYNOX_HTTP_ADMIN_SECRET', valueKind: 'opaque', emitPolicy: 'always', requiredForTier: ALL_TIERS, secret: { redact: 'exact-name' }, engineConsumed: { kind: 'direct', readSite: 'src/server/http-api.ts' }, note: 'Two-tier auth admin scope. Re-emitted (not preserved) on sync-env.' },
  { name: 'LYNOX_VAULT_KEY', valueKind: 'opaque', emitPolicy: 'always', requiredForTier: ALL_TIERS, secret: { redact: 'exact-name', preserveAcrossSyncEnv: true }, engineConsumed: { kind: 'direct', readSite: 'src/core/engine-init.ts' } },
  { name: 'LYNOX_ONBOARDING_TOKEN', valueKind: 'opaque', emitPolicy: 'always', requiredForTier: ALL_TIERS, secret: { redact: 'exact-name', preserveAcrossSyncEnv: true }, engineConsumed: { kind: 'web-ui', readSite: 'packages/web-ui/src/routes/login/+page.server.ts' } },

  // ── Base wiring (all tiers) ───────────────────────────────────────────────
  { name: 'LYNOX_HTTP_PORT', valueKind: 'opaque', emitPolicy: 'always', requiredForTier: ALL_TIERS, engineConsumed: { kind: 'direct', readSite: 'src/index.ts' } },
  { name: 'SEARXNG_URL', valueKind: 'url', emitPolicy: 'always', requiredForTier: ALL_TIERS, engineConsumed: { kind: 'config', readSite: 'src/core/config.ts' } },
  { name: 'ORIGIN', valueKind: 'url', emitPolicy: 'always', requiredForTier: ALL_TIERS, engineConsumed: { kind: 'direct', readSite: 'src/index.ts' }, note: 'CSRF origin.' },

  // ── CP-link metadata (all tiers) ──────────────────────────────────────────
  { name: 'LYNOX_MANAGED_INSTANCE_ID', valueKind: 'opaque', emitPolicy: 'always', requiredForTier: ALL_TIERS, engineConsumed: { kind: 'direct', readSite: 'src/core/managed-hook.ts', alsoReadAt: ['packages/web-ui/src/routes/login/+page.server.ts'] } },
  { name: 'LYNOX_MANAGED_CONTROL_PLANE_URL', valueKind: 'url', emitPolicy: 'always', requiredForTier: ALL_TIERS, engineConsumed: { kind: 'direct', readSite: 'src/core/managed-hook.ts', alsoReadAt: ['packages/web-ui/src/routes/login/+page.server.ts'] } },
  { name: 'LYNOX_MANAGED_CUSTOMER_EMAIL', valueKind: 'opaque', emitPolicy: 'always', requiredForTier: ALL_TIERS, secret: { redact: 'exact-name' }, engineConsumed: { kind: 'web-ui', readSite: 'packages/web-ui/src/routes/login/+page.server.ts', alsoReadAt: ['packages/web-ui/src/routes/auth/passkey/+server.ts'] }, note: 'NOT an orphan — web-ui auth reads it. PII (customer email) → masked in the env-preview.' },

  // ── Tier / account / billing axis ─────────────────────────────────────────
  { name: 'LYNOX_BILLING_TIER', valueKind: 'billing-tier', emitPolicy: 'always', requiredForTier: ALL_TIERS, legacyReadAliases: ['LYNOX_MANAGED_MODE'], engineConsumed: { kind: 'env-alias', readSite: 'src/server/http-api.ts', alsoReadAt: ['src/core/engine.ts'] }, note: 'Canonical name; the engine reads it first and falls back to the legacy LYNOX_MANAGED_MODE alias forever.' },
  { name: 'LYNOX_ACCOUNT_TIER', valueKind: 'account-tier', emitPolicy: 'always', requiredForTier: ALL_TIERS, engineConsumed: { kind: 'config', readSite: 'src/core/config.ts' }, note: 'pro for managed_pro and managed_max. Since D8 the deep-gate is a pass-through — kept as the standard-vs-pro label; max_tier is the sole cost cap.' },

  // ── Model-tier axis (cost band) ───────────────────────────────────────────
  { name: 'LYNOX_DEFAULT_MODEL_TIER', valueKind: 'model-tier', emitPolicy: 'tier', requiredForTier: MANAGED_TIERS, legacyReadAliases: ['LYNOX_DEFAULT_TIER'], engineConsumed: { kind: 'env-alias', readSite: 'src/core/config.ts' }, note: 'The everyday SEED, not a lock — applied only when config.json has no default_tier; the user pick wins thereafter.' },
  { name: 'LYNOX_MAX_MODEL_TIER', valueKind: 'model-tier', emitPolicy: 'tier', requiredForTier: MANAGED_TIERS, legacyReadAliases: ['LYNOX_MAX_TIER'], engineConsumed: { kind: 'env-alias', readSite: 'src/core/config.ts' }, note: 'The CEILING (clampTier).' },
  { name: 'LYNOX_TIER_PRESET', valueKind: 'opaque', emitPolicy: 'when-non-default', engineConsumed: { kind: 'config', readSite: 'src/core/config.ts', alsoReadAt: ['src/server/http-api.ts'] }, note: 'Named hybrid strategy from the TIER_PRESETS table (e.g. "efficient") — the ROUTING axis (which model sits behind each band), orthogonal to LYNOX_{MAX,DEFAULT}_MODEL_TIER (which band). A SEED, not a lock: it fills an EMPTY config.json tier_preset and never overwrites a tenant pick, same shape as LYNOX_DEFAULT_MODEL_TIER. It DID overwrite until 2026-08-17, argued as an operator decision on DPA/cost grounds; measured on staging, that argument did not hold — a tenant writing explicit tier_set slots already beat the pin (config.json slots spread OVER the preset), so the rule bound only the settings picker, and there it failed SILENTLY: the write gate accepted the tenant preset, it persisted, /api/config reported it, and the loader discarded it. Emitted only when the CP pins one; unset = the engine keeps its own default routing, so an OLDER engine ignoring the var is the pre-change behaviour. A name THIS engine does not know is IGNORED with a warning and the instance keeps its default routing — deliberately NOT the fail-closed throw that a config.json name gets, because an unknown pin degrades to exactly the documented meaning of an unset one (no tier_set, no unregistered model, hence no Opus-rate fallback misbill), while a throw takes the container down with no tenant-side recovery. If the instance ALSO carries an unresolvable name in its own config.json, that one is dropped too rather than thrown on: the two fail together in a version skew, and rescuing one while throwing on the other leaves the same crash-loop with the same missing exit. A name that resolves but references a model absent from MODEL_CAPABILITIES still throws. An ignored pin is reported as `env_overrides.tier_preset_ignored` on GET /api/config, carrying the ESCAPED name (stripping a stray byte would rename an unresolvable pin into a known preset, destroying the evidence). The field covers the UNKNOWN-NAME case only: since the pin is a seed, the commoner way it has no effect is that the tenant already chose, and that is reported by `tier_preset` itself rather than by this marker. Note also that no UI consumes the field yet, and the crash it replaces used to be the operator signal by itself — the control-plane half is tracked separately. This paragraph used to assert the opposite AND to add "the CP API validates the name on write, so an invalid pin should not reach the fleet at all" — that reasoning does not survive deployment skew: the CP validates once at write time against ITS vendored copy of this file, then emits the value raw forever, while the fleet rolls out separately and pinned instances are skipped by rollouts indefinitely. Trusting an upstream that can be NEWER than the reader is what made this fatal instead of inert. Where a preset is unbacked (a Fireworks set without the credential) the managed constraints drop every slot AND clear the name, so the loader stops reporting a routing that is not running — visible on GET /api/config only where that surface reads the LOADER rather than the raw config file.' },
  { name: 'LYNOX_BLOCKED_MODEL_IDS', valueKind: 'opaque', emitPolicy: 'when-non-default', engineConsumed: { kind: 'config', readSite: 'src/core/config.ts' }, note: 'Comma-separated model-id PREFIXES (case-insensitive) the engine refuses to run — a per-model lock orthogonal to the max_tier cost band. Enforced at config load (tier_set slot drop), config write (403), and tier resolution (pinned id refusal; default resolution falls back to the fast tier). Emitted only when the CP locks specific models for an instance; unset/empty = nothing blocked (byte-identical default path). An OLDER engine ignores the var (skew default).' },

  // ── Cost guardrails ───────────────────────────────────────────────────────
  { name: 'LYNOX_MAX_SESSION_COST_USD', valueKind: 'usd-amount', emitPolicy: 'always', requiredForTier: ALL_TIERS, engineConsumed: { kind: 'env-float', readSite: 'src/core/engine-init.ts' } },
  { name: 'LYNOX_MAX_DAILY_COST_USD', valueKind: 'usd-amount', emitPolicy: 'always', requiredForTier: ALL_TIERS, engineConsumed: { kind: 'env-float', readSite: 'src/core/engine-init.ts' } },
  { name: 'LYNOX_MAX_MONTHLY_COST_USD', valueKind: 'usd-amount', emitPolicy: 'always', requiredForTier: ALL_TIERS, engineConsumed: { kind: 'env-float', readSite: 'src/core/engine-init.ts' } },
  { name: 'LYNOX_MANAGED_RUN_COST_CEILING_USD', valueKind: 'usd-amount', emitPolicy: 'tier', requiredForTier: MANAGED_TIERS, engineConsumed: { kind: 'direct', readSite: 'src/core/engine.ts' }, note: 'CP-owned per-run ceiling for the interactive path; engine clamps to [1,50]. CP-pays tiers only.' },

  // ── Provider key slots (SDK/ecosystem-canonical names) ────────────────────
  { name: 'ANTHROPIC_API_KEY', valueKind: 'opaque', emitPolicy: 'tier', requiredForTier: MANAGED_TIERS, secret: { redact: 'exact-name' }, engineConsumed: { kind: 'direct', readSite: 'src/core/engine-init.ts' }, note: 'SDK-canonical key slot — managed Anthropic-main. Also consumed inside the Anthropic SDK constructor and via the provider-keys slot map.' },
  { name: 'MISTRAL_API_KEY', valueKind: 'opaque', emitPolicy: 'tier', requiredForTier: MANAGED_TIERS, secret: { redact: 'exact-name' }, engineConsumed: { kind: 'direct', readSite: 'src/core/engine-init.ts' }, note: 'SDK-canonical key slot — worker profile + in-UI switch target; also read via the provider-keys slot map.' },
  { name: 'FIREWORKS_API_KEY', valueKind: 'opaque', emitPolicy: 'when-non-default', secret: { redact: 'exact-name' }, engineConsumed: { kind: 'direct', readSite: 'src/core/config.ts' }, note: 'Emitted only when the CP pool holds a Fireworks key (opt-in Efficient preset).' },
  { name: 'LYNOX_MANAGED_FIREWORKS_ENABLED', valueKind: 'bool', emitPolicy: 'when-true', engineConsumed: { kind: 'direct', readSite: 'src/core/tier-presets.ts' }, note: 'Unlocks the Fireworks slot for managed; emitted only alongside FIREWORKS_API_KEY (DPA-gated sub-processor).' },
  { name: 'LYNOX_FEATURE_PROACTIVE_DEEP', valueKind: 'bool', emitPolicy: 'when-true', engineConsumed: { kind: 'features', readSite: 'src/core/features.ts', featureFlag: { slug: 'proactive-deep', consumerSite: 'src/core/session.ts' } }, note: 'Fleet opt-in for proactive deep escalation; engine still cost-gates on the deep-slot provider.' },
  { name: 'LYNOX_FEATURE_PROACTIVE_DEEP_ANTHROPIC', valueKind: 'bool', emitPolicy: 'when-true', engineConsumed: { kind: 'features', readSite: 'src/core/features.ts', featureFlag: { slug: 'proactive-deep-anthropic', consumerSite: 'src/core/session.ts' } }, note: 'Allows proactive deep even on an Anthropic deep slot (premium).' },
  { name: 'LYNOX_FEATURE_WORKFLOW_REVIEWED_GRANT', valueKind: 'bool', emitPolicy: 'when-true', engineConsumed: { kind: 'features', readSite: 'src/core/features.ts', featureFlag: { slug: 'workflow-reviewed-grant', consumerSite: 'src/core/workflow-grant.ts' } }, note: 'Lets a person grant a saved workflow a reviewed write contract. Off by default in the engine, so a self-hosted instance turns it on itself; a control plane emits it per instance when its operator turns it on there.' },

  // ── OAuth app credentials (per provider) ──────────────────────────────────
  { name: 'GOOGLE_CLIENT_ID', valueKind: 'opaque', emitPolicy: 'operator-only', secret: { redact: 'exact-name' }, engineConsumed: { kind: 'pair-resolver', pair: { id: 'GOOGLE_CLIENT_ID', secret: 'GOOGLE_CLIENT_SECRET' }, readSite: 'src/core/engine.ts', alsoReadAt: ['src/core/engine-init.ts'] }, note: 'OAuth APP credential, not a user token. The value is public by construction — it travels in the browser redirect — and is still declared secret, because an undeclared key is masked fail-closed downstream and a row that opts OUT of that default needs a stronger reason than the value being harmless. Operators set it per deployment; no control plane emits it. The policy was briefly conditional, for a broker model in which the control plane would have handed each tenant a shared client pair — that model was dropped on 2026-08-26 in favour of the control plane exchanging tokens itself, so the pair never reaches a tenant and the row is operator-only again. Policy and emit site move together in BOTH directions: an emitting policy with no emit site, and an emit under a non-emitting policy, each fail their own side of the ABI check — which is why this row moves back rather than waiting for an emit that is not coming.' },
  { name: 'GOOGLE_CLIENT_SECRET', valueKind: 'opaque', emitPolicy: 'operator-only', secret: { redact: 'exact-name' }, engineConsumed: { kind: 'pair-resolver', pair: { id: 'GOOGLE_CLIENT_ID', secret: 'GOOGLE_CLIENT_SECRET' }, readSite: 'src/core/engine.ts', alsoReadAt: ['src/core/engine-init.ts'] }, note: 'The secret half of the GOOGLE_CLIENT_ID pair. Also read in src/core/secret-store.ts, but through process.env[envVar] with a VARIABLE, which no literal form can assert — not listed as a read site.' },

  // ── Worker / model-profiles bridge ────────────────────────────────────────
  { name: 'LYNOX_WORKER_PROFILE', valueKind: 'opaque', emitPolicy: 'tier', requiredForTier: MANAGED_TIERS, engineConsumed: { kind: 'config', readSite: 'src/core/config.ts' }, note: 'Names a profile key inside LYNOX_MODEL_PROFILES_JSON; engine clears a dangling one.' },
  { name: 'LYNOX_MODEL_PROFILES_JSON', valueKind: 'json', valueSchema: 'ModelProfile', emitPolicy: 'tier', requiredForTier: MANAGED_TIERS, secret: { redact: 'whole-value' }, engineConsumed: { kind: 'config', readSite: 'src/core/config.ts' }, note: 'JSON embeds provider keys in model_profiles[*].api_key → whole-value redaction (exact-name would miss it). Entries must satisfy shapes.ts isModelProfile.' },

  // ── Conditional / feature flags ───────────────────────────────────────────
  { name: 'LYNOX_BUGSINK_DSN', valueKind: 'opaque', emitPolicy: 'when-non-default', secret: { redact: 'exact-name' }, engineConsumed: { kind: 'direct', readSite: 'src/core/error-reporting.ts' } },
  { name: 'LYNOX_DEMO_MODE', valueKind: 'bool', emitPolicy: 'when-true', engineConsumed: { kind: 'web-ui', readSite: 'packages/web-ui/src/lib/server/demo-mode.ts' }, note: 'Demo tenants only. Consumed by the web-ui demo short-circuit, not by loadConfig.' },
  { name: 'LYNOX_DEMO_LOCALE', valueKind: 'opaque', emitPolicy: 'when-non-default', engineConsumed: { kind: 'web-ui', readSite: 'packages/web-ui/src/lib/server/demo-mode.ts', alsoReadAt: ['packages/web-ui/src/hooks.server.ts'] }, note: 'Demo tenants only.' },
  { name: 'LYNOX_SUBJECT_GRAPH_ENABLED', valueKind: 'bool', emitPolicy: 'when-true', engineConsumed: { kind: 'config', readSite: 'src/core/config.ts' }, note: 'Per-tenant; emitted only when true — a false column must not clobber a hand-flipped .env.' },
  { name: 'LYNOX_MEMORY_GRAPH_READS', valueKind: 'bool', emitPolicy: 'when-true', engineConsumed: { kind: 'config', readSite: 'src/core/config.ts' }, note: 'Per-tenant; co-gated on subject_graph_enabled.' },
  { name: 'LYNOX_MEMORY_SCORING_V2', valueKind: 'bool', emitPolicy: 'when-true', engineConsumed: { kind: 'config', readSite: 'src/core/config.ts' }, note: 'Per-tenant; emitted only when true.' },
  { name: 'LYNOX_RETRIEVAL_SHADOW_LOG', valueKind: 'bool', emitPolicy: 'when-true', engineConsumed: { kind: 'config', readSite: 'src/core/config.ts' }, note: 'Per-tenant; writes a plaintext shadow log — retention bound before fleet enablement.' },
  { name: 'LYNOX_MEMORY_WRITE_TRUST_GATE', valueKind: 'bool', emitPolicy: 'when-true', engineConsumed: { kind: 'config', readSite: 'src/core/config.ts' }, note: 'Per-tenant; operator-flipped (NOT project-safe).' },
  { name: 'LYNOX_DURABLE_MEMORY_ENABLED', valueKind: 'bool', emitPolicy: 'when-true', engineConsumed: { kind: 'config', readSite: 'src/core/config.ts' }, note: 'Per-tenant; OFF = byte-identical engine.' },
  { name: 'LYNOX_CALENDAR_ENABLED', valueKind: 'bool', emitPolicy: 'when-true', engineConsumed: { kind: 'config', readSite: 'src/core/config.ts' }, note: 'Per-tenant; OFF = the tool is not registered, so the decision space and the cached prefix are byte-identical.' },
  { name: 'LYNOX_STRIPE_PORTAL_LOGIN_URL', valueKind: 'url', emitPolicy: 'when-non-default', engineConsumed: { kind: 'direct', readSite: 'src/server/http-api.ts' } },
  { name: 'LYNOX_KG_EXTRACTOR', valueKind: 'opaque', emitPolicy: 'always', requiredForTier: ALL_TIERS, engineConsumed: { kind: 'direct', readSite: 'src/core/knowledge-layer.ts' } },
  { name: 'LYNOX_FEATURE_UNIFIED_INBOX', valueKind: 'bool', emitPolicy: 'always', requiredForTier: ALL_TIERS, engineConsumed: { kind: 'features', readSite: 'src/core/features.ts', featureFlag: { slug: 'unified-inbox', consumerSite: 'src/core/engine.ts' } } },
  { name: 'LYNOX_FEATURE_PLUGINS', valueKind: 'bool-off', emitPolicy: 'always', requiredForTier: ALL_TIERS, engineConsumed: { kind: 'features', readSite: 'src/core/features.ts', featureFlag: { slug: 'plugins', consumerSite: 'src/core/engine.ts' } }, note: 'Pinned OFF on every managed instance: managed instances load no plugins. The engine default stays on for self-hosters.' },
  { name: 'LYNOX_MIGRATION_TOKEN', valueKind: 'opaque', emitPolicy: 'when-non-default', secret: { redact: 'exact-name' }, engineConsumed: { kind: 'direct', readSite: 'src/server/http-api.ts' }, note: 'Only when the instance receives a migration.' },

  // ── Outbound egress posture ───────────────────────────────────────────────
  { name: 'LYNOX_NETWORK_POLICY', valueKind: 'network-policy', emitPolicy: 'when-non-default', engineConsumed: { kind: 'config', readSite: 'src/core/config.ts' }, skewPolicy: 'A pre-guarded engine drops the unknown `guarded` value to allow-all — the CP gates that emit behind the boot-marker capability check.', note: 'Emitted only for a non-default recognised value (never allow-all/null).' },
  { name: 'LYNOX_NETWORK_ALLOWED_HOSTS', valueKind: 'opaque', emitPolicy: 'when-non-default', engineConsumed: { kind: 'config', readSite: 'src/core/config.ts' }, note: 'Comma-separated operator floor; emitted only alongside a non-default policy and when non-empty.' },

  // ── Operator-only reads (the CP must NOT emit these) ─────────────────────
  { name: 'LYNOX_LLM_PROVIDER', valueKind: 'llm-provider', emitPolicy: 'operator-only', engineConsumed: { kind: 'config', readSite: 'src/core/config.ts' }, note: 'Self-host/BYOK operators set it themselves; the CP stopped emitting it with the eu-sovereign retirement (2026-06-13).' },
  { name: 'LYNOX_TIER_SET_JSON', valueKind: 'json', emitPolicy: 'operator-only', secret: { redact: 'whole-value' }, engineConsumed: { kind: 'config', readSite: 'src/core/config.ts' }, note: 'Operator tier-set override. Slots may embed per-tier api_key values → whole-value redaction, same class as LYNOX_MODEL_PROFILES_JSON. A future CP emit is a normal registry change (+ valueSchema hook).' },
  { name: 'LYNOX_DEBUG_WIRE_CAPTURE', valueKind: 'bool', emitPolicy: 'operator-only', engineConsumed: { kind: 'config', readSite: 'src/core/config.ts' }, note: 'Debug wire capture — operator-flipped per instance, never fleet-emitted.' },
  { name: 'LYNOX_PUBLIC_DEMO', valueKind: 'bool', emitPolicy: 'operator-only', engineConsumed: { kind: 'direct', readSite: 'src/server/http-api.ts' }, note: 'Public-demo hardening switch — operator-flipped on the demo host only.' },
  { name: 'LYNOX_WORKSPACE_ROOT', valueKind: 'opaque', emitPolicy: 'operator-only', engineConsumed: { kind: 'direct', readSite: 'src/core/workspace-root.ts' }, skewPolicy: 'An engine from before this variable ignores it and keeps the workspace in <data>/workspace, so files written there do not land on the volume the variable names. The control plane must check the image it starts before it sets the variable for a tenant.', note: 'Directory that holds the per-context workspaces (P18; default <data>/workspace). Set by the compose template in the engine service\'s `environment:` block together with the volume it names, never through the env emit: a sync-env on a tenant whose compose has no such volume must not point the engine at a path that is not one. An engine that does not yet support a root other than <data>/workspace refuses to start on one.' },

  // ── Denylist (must never be emitted) ──────────────────────────────────────
  { name: 'LYNOX_LAZY_TOOLS_ENABLED', valueKind: 'bool', emitPolicy: 'denylist', engineConsumed: { kind: 'config', readSite: 'src/core/config.ts' }, note: 'Parked feature (rafael 2026-07-22): the lazy-tools path does not work and is deferred — the engine read exists, but the CP must never emit/enable it fleet-side.' },
  { name: 'LYNOX_SHELL_EXEC_SOCKET', valueKind: 'opaque', emitPolicy: 'operator-only', engineConsumed: { kind: 'direct', readSite: 'src/tools/builtin/bash.ts' }, note: 'Path of the shell sidecar\'s exec socket (PRD 152 v2 §4.1). Set = bash runs in the sidecar, with NO fallback to running it in the engine; set but empty is an error. It must come with the sidecar itself (the compose template that adds the sidecar sets it), never from the env emit alone: an engine told to use a sidecar that does not exist has no bash at all. Unset = bash runs in the engine as before (self-host, local). An OLDER engine ignores it and keeps running bash in its own container.' },
  { name: 'LYNOX_EGRESS_PROXY_SECRET', valueKind: 'opaque', emitPolicy: 'operator-only', secret: { redact: 'exact-name' }, engineConsumed: { kind: 'direct', readSite: 'src/egress-proxy/main.ts' }, note: 'Bearer secret of the egress proxy\'s registration listener (PRD 152 v2 §4.2). Read by the proxy process, which runs from the same image in its own container. The engine reads it too (src/shell-sidecar/egress.ts): in sidecar mode it registers each shell call\'s credential with it, and unset means a shell call has no network. Generated per tenant. No control plane emits it yet. Deliberately NOT preserveAcrossSyncEnv yet: a preserve stance makes every sync-env require the key on every instance, and no instance has it. The stance arrives with the emit site, in the same change that generates the secret.' },
  { name: 'LYNOX_EGRESS_PROXY_URL', valueKind: 'opaque', emitPolicy: 'operator-only', engineConsumed: { kind: 'direct', readSite: 'src/shell-sidecar/egress.ts' }, note: 'Where the engine reaches the egress proxy\'s registration listener (PRD 152 v2 §4.2), on the tenant\'s internal network. Default http://proxy:3129: the compose service `proxy` resolves on the internal network to that listener (sec-infra, measured, 2026-10-16). Read only in sidecar mode with LYNOX_EGRESS_PROXY_SECRET set. Not emitted.' },
  { name: 'LYNOX_EGRESS_SHELL_PROXY', valueKind: 'opaque', emitPolicy: 'operator-only', engineConsumed: { kind: 'direct', readSite: 'src/shell-sidecar/egress.ts' }, note: 'host:port the shell sidecar dials as its proxy (PRD 152 v2 §4.2). The engine puts it, with the call\'s credential, into each call\'s HTTPS_PROXY. Default proxy:3128: on the shell network the service `proxy` resolves to the shell listener (sec-infra, measured, 2026-10-16), provided the sidecar is ONLY on that network. Not emitted.' },
  { name: 'LYNOX_EGRESS_PROXY_DENY_IPS', valueKind: 'opaque', emitPolicy: 'operator-only', engineConsumed: { kind: 'direct', readSite: 'src/egress-proxy/main.ts' }, note: 'Comma-separated IPv4 addresses the egress proxy never connects to, on top of the ranges it always refuses (private, loopback, link-local and the other reserved ranges: `isPrivateIP` in src/core/network-guard.ts plus the documentation and 6to4 relay ranges in src/egress-proxy/policy.ts): the tenant host\'s own public address, the control plane, other tenant hosts. Read by the proxy process only. The proxy does not start without at least one address, or with anything that is not an IPv4 address. Not emitted until the compose template adds the proxy.' },
  { name: 'LYNOX_FALLBACK_PROFILE', valueKind: 'opaque', emitPolicy: 'denylist', engineConsumed: { kind: 'none' }, note: 'Phantom — never emitted, never read. The worker profile name lives in LYNOX_WORKER_PROFILE.' },
  { name: 'LYNOX_LLM_MODE', valueKind: 'opaque', emitPolicy: 'denylist', engineConsumed: { kind: 'none' }, note: 'Retired eu-sovereign toggle (2026-06-13). Engine no longer reads it.' },
  { name: 'LYNOX_MAIN_MODEL', valueKind: 'opaque', emitPolicy: 'denylist', engineConsumed: { kind: 'none' }, note: 'Retired eu-branch orphan (engine never read it).' },
  { name: 'OPENAI_BASE_URL', valueKind: 'opaque', emitPolicy: 'denylist', engineConsumed: { kind: 'none' }, note: 'Retired eu-branch orphan (engine reads api_base_url, not this).' },
];

/** Fast lookup by var name. */
export const ENV_REGISTRY_BY_NAME: ReadonlyMap<string, EnvRegistryRow> = new Map(
  ENV_REGISTRY.map((r) => [r.name, r]),
);

/**
 * Engine-read `LYNOX_*` vars that are SELF-HOST / operator surface only — the
 * CP never emits them, so they carry no registry row. The reverse sweep
 * (read → row) accepts a read if its name is a row, a row's legacy read-alias,
 * matches a prefix family, or is listed here. A trailing `*` is a prefix glob.
 */
export const SELF_HOST_ONLY: readonly string[] = [
  'LYNOX_DATA_DIR',
  'LYNOX_DIR', // legacy alias of LYNOX_DATA_DIR
  'LYNOX_WORKSPACE',
  'LYNOX_API_BASE_URL',
  'LYNOX_ORG',
  'LYNOX_USER',
  'LYNOX_CLIENT',
  'LYNOX_LANGUAGE',
  'LYNOX_DEBUG',
  'LYNOX_DEBUG_FILE',
  // Debug-wire-capture companion knobs (sinks + gate files). The master switch
  // LYNOX_DEBUG_WIRE_CAPTURE has its own operator-only row above.
  'LYNOX_DEBUG_WIRE_*',
  'LYNOX_SEARCH_RERANK',
  'LYNOX_TELEMETRY_LOG_MAX_BYTES',
  'LYNOX_TRUSTED_PROXY_HOPS',
  'LYNOX_TRUST_PROXY',
  'LYNOX_CUSTOM_ENDPOINT_ACCEPTED',
  'LYNOX_SKIP_SUGGESTED_APIS',
  'LYNOX_RUN_WALL_CLOCK_MS',
  'LYNOX_OPENAI_REQUEST_TIMEOUT_MS',
  'LYNOX_MAIL_INSECURE_TLS',
  'LYNOX_MAIL_DEDUP_WINDOW_SEC',
  'LYNOX_COMPACTION_MODEL',
  'LYNOX_LLM_HELPER_MODEL',
  'LYNOX_EMBEDDING_PROVIDER',
  'LYNOX_TTS_PROVIDER',
  'LYNOX_TRANSCRIBE_PROVIDER',
  'LYNOX_TLS_CERT',
  'LYNOX_TLS_KEY',
  'LYNOX_ALLOWED_ORIGINS',
  'LYNOX_ALLOWED_IPS',
  'LYNOX_ALLOW_PLAIN_HTTP',
  'LYNOX_RATE_LIMIT_PER_HOUR',
  'LYNOX_RATE_LIMIT_CONCURRENT',
  'LYNOX_INBOX_*', // inbox integration knobs (region, privacy-ack, folder lists, …)
  'LYNOX_WEBUI_HANDLER',
  'LYNOX_MANAGED_FLUSH_INTERVAL_MS',
  'LYNOX_BALANCED_MODEL',
  // The shell sidecar's exec daemon (src/shell-sidecar/exec-daemon.ts): read by the
  // SIDECAR process from its compose template, never sent to the engine.
  'LYNOX_EXEC_SOCKET_PATH',
  'LYNOX_EXEC_WORKSPACE',
  'LYNOX_EXEC_ENGINE_GID',
  'LYNOX_EXEC_POOL_GID',
  'LYNOX_EXEC_POOL_FIRST_UID',
  'LYNOX_EXEC_POOL_SIZE',
  'LYNOX_EXEC_CALL_NPROC',
];

/**
 * Name families covered by a convention rather than per-name rows:
 * `LYNOX_SECRET_<NAME>` (user secret store) and `LYNOX_FEATURE_<FLAG>`
 * (feature-flag convention). Explicit rows (e.g. LYNOX_FEATURE_UNIFIED_INBOX)
 * take precedence; the family covers the rest.
 */
export const PREFIX_FAMILIES: readonly string[] = ['LYNOX_SECRET_', 'LYNOX_FEATURE_'];
