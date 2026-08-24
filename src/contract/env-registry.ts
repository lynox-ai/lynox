/**
 * Cross-repo env-ABI registry — SINGLE SOURCE OF TRUTH for every environment
 * variable that crosses the control-plane → engine wire (K-W1 §3.2,
 * PRD-CORE-PRO-CONTRACT / DEF-0030).
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
 *   `resolveClientPair(idName, secretName, …)`; its form set accepts the name
 *   in EITHER pair position and a direct `process.env` read, because the two
 *   members sit at different argument positions and at different sites.
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
  | 'billing-tier' // hosted|managed|managed_pro (+ legacy starter|eu)
  | 'model-tier' // fast|balanced|deep (+ legacy haiku|sonnet|opus)
  | 'account-tier' // standard|pro
  | 'llm-provider' // anthropic|openai|vertex|custom
  | 'network-policy' // allow-all|allow-list|deny-all|guarded
  | 'usd-amount' // stringified non-negative number
  | 'bool' // 'true' | '1'
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
  | 'pair-resolver' // resolveClientPair('ID','SECRET') — one half of a credential pair
  | 'web-ui' // read inside packages/web-ui/src (runs in the engine process)
  | 'sdk-internal' // consumed inside an SDK constructor — no greppable readSite
  | 'none'; // not read by the engine (denylisted phantoms)

export interface EngineConsumption {
  kind: EngineReadKind;
  /** Repo-relative file whose read the forward drift test asserts. */
  readSite?: string;
  /** Additional read sites the forward test also asserts (e.g. web-ui next to core). */
  alsoReadAt?: string[];
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

const ALL_TIERS: BillingTier[] = ['hosted', 'managed', 'managed_pro'];
const MANAGED_TIERS: BillingTier[] = ['managed', 'managed_pro'];

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
  { name: 'LYNOX_ACCOUNT_TIER', valueKind: 'account-tier', emitPolicy: 'always', requiredForTier: ALL_TIERS, engineConsumed: { kind: 'config', readSite: 'src/core/config.ts' }, note: 'pro only for managed_pro. Since D8 the deep-gate is a pass-through — kept as the managed-vs-managed_pro label; max_tier is the sole cost cap.' },

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

  // ── OAuth app credentials (per provider; the CP emits the managed broker pair) ──
  { name: 'GOOGLE_CLIENT_ID', valueKind: 'opaque', emitPolicy: 'when-non-default', engineConsumed: { kind: 'pair-resolver', readSite: 'src/core/engine.ts', alsoReadAt: ['src/core/engine-init.ts'] }, skewPolicy: 'An engine below the Stage-1 release renders the BYO button and lands on redirect_uri_mismatch, so the CP gates the emit on a measured engine version rather than a release-wide rule.', note: 'OAuth APP credential, not a user token. Read as one half of a PAIR — resolveClientPair() takes both names from ONE source and never mixes, so this row pins a pair member rather than an independent var. Deliberately NOT preserveAcrossSyncEnv: that list is enforced fail-closed on presence and a never-emitted name on it stops sync-env fleet-wide (DEF-preserve-list-admits-never-emitted-name); the CP-side emit gate carries the values over itself. Carries NO secret stance, and that is a decision rather than an omission: an OAuth client id is public by construction (it travels in the browser redirect), so it belongs in the env-shape diff the admin preview exists for. Note the direction of the change — an UNDECLARED key is masked fail-closed, so declaring this row makes the id VISIBLE in the preview once the contract is vendored.' },
  { name: 'GOOGLE_CLIENT_SECRET', valueKind: 'opaque', emitPolicy: 'when-non-default', secret: { redact: 'exact-name' }, engineConsumed: { kind: 'pair-resolver', readSite: 'src/core/engine.ts', alsoReadAt: ['src/core/engine-init.ts'] }, skewPolicy: 'An engine below the Stage-1 release renders the BYO button and lands on redirect_uri_mismatch, so the CP gates the emit on a measured engine version rather than a release-wide rule.', note: 'The secret half of the GOOGLE_CLIENT_ID pair; same source-exclusivity and the same preserve prohibition. secret-store.ts also reads it, but through process.env[envVar] with a VARIABLE, which no literal-based form can assert — it is therefore not listed as a read site.' },

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
  { name: 'LYNOX_MIGRATION_TOKEN', valueKind: 'opaque', emitPolicy: 'when-non-default', secret: { redact: 'exact-name' }, engineConsumed: { kind: 'direct', readSite: 'src/server/http-api.ts' }, note: 'Only when the instance receives a migration.' },

  // ── Outbound egress posture ───────────────────────────────────────────────
  { name: 'LYNOX_NETWORK_POLICY', valueKind: 'network-policy', emitPolicy: 'when-non-default', engineConsumed: { kind: 'config', readSite: 'src/core/config.ts' }, skewPolicy: 'A pre-guarded engine drops the unknown `guarded` value to allow-all — the CP gates that emit behind the boot-marker capability check.', note: 'Emitted only for a non-default recognised value (never allow-all/null).' },
  { name: 'LYNOX_NETWORK_ALLOWED_HOSTS', valueKind: 'opaque', emitPolicy: 'when-non-default', engineConsumed: { kind: 'config', readSite: 'src/core/config.ts' }, note: 'Comma-separated operator floor; emitted only alongside a non-default policy and when non-empty.' },

  // ── Operator-only reads (the CP must NOT emit these) ─────────────────────
  { name: 'LYNOX_LLM_PROVIDER', valueKind: 'llm-provider', emitPolicy: 'operator-only', engineConsumed: { kind: 'config', readSite: 'src/core/config.ts' }, note: 'Self-host/BYOK operators set it themselves; the CP stopped emitting it with the eu-sovereign retirement (2026-06-13).' },
  { name: 'LYNOX_TIER_SET_JSON', valueKind: 'json', emitPolicy: 'operator-only', secret: { redact: 'whole-value' }, engineConsumed: { kind: 'config', readSite: 'src/core/config.ts' }, note: 'Operator tier-set override. Slots may embed per-tier api_key values → whole-value redaction, same class as LYNOX_MODEL_PROFILES_JSON. A future CP emit is a normal registry change (+ valueSchema hook).' },
  { name: 'LYNOX_DEBUG_WIRE_CAPTURE', valueKind: 'bool', emitPolicy: 'operator-only', engineConsumed: { kind: 'config', readSite: 'src/core/config.ts' }, note: 'Debug wire capture — operator-flipped per instance, never fleet-emitted.' },
  { name: 'LYNOX_PUBLIC_DEMO', valueKind: 'bool', emitPolicy: 'operator-only', engineConsumed: { kind: 'direct', readSite: 'src/server/http-api.ts' }, note: 'Public-demo hardening switch — operator-flipped on the demo host only.' },

  // ── Denylist (must never be emitted) ──────────────────────────────────────
  { name: 'LYNOX_LAZY_TOOLS_ENABLED', valueKind: 'bool', emitPolicy: 'denylist', engineConsumed: { kind: 'config', readSite: 'src/core/config.ts' }, note: 'Parked feature (rafael 2026-07-22): the lazy-tools path does not work and is deferred — the engine read exists, but the CP must never emit/enable it fleet-side.' },
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
];

/**
 * Name families covered by a convention rather than per-name rows:
 * `LYNOX_SECRET_<NAME>` (user secret store) and `LYNOX_FEATURE_<FLAG>`
 * (feature-flag convention). Explicit rows (e.g. LYNOX_FEATURE_UNIFIED_INBOX)
 * take precedence; the family covers the rest.
 */
export const PREFIX_FAMILIES: readonly string[] = ['LYNOX_SECRET_', 'LYNOX_FEATURE_'];
