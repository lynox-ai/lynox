/**
 * Zod schemas for JSON-serializable config types.
 * Used for runtime validation of user-facing config files and role JSON.
 */
import { z } from 'zod';
import { LEGACY_TIER_ALIASES } from './models.js';

// === Shared enums ===

// Accepts legacy Anthropic-brand names (opus/sonnet/haiku) and normalizes them
// to the provider-agnostic names so config.json files written before the
// 2026-05-29 rename keep validating. Reuses the single-source alias map from
// models.ts (see also `normalizeTier`). Unknown strings pass through so the
// inner z.enum produces the proper validation error.
const ModelTierSchema = z.preprocess(
  v => (typeof v === 'string' ? (LEGACY_TIER_ALIASES[v] ?? v) : v),
  z.enum(['deep', 'balanced', 'fast']),
);
const EffortLevelSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
// AutonomyLevelSchema and ThinkingModeSchema validated at runtime via type checks, not Zod

// === LynoxUserConfig ===

const LLMProviderSchema = z.enum(['anthropic', 'vertex', 'custom', 'openai']);

/**
 * Reject non-http(s) URLs (javascript:, file:, ftp:, data:) — these can be
 * persisted via PUT /api/config and then flow into the LLM client / probe
 * paths, where a non-http scheme would either crash or in the worst case
 * exfiltrate API keys / open SSRF vectors that the network guard does not
 * cover. Same pattern as the `searxng_url` guard below.
 */
const HttpUrlSchema = z.string().url().refine(
  url => url.startsWith('http://') || url.startsWith('https://'),
  { message: 'URL must use http:// or https:// scheme' },
);

// One hybrid Tier-Set slot. `provider` is a free string (registry key incl.
// 'mistral'); semantic validation (known provider, key presence, managed
// allowlist) is layered on at config-load (PR-3b), not in the structural schema.
const TierSlotSchema = z.object({
  provider:     z.string().min(1),
  model_id:     z.string().min(1),
  api_key:      z.string().optional(),
  api_base_url: z.string().optional(),
}).strict();

// A named model profile (non-Claude openai-compat provider) — mirrors the
// `ModelProfile` interface in models.ts. Not `.strict()`: an unknown key inside
// a profile must be stripped (Zod default), never reject, so a forward-compat
// profile field can't null the WHOLE config under the top-level `.strict()`.
const ModelProfileSchema = z.object({
  provider:          z.literal('openai'),
  api_base_url:      z.string(),
  api_key:           z.string(),
  auth:              z.enum(['static', 'google-vertex']).optional(),
  model_id:          z.string(),
  context_window:    z.number().optional(),
  max_tokens:        z.number().optional(),
  max_continuations: z.number().optional(),
  pricing:           z.object({ input: z.number(), output: z.number() }).optional(),
});

export const LynoxUserConfigSchema = z.object({
  api_key:              z.string().optional(),
  // Empty string permitted (UI "clear" gesture) — collapses to undefined at consume time.
  api_base_url:         z.union([HttpUrlSchema.max(2048), z.literal('')]).optional(),
  provider:             LLMProviderSchema.optional(),
  bugsink_enabled:      z.boolean().optional(),
  // User-disabled tools (Settings → Integrations → Tool Toggles).
  // Bounded array of bounded strings so malformed manual edits cannot
  // crash the session.ts `excludeTools` spread (non-array → not iterable).
  disabled_tools:       z.array(z.string().min(1).max(128)).max(200).optional(),
  // Saved Custom-provider endpoints (LiteLLM-friendly UI bookmarks).
  // `base_url` is capped at 2KB to prevent runaway URLs from inflating the
  // config payload. Array fails gracefully via `.catch([])`: a single
  // malformed bookmark from manual config-file editing won't brick the
  // whole config-load path (would otherwise lock the user out of Settings).
  custom_endpoints:     z.array(z.object({
    id:       z.string().min(1).max(128),
    name:     z.string().min(1).max(64),
    base_url: HttpUrlSchema.max(2048),
  })).catch([]).optional(),
  // Server-persisted record of custom (non-allowlisted) endpoint disclosures
  // the user explicitly accepted (GDPR Art-28 controller-responsibility
  // transfer). Replaces the old client-only sessionStorage flag so the
  // acceptance survives a reload / new device and is auditable. Host +
  // timestamp only — never the key. `.catch([])` keeps a malformed manual
  // edit from bricking config-load (same gentle-degrade as custom_endpoints).
  accepted_custom_endpoints: z.array(z.object({
    host:        z.string().min(1).max(255),
    accepted_at: z.string().min(1).max(64),
  })).max(100).catch([]).optional(),
  gcp_project_id:       z.string().optional(),
  gcp_region:           z.string().optional(),
  openai_model_id:      z.string().optional(),
  // Self-host native window for an openai-compat model not in the registry.
  // Same bound as max_context_window_tokens. Managed is blocked from setting
  // it via MANAGED_USER_WRITABLE_CONFIG, not here.
  openai_context_window: z.number().int().positive().max(1_000_000).optional(),
  default_tier:         ModelTierSchema.optional(),
  // Settable model-cost ceiling + account plan label. Present on the interface
  // AND set via env (LYNOX_MAX_TIER / LYNOX_ACCOUNT_TIER) — without them here,
  // `.strict()` strips a persisted value, nulling the whole config on write.
  max_tier:             ModelTierSchema.optional(),
  account_tier:         z.enum(['standard', 'pro']).optional(),
  thinking_mode:        z.enum(['adaptive', 'disabled']).optional(),
  effort_level:         EffortLevelSchema.optional(),
  max_session_cost_usd: z.number().optional(),
  max_concurrent_runs:  z.number().optional(),
  embedding_provider:   z.enum(['onnx', 'local']).optional(),
  plugins:              z.record(z.string(), z.boolean()).optional(),
  agents_dir:           z.string().optional(),
  manifests_dir:        z.string().optional(),
  workspace_dir:        z.string().optional(),
  user_id:              z.string().optional(),
  display_name:         z.string().optional(),
  organization_id:      z.string().optional(),
  client_id:            z.string().optional(),
  changeset_review:     z.boolean().optional(),
  memory_auto_scope:    z.boolean().optional(),
  greeting:             z.boolean().optional(),
  // search_api_key / search_provider retained for migration compatibility
  // with older config.json snapshots (Tavily backend retired 2026-05-24).
  // The legacy `'tavily'` value is silently coerced to `undefined` so old
  // configs still validate — the engine never reads either field now.
  search_api_key:       z.string().optional(),
  search_provider:      z
    .union([z.literal('searxng'), z.literal('tavily').transform(() => undefined as 'searxng' | undefined)])
    .optional(),
  searxng_url:          z.string().url().refine(
    url => url.startsWith('http://') || url.startsWith('https://'),
    { message: 'SearXNG URL must use http:// or https:// scheme' },
  ).optional().or(z.null()),
  google_client_id:     z.string().optional(),
  google_client_secret: z.string().optional(),
  max_daily_cost_usd:   z.number().optional(),
  max_monthly_cost_usd: z.number().optional(),
  // Preferred max context-window in tokens — UI offers 200k / 500k / 1M.
  // Backend clamps the trim window to this when set; default = model native.
  // Hard upper-bound 1M tokens (PRD-IA-V2 P3-PR-C Security S3): blocks an
  // attacker on a Managed instance from setting an unbounded value that
  // would force the agent to read multi-million-token windows on every
  // turn (memory-exhaustion DoS, and runaway provider spend). Matches the
  // current frontier native window (Sonnet 4.6 = 1M) and the largest UI
  // radio option in LLMAdvancedView's CONTEXT_OPTIONS; values above are
  // unreachable from the UI anyway. Raise this only when a model that
  // takes >1M context lands AND the UI radio gains a matching option.
  max_context_window_tokens: z.number().int().positive().max(1_000_000).optional(),
  // L1 cost-aware compaction budget (absolute carried-token offer point). Bounded
  // [32K, 1M]: below 32K would thrash compaction; 1M = the max window.
  compaction_token_budget: z.number().int().min(32_000).max(1_000_000).optional(),
  max_http_requests_per_hour: z.number().optional(),
  max_http_requests_per_day:  z.number().optional(),
  max_mail_sends_per_hour:    z.number().optional(),
  max_mail_sends_per_day:     z.number().optional(),
  mail_dedup_window_sec:      z.number().min(0).max(3600).optional(),
  memory_extraction:    z.boolean().optional(),
  memory_half_life_days:   z.number().optional(),
  pipeline_context_limit:  z.number().min(1_000).max(262_144).optional(),
  pipeline_step_result_limit: z.number().min(1_000).max(1_048_576).optional(),
  memory_extraction_limit: z.number().min(1_000).max(262_144).optional(),
  http_response_limit:     z.number().min(1_000).max(5_242_880).optional(),
  google_oauth_scopes:     z.array(z.string()).optional(),
  enforce_https:           z.boolean().optional(),
  // Outbound egress control for the http_request tool. Operator/CP security
  // control (NOT user/agent-writable). The .strict() schema would otherwise
  // reject these keys from config.json — which nulls the WHOLE config, silently
  // dropping every setting, not just these. Default 'allow-all' = unchanged.
  network_policy:          z.enum(['allow-all', 'allow-list', 'deny-all']).optional(),
  network_allowed_hosts:   z.array(z.string()).optional(),
  bugsink_dsn:             z.string().optional(),
  backup_dir:              z.string().optional(),
  backup_schedule:         z.string().optional(),
  backup_retention_days:   z.number().min(0).max(365).optional(),
  backup_encrypt:          z.boolean().optional(),
  backup_gdrive:           z.boolean().optional(),
  experience:              z.enum(['business', 'developer']).optional(),
  max_tool_result_chars:   z.number().min(1_000).max(500_000).optional(),
  tool_result_blob_threshold_chars: z.number().min(256).max(500_000).optional(),
  // Context-cost Slice 0: opt-in per-turn composition logging to
  // ~/.lynox/context-cost.jsonl (ground-truth context breakdown for the
  // cost-cut investigation). Off by default; zero overhead when unset.
  context_cost_log:        z.boolean().optional(),
  knowledge_graph_enabled: z.boolean().optional(),
  // Foundation Rework v2 (S1b): additively mirror extraction into the engine.db
  // subject-graph. Default off; flipped on per-tenant at S2. The .strict() schema
  // would otherwise reject this key from config.json (silently disabling the flag).
  subject_graph_enabled:   z.boolean().optional(),
  // Foundation Rework v2 (S5b): re-point memory recall onto engine.db. Default
  // off; flipped per-tenant after the s5-backfill. Co-gated on subject_graph_enabled
  // at the read path. The .strict() schema would otherwise reject this key from
  // config.json (silently disabling the flag).
  memory_graph_reads:      z.boolean().optional(),
  // Retired in Foundation Rework v2 (S3f): the verb-layer store now writes
  // engine.db unconditionally, so these rollout flags were removed from the
  // interface + env-loaders. Kept as tolerated-ignored config.json keys for one
  // release window — a mid-rollout tenant's config.json may still carry them, and
  // under `.strict()` an unknown key nulls the WHOLE config (dropping every
  // setting, not just these). Same discipline as `llm_mode` below.
  verb_graph_enabled:      z.boolean().optional(),
  verb_graph_reads:        z.boolean().optional(),
  embedding_model:         z.enum(['all-minilm-l6-v2', 'multilingual-e5-small', 'bge-m3']).optional(),
  llm_mode:                z.enum(['standard', 'eu-sovereign']).optional(),
  transcription_provider:  z.enum(['mistral', 'whisper', 'auto']).optional(),
  tts_provider:            z.enum(['mistral', 'auto']).optional(),
  // Mistral Voxtral voice slug (e.g. 'en_paul_neutral'). Free-form string so
  // the catalog can grow without a schema bump. Validation against the live
  // voices list happens at request time inside the TTS provider.
  tts_voice:               z.string().min(1).max(64).optional(),
  // Auto-update notification toggle (SystemSettings → Updates).
  update_check:            z.boolean().optional(),
  // Provider-agnostic routing (PR-3). routing_mode selects standard (one
  // provider) vs hybrid (per-tier via tier_set). cp_supplied mirrors the
  // billing-tier key-custody flag for the managed allowlist gate.
  routing_mode:            z.enum(['standard', 'hybrid']).optional(),
  tier_set:                z.object({
    fast:     TierSlotSchema.optional(),
    balanced: TierSlotSchema.optional(),
    deep:     TierSlotSchema.optional(),
  }).strict().optional(),
  cp_supplied:             z.boolean().optional(),
  // Named non-Claude model profiles + the profile used for background tasks.
  // Both are on the interface AND loaded from env (LYNOX_MODEL_PROFILES_JSON /
  // LYNOX_WORKER_PROFILE); omitting them here makes `.strict()` strip a
  // persisted value and null the whole config on the next write.
  model_profiles:          z.record(z.string(), ModelProfileSchema).optional(),
  worker_profile:          z.string().optional(),
}).strict(); // reject unknown keys — prevents stale-tab ghost-writes from
              // landing GET-response-only fields (capabilities, locks,
              // managed, bugsink_dsn_configured) in ~/.lynox/config.json.
              // PRD-IA-V2 P1-PR-A2 — ConfigView delete + schema tightening.
