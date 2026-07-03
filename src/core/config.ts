import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { LynoxUserConfig, ModelProfile, TierSet } from '../types/index.js';
import { isModelProfile, isTierSlot, MISTRAL_API_BASE } from '../types/index.js';
import { isMistralHost } from '../types/index.js';
import { cpSuppliesLLMKey } from '../server/billing-tier.js';
import { readEnvAlias, envTier } from './env.js';
import { ensureDirSync, writeFileAtomicSync } from './atomic-write.js';
import { LynoxUserConfigSchema } from '../types/schemas.js';
import { getErrorMessage } from './utils.js';

const CONFIG_FILENAME = 'config.json';
const LYNOX_DIR = '.lynox';

/**
 * Managed tier_set hardening — the PRD tenant-writable ship-blocker. For each
 * slot: keep ONLY an allowlisted provider (anthropic / mistral), STRIP the
 * user-supplied key/base_url, and source the CP env credentials for that
 * provider (base_url forced to the canonical MISTRAL_API_BASE — no host spoof).
 * An off-allowlist provider, or one whose CP key is absent, drops the slot (it
 * falls back to the base provider). This makes a managed tenant unable to point
 * a slot at an off-allowlist endpoint, inject a key/base_url, or name a provider
 * outside the curated set. Self-host (not cp_supplied) never runs this — its
 * slots legitimately carry their own keys.
 */
export function applyManagedTierSetConstraints(tierSet: TierSet): TierSet {
  const out: TierSet = {};
  const anthropicKey = process.env['ANTHROPIC_API_KEY'];
  const mistralKey = process.env['MISTRAL_API_KEY'];
  for (const tier of ['fast', 'balanced', 'deep'] as const) {
    const slot = tierSet[tier];
    if (!slot) continue;
    // Mistral is the registry-canonical 'mistral' OR the LLMProvider form the
    // settings UI persists ('openai' + a Mistral host — same as standard mode).
    // A non-Mistral host on 'openai' (a tenant trying to sneak a free-text
    // endpoint) fails isMistralHost → the slot drops. The accepted base_url is
    // ALWAYS forced to the canonical MISTRAL_API_BASE (no host spoof).
    const isMistral = slot.provider === 'mistral'
      || (slot.provider === 'openai' && isMistralHost(slot.api_base_url));
    if (slot.provider === 'anthropic' && anthropicKey) {
      out[tier] = { provider: 'anthropic', model_id: slot.model_id, api_key: anthropicKey };
    } else if (isMistral && mistralKey) {
      out[tier] = { provider: slot.provider, model_id: slot.model_id, api_key: mistralKey, api_base_url: MISTRAL_API_BASE };
    }
    // else: off-allowlist provider or missing CP key → drop (falls back to base).
  }
  return out;
}

/** Override for getLynoxDir(). Set via --data-dir or LYNOX_DATA_DIR. */
let _dataDirOverride: string | null = null;

/**
 * Override the data directory for this process.
 * Must be called before Engine.init().
 */
export function setDataDir(dir: string): void {
  _dataDirOverride = dir;
}

function getUserConfigDir(): string {
  // `LYNOX_DATA_DIR` (canonical) with the legacy `LYNOX_DIR` accepted forever.
  return _dataDirOverride ?? readEnvAlias('LYNOX_DATA_DIR') ?? join(homedir(), LYNOX_DIR);
}

function getProjectConfigDir(): string {
  return join(process.cwd(), LYNOX_DIR);
}

function readConfigFile(filePath: string): LynoxUserConfig | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    const result = LynoxUserConfigSchema.safeParse(parsed);
    if (!result.success) {
      process.stderr.write(`⚠ Invalid config in ${filePath}: ${result.error.issues[0]?.message ?? 'unknown error'}\n`);
      return null;
    }
    return result.data as LynoxUserConfig;
  } catch (err: unknown) {
    const msg = getErrorMessage(err);
    process.stderr.write(`⚠ Failed to parse ${filePath}: ${msg}\n`);
    return null;
  }
}

let _cachedConfig: LynoxUserConfig | null = null;

/**
 * Merge configs: env > project > user.
 * Result is cached after first call. Use reloadConfig() to refresh.
 */
export function loadConfig(): LynoxUserConfig {
  if (_cachedConfig) return _cachedConfig;
  const userConfig = readConfigFile(join(getUserConfigDir(), CONFIG_FILENAME));
  const projectConfig = readConfigFile(join(getProjectConfigDir(), CONFIG_FILENAME));

  const merged: LynoxUserConfig = { ...userConfig };

  // Allowlist: project config cannot override security-sensitive fields
  const PROJECT_SAFE_KEYS: ReadonlySet<string> = new Set([
    'default_tier', 'thinking_mode', 'effort_level',
    'max_session_cost_usd', 'max_concurrent_runs', 'embedding_provider', 'plugins',
    'organization_id', 'client_id',
    'changeset_review', 'greeting', 'context_name',
    'max_daily_cost_usd', 'max_monthly_cost_usd',
    'max_http_requests_per_hour', 'max_http_requests_per_day',
    'max_mail_sends_per_hour', 'max_mail_sends_per_day', 'mail_dedup_window_sec',
    'memory_extraction',
    'memory_half_life_days',
    'pipeline_context_limit', 'pipeline_step_result_limit',
    'memory_extraction_limit', 'http_response_limit',
    'enforce_https',
    'bugsink_dsn',
    'backup_dir', 'backup_schedule', 'backup_retention_days', 'backup_encrypt',
    'experience',
  ]);

  if (projectConfig) {
    for (const [key, value] of Object.entries(projectConfig)) {
      if (value !== undefined && value !== null && PROJECT_SAFE_KEYS.has(key)) {
        (merged as Record<string, unknown>)[key] = value;
      }
    }
  }

  if (process.env['ANTHROPIC_API_KEY']) {
    merged.api_key = process.env['ANTHROPIC_API_KEY'];
  }
  // Generic LLM endpoint: `LYNOX_API_BASE_URL` (canonical) with the legacy
  // `ANTHROPIC_BASE_URL` accepted forever (real Anthropic-proxy users + every
  // pre-rename managed/self-host env). Feeds the Mistral key promotion below.
  const apiBaseUrl = readEnvAlias('LYNOX_API_BASE_URL');
  if (apiBaseUrl) {
    merged.api_base_url = apiBaseUrl;
  }
  if (process.env['LYNOX_WORKSPACE']) {
    merged.workspace_dir = process.env['LYNOX_WORKSPACE'];
  }
  if (process.env['LYNOX_EMBEDDING_PROVIDER']) {
    const ep = process.env['LYNOX_EMBEDDING_PROVIDER'];
    if (ep === 'onnx' || ep === 'local') {
      merged.embedding_provider = ep;
    }
  }
  // Foundation Rework v2 (S1b): the engine.db subject-graph mirror flag. The CP
  // sets this env per-tenant to flip the flag (staging now, prod at S2) without
  // editing the instance's config.json. Explicit 'true'/'1' vs 'false'/'0' parse
  // (no z.coerce, which would treat any non-empty string as true).
  const subjectGraph = process.env['LYNOX_SUBJECT_GRAPH_ENABLED'];
  if (subjectGraph === 'true' || subjectGraph === '1') {
    merged.subject_graph_enabled = true;
  } else if (subjectGraph === 'false' || subjectGraph === '0') {
    merged.subject_graph_enabled = false;
  }
  // Foundation Rework v2 (S5b): the engine.db memory-recall read flag. Like the
  // mirror flag above, the CP flips this per-tenant via env (after running the
  // s5-backfill) without editing config.json. Explicit 'true'/'1' vs 'false'/'0'
  // (no z.coerce). NOT in PROJECT_SAFE_KEYS — a project config must not redirect
  // the user's memory reads.
  const memoryReads = process.env['LYNOX_MEMORY_GRAPH_READS'];
  if (memoryReads === 'true' || memoryReads === '1') {
    merged.memory_graph_reads = true;
  } else if (memoryReads === 'false' || memoryReads === '0') {
    merged.memory_graph_reads = false;
  }
  // Outbound egress policy. Lets the CP set it per-tenant via env without
  // editing config.json (the CP env emit itself is a separate slice). Explicit
  // enum parse — an unrecognised value is ignored (falls back to config/default
  // 'allow-all'), never coerced. NOT in PROJECT_SAFE_KEYS: a project config must
  // not be able to weaken a user/operator-set egress policy.
  const netPolicy = process.env['LYNOX_NETWORK_POLICY'];
  if (netPolicy === 'allow-all' || netPolicy === 'allow-list' || netPolicy === 'deny-all') {
    merged.network_policy = netPolicy;
  }
  const netHosts = process.env['LYNOX_NETWORK_ALLOWED_HOSTS'];
  if (netHosts !== undefined && netHosts.trim() !== '') {
    const parsedHosts = netHosts.split(',').map((h) => h.trim()).filter((h) => h.length > 0);
    if (parsedHosts.length > 0) {
      merged.network_allowed_hosts = parsedHosts;
    } else {
      // Non-blank but no usable hosts (e.g. ","). Warn + retain the config.json
      // value rather than silently overwriting it with an empty list — which
      // under allow-list would block ALL egress with no signal.
      process.stderr.write('⚠ LYNOX_NETWORK_ALLOWED_HOSTS set but parsed to no hosts — ignoring it\n');
    }
  }
  if (process.env['LYNOX_USER']) {
    merged.user_id = process.env['LYNOX_USER'];
  }
  if (process.env['LYNOX_ORG']) {
    merged.organization_id = process.env['LYNOX_ORG'];
  }
  if (process.env['LYNOX_CLIENT']) {
    merged.client_id = process.env['LYNOX_CLIENT'];
  }
  // Default language
  if (process.env['LYNOX_LANGUAGE']) {
    merged.language = process.env['LYNOX_LANGUAGE'];
  }
  // LLM provider
  if (process.env['LYNOX_LLM_PROVIDER']) {
    const p = process.env['LYNOX_LLM_PROVIDER'];
    if (p === 'anthropic' || p === 'vertex' || p === 'custom' || p === 'openai') {
      merged.provider = p;
    }
  }
  // (LYNOX_LLM_MODE env read retired 2026-06-13 with the eu-sovereign axis.
  //  Mistral is now selected via provider+endpoint — see the key promotion
  //  below. `llm_mode` stays a tolerated, ignored config.json key for one
  //  release window so existing files still parse under the .strict() schema.)
  // OpenAI model ID (for provider: 'openai')
  if (process.env['OPENAI_MODEL_ID']) {
    merged.openai_model_id = process.env['OPENAI_MODEL_ID'];
  }
  // Default model tier: `LYNOX_DEFAULT_MODEL_TIER` (canonical) with the legacy
  // `LYNOX_DEFAULT_TIER` accepted forever. envTier normalizes both the canonical
  // band names and the legacy Anthropic-brand names so old env vars keep working.
  const defaultTier = envTier('LYNOX_DEFAULT_MODEL_TIER');
  if (defaultTier) merged.default_tier = defaultTier;
  // Max model tier cap (managed hosting cost control — StepHints and pipelines
  // are clamped): `LYNOX_MAX_MODEL_TIER` (canonical) / legacy `LYNOX_MAX_TIER`.
  const maxTier = envTier('LYNOX_MAX_MODEL_TIER');
  if (maxTier) merged.max_tier = maxTier;
  // Account plan tier (separate from LLM model tier) — 'pro' unlocks
  // capabilities like the researcher-role Opus override. Defaults to
  // 'standard' when unset.
  if (process.env['LYNOX_ACCOUNT_TIER']) {
    const t = process.env['LYNOX_ACCOUNT_TIER'];
    if (t === 'standard' || t === 'pro') merged.account_tier = t;
  }
  // Worker-task profile (managed control plane sets this to a Mistral 'fallback'
  // profile so background WorkerLoop tasks run on the cheaper EU model instead
  // of the main Anthropic LLM). The CP delivers it as an env var; without this
  // bridge it never reached `worker_profile` and every managed background task
  // silently ran on the main provider.
  if (process.env['LYNOX_WORKER_PROFILE']) {
    merged.worker_profile = process.env['LYNOX_WORKER_PROFILE'];
  }
  // Named model profiles, delivered as JSON by the managed control plane
  // (LYNOX_MODEL_PROFILES_JSON). The engine deserializes them into
  // `model_profiles` so `worker_profile` and spawn(profile) can resolve a
  // profile to a concrete provider/key/model. Env entries merge over (win
  // against) any file-config profiles. Malformed JSON is ignored rather than
  // crashing boot — a bad profile blob must not take the whole instance down.
  if (process.env['LYNOX_MODEL_PROFILES_JSON']) {
    try {
      const parsed: unknown = JSON.parse(process.env['LYNOX_MODEL_PROFILES_JSON']);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // Validate each entry against the engine ModelProfile shape instead of a
        // blind cast: a malformed profile (e.g. missing api_key) must be dropped
        // here, not passed on to spawn/openai-adapter as `Bearer undefined`.
        const valid: Record<string, ModelProfile> = {};
        for (const [name, profile] of Object.entries(parsed as Record<string, unknown>)) {
          if (isModelProfile(profile)) valid[name] = profile;
        }
        merged.model_profiles = {
          ...merged.model_profiles,
          ...valid,
        };
      }
    } catch {
      // ignore malformed LYNOX_MODEL_PROFILES_JSON — boot without rather than crash
    }
  }
  // Guard a dangling worker_profile: if LYNOX_WORKER_PROFILE names a profile that
  // LYNOX_MODEL_PROFILES_JSON didn't actually provide (e.g. the profiles blob was
  // malformed and dropped above, or the two env vars drifted), clear it instead
  // of letting EVERY background task throw "Unknown model profile". Running the
  // worker on the main provider is a graceful degrade; failing every task is not.
  if (merged.worker_profile && !merged.model_profiles?.[merged.worker_profile]) {
    merged.worker_profile = undefined;
  }
  // Provider-agnostic routing (PR-3d): cp_supplied mirrors the billing-tier
  // key-custody flag (managed/managed_pro) so the managed tier_set allowlist can
  // gate on it. Canonical LYNOX_BILLING_TIER, legacy LYNOX_MANAGED_MODE alias.
  if (cpSuppliesLLMKey(readEnvAlias('LYNOX_BILLING_TIER'))) merged.cp_supplied = true;
  // Hybrid Tier-Set delivered as JSON by the CP / op-provisioning
  // (LYNOX_TIER_SET_JSON) → deserialized into `tier_set` (+ routing_mode hybrid).
  // Each slot is validated; a malformed slot is dropped (never reaches client
  // construction as `Bearer undefined`); a fully malformed blob is ignored rather
  // than crashing boot.
  if (process.env['LYNOX_TIER_SET_JSON']) {
    try {
      const parsed: unknown = JSON.parse(process.env['LYNOX_TIER_SET_JSON']);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const validSet: TierSet = {};
        for (const tier of ['fast', 'balanced', 'deep'] as const) {
          const slot = (parsed as Record<string, unknown>)[tier];
          if (isTierSlot(slot)) validSet[tier] = slot;
        }
        if (Object.keys(validSet).length > 0) {
          merged.tier_set = { ...merged.tier_set, ...validSet };
          merged.routing_mode = 'hybrid';
        }
      }
    } catch {
      // ignore malformed LYNOX_TIER_SET_JSON — boot in standard mode rather than crash
    }
  }
  // Managed instances: the tier_set is a TENANT-WRITABLE surface, so harden it at
  // config-load (the PRD ship-blocker) — allowlist + CP key-custody. If every
  // slot is dropped, fall back to standard mode.
  if (merged.cp_supplied && merged.tier_set) {
    merged.tier_set = applyManagedTierSetConstraints(merged.tier_set);
    if (Object.keys(merged.tier_set).length === 0) {
      merged.tier_set = undefined;
      merged.routing_mode = 'standard';
    }
  }
  // GCP config for Vertex AI
  if (process.env['GCP_PROJECT_ID'] ?? process.env['ANTHROPIC_VERTEX_PROJECT_ID']) {
    merged.gcp_project_id = process.env['GCP_PROJECT_ID'] ?? process.env['ANTHROPIC_VERTEX_PROJECT_ID'];
  }
  if (process.env['CLOUD_ML_REGION']) {
    merged.gcp_region = process.env['CLOUD_ML_REGION'];
  }
  if (process.env['GOOGLE_CLIENT_ID']) {
    merged.google_client_id = process.env['GOOGLE_CLIENT_ID'];
  }
  if (process.env['GOOGLE_CLIENT_SECRET']) {
    merged.google_client_secret = process.env['GOOGLE_CLIENT_SECRET'];
  }
  // TAVILY_API_KEY env wiring removed 2026-05-24 — backend retired in favour
  // of SearXNG (full quality) + DuckDuckGo HTML-scrape fallback (no-config
  // honesty path). Setting TAVILY_API_KEY now has no effect.
  if (process.env['SEARXNG_URL']) {
    merged.searxng_url = process.env['SEARXNG_URL'];
  }

  // Managed Mistral key promotion (replaces the retired eu-sovereign toggle).
  // When the active provider is the OpenAI-compatible Mistral endpoint — set
  // either by the managed control plane or by the user picking the Mistral
  // preset in Settings (which stages provider='openai' + the Mistral
  // api_base_url) — flow the host's MISTRAL_API_KEY into the active api_key.
  // The managed key lives only in the environment (never sent to the browser),
  // so the in-app provider switch has no key to stage from the client; this
  // bridges it. Keyed on provider+endpoint, not a separate mode, so there is no
  // orthogonal toggle to keep in sync.
  //
  // Unconditional on a Mistral endpoint: a managed/self-host box already has
  // ANTHROPIC_API_KEY in merged.api_key by this point, so guarding on an empty
  // api_key would never fire — the override must win, exactly as the prior
  // eu-sovereign branch did (it overwrote api_key unconditionally).
  if (merged.provider === 'openai' && isMistralHost(merged.api_base_url) && process.env['MISTRAL_API_KEY']) {
    merged.api_key = process.env['MISTRAL_API_KEY'];
    // Single-model fallback when the UI/CP staged no explicit model. Tier
    // routing (fast/balanced/deep) is wired separately via MISTRAL_MODEL_MAP —
    // see setOpenAIModelResolver. A pinned versioned snapshot (not `*-latest`)
    // keeps behaviour reproducible across Mistral model refreshes.
    if (!merged.openai_model_id) merged.openai_model_id = 'mistral-large-2512';
  }

  _cachedConfig = merged;
  return merged;
}

/**
 * Clear cached config so next loadConfig() re-reads from disk.
 */
export function reloadConfig(): void {
  _cachedConfig = null;
}

/**
 * Write config to ~/.lynox/config.json with 0600 permissions.
 */
export function saveUserConfig(config: LynoxUserConfig): void {
  const dir = getUserConfigDir();
  const filePath = join(dir, CONFIG_FILENAME);
  writeFileAtomicSync(filePath, JSON.stringify(config, null, 2) + '\n');
  _cachedConfig = null; // invalidate cache after write
}

/**
 * Read only the user config file (no project/env merging).
 * Used by /config to modify user settings without leaking env vars into the file.
 */
export function readUserConfig(): LynoxUserConfig {
  const filePath = join(getUserConfigDir(), CONFIG_FILENAME);
  return readConfigFile(filePath) ?? {};
}

let _vaultApiKeyExists: boolean | null = null;

export function hasApiKey(): boolean {
  // Non-Anthropic providers don't need ANTHROPIC_API_KEY
  const config = loadConfig();
  const provider = config.provider;
  if (provider === 'vertex' || provider === 'custom' || provider === 'openai') return true;
  if (process.env['ANTHROPIC_API_KEY']) return true;
  if (config.api_key !== undefined && config.api_key !== null && config.api_key !== '') return true;
  // Check vault (cached — avoids repeated SQLite opens)
  if (process.env['LYNOX_VAULT_KEY'] && _vaultApiKeyExists === null) {
    // Dynamic import avoided — caller can set via setVaultApiKeyExists()
  }
  return _vaultApiKeyExists === true;
}

/**
 * Tell the config module that ANTHROPIC_API_KEY exists in the vault.
 * Called by orchestrator-init after vault initialization.
 */
export function setVaultApiKeyExists(exists: boolean): void {
  _vaultApiKeyExists = exists;
}

export function getLynoxDir(): string {
  return getUserConfigDir();
}


export function ensureLynoxDir(): string {
  const dir = getUserConfigDir();
  return ensureDirSync(dir);
}
