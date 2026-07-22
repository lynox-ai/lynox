/**
 * Cross-repo env-ABI registry — SINGLE SOURCE OF TRUTH for every environment
 * variable that crosses the control-plane → engine wire (K-W1 §3.2,
 * PRD-CORE-PRO-CONTRACT / DEF-0030).
 *
 * VENDORED DOWNSTREAM — edit ONLY here. The private control plane vendors a
 * byte-identical copy (its emit-matrix test re-seats onto these rows in the
 * K-W1 pro wave); core generates forward (row → real read site) and reverse
 * (read → row) drift tests from them (`tests/contract-env.test.ts`).
 * Imports nothing outside `src/contract/` (only `vocab.ts`).
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
 *   inventory.
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
  /** For `json` rows: the `shapes.ts` type both sides round-trip (fixture lands in K-W2). */
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
