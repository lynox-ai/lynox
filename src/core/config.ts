import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { LynoxUserConfig, ModelProfile, TierSet } from '../types/index.js';
import { isModelProfile, isTierSlot, MISTRAL_API_BASE, modelCapability, parseBlockedModelIds, isBlockedModelId } from '../types/index.js';
import { isMistralHost } from '../types/index.js';
import { cpSuppliesLLMKey } from '../server/billing-tier.js';
import { readEnvAlias, envTier } from './env.js';
import { ensureDirSync, writeFileAtomicSync } from './atomic-write.js';
import { LynoxUserConfigSchema } from '../types/schemas.js';
import { getErrorMessage } from './utils.js';
import { pinnedVaultSlotForEndpoint } from './llm/catalog.js';
import { TIER_PRESETS, expandTierPreset, FIREWORKS_API_BASE, managedFireworksEnabled } from './tier-presets.js';

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
export function applyManagedTierSetConstraints(tierSet: TierSet, blockedModelIds?: readonly string[]): TierSet {
  const out: TierSet = {};
  const anthropicKey = process.env['ANTHROPIC_API_KEY'];
  const mistralKey = process.env['MISTRAL_API_KEY'];
  // Canary (model-presets W3): a Fireworks slot (⚡ efficient's deep model) is kept
  // ONLY when the operator opts this managed instance in via the flag AND the CP
  // supplies FIREWORKS_API_KEY. Default OFF → the slot drops like any off-allowlist
  // host (broad managed stays Anthropic/Mistral). The base_url is forced to the
  // canonical FIREWORKS_API_BASE (no host spoof), mirroring the Mistral branch.
  const fireworksEnabled = managedFireworksEnabled();
  const fireworksKey = process.env['FIREWORKS_API_KEY'];
  for (const tier of ['fast', 'balanced', 'deep'] as const) {
    const slot = tierSet[tier];
    if (!slot) continue;
    // Model blocklist (LYNOX_BLOCKED_MODEL_IDS): a slot naming a blocked model
    // is dropped in-memory (the tier falls back to the base provider, where the
    // tier-resolver enforces the same blocklist). config.json is untouched —
    // clearing the blocklist restores the user's choice on the next reload.
    if (isBlockedModelId(slot.model_id, blockedModelIds)) continue;
    // Mistral is the registry-canonical 'mistral' OR the LLMProvider form the
    // settings UI persists ('openai' + a Mistral host — same as standard mode).
    // A non-Mistral host on 'openai' (a tenant trying to sneak a free-text
    // endpoint) fails isMistralHost → the slot drops. The accepted base_url is
    // ALWAYS forced to the canonical MISTRAL_API_BASE (no host spoof).
    const isMistral = slot.provider === 'mistral'
      || (slot.provider === 'openai' && isMistralHost(slot.api_base_url));
    // Fireworks (openai wire) — accepted only under the flag, matched by the EXACT
    // canonical endpoint (no fuzzy host match / no spoof surface).
    const isFireworks = fireworksEnabled
      && slot.provider === 'openai'
      && slot.api_base_url === FIREWORKS_API_BASE;
    if (slot.provider === 'anthropic' && anthropicKey) {
      out[tier] = { provider: 'anthropic', model_id: slot.model_id, api_key: anthropicKey };
    } else if (isMistral && mistralKey) {
      out[tier] = { provider: slot.provider, model_id: slot.model_id, api_key: mistralKey, api_base_url: MISTRAL_API_BASE };
    } else if (isFireworks && fireworksKey) {
      out[tier] = { provider: slot.provider, model_id: slot.model_id, api_key: fireworksKey, api_base_url: FIREWORKS_API_BASE };
    }
    // else: off-allowlist provider or missing CP key → drop (falls back to base).
  }
  return out;
}

/**
 * May the `ANTHROPIC_API_KEY` value be mirrored into the legacy `api_key` field
 * for this provider?
 *
 * `api_key` is paired DIRECTLY with `api_base_url` by the pre-vault callers
 * (spawn, pipeline, plan-task, process, the orchestrator). An `ANTHROPIC_API_KEY`
 * is an Anthropic-wire credential, so it may sit there only on an endpoint that
 * speaks that wire: `anthropic`, `custom` (an Anthropic-compatible proxy — the
 * user configured it as one), `vertex` (which ignores it anyway), or the legacy
 * default (undefined).
 *
 * NEVER on `provider: 'openai'`. There the endpoint is Mistral, Groq, Together or
 * a local Ollama, and pairing the Anthropic key with a Groq base_url — or sending
 * it in plaintext over http to localhost — is exactly the cross-vendor leak this
 * whole change closes. The key comes from THAT endpoint's slot instead (see the
 * openai block in loadConfig).
 *
 * Exported + shared so the two places that assign the key — the env path here and
 * the vault path in engine-init.ts — can never drift apart, which is precisely
 * how the leak survived three review rounds: each patched one path and missed the
 * other.
 */
export function anthropicKeyMayHoldApiKey(provider: LlmProviderMaybe): boolean {
  return provider !== 'openai';
}

type LlmProviderMaybe = LynoxUserConfig['provider'];

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
 * Render an environment-supplied preset name for a log line or an API field.
 *
 * ESCAPES rather than strips, and that distinction is the point. Stripping a
 * stray byte out of `efficient\u0001` yields `efficient` — a preset this engine
 * DOES know — so both signals would name a valid preset while reporting that it
 * is unknown, and an operator would read "version skew" where the truth is an
 * invisible character. The escape keeps the evidence legible.
 *
 * Everything outside printable ASCII becomes `\uXXXX`. Preset names are ASCII by
 * contract, so nothing legitimate is escaped — while C0, DEL, C1 (U+009B is an
 * 8-bit escape introducer some terminals honour), the JS line terminators
 * U+2028/U+2029, NEL U+0085 and the bidi overrides all lose their power to forge
 * a log line or spoof the rendered name. A control-character CLASS would have
 * missed every one of those but C0.
 *
 * The cap can be a plain code-unit slice, and that is worth saying because the
 * obvious worry does not apply: escaping has already reduced the string to
 * printable ASCII, so a code unit IS a code point here and no surrogate pair can
 * be split. A code-point cap would be an equivalent mutation — measured, and the
 * test that "pinned" it was removed rather than kept as decoration.
 *
 * One helper for both sinks on purpose: the previous version bounded the API
 * field and left the log line raw, while its own comment justified the bound by
 * the log line.
 */
export function describePinForDisplay(value: string): string {
  const escaped = [...value]
    .map((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      return cp >= 0x20 && cp <= 0x7e ? ch : `\\u${cp.toString(16).padStart(4, '0')}`;
    })
    .join('');
  return escaped.slice(0, 64);
}

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
    'default_tier', 'balanced_model', 'thinking_mode', 'effort_level',
    'max_session_cost_usd', 'max_concurrent_runs', 'embedding_provider', 'plugins',
    'organization_id', 'client_id',
    'changeset_review', 'greeting', 'context_name',
    'max_daily_cost_usd', 'max_monthly_cost_usd',
    'max_http_requests_per_hour', 'max_http_requests_per_day',
    'max_mail_sends_per_hour', 'max_mail_sends_per_day', 'mail_dedup_window_sec',
    'memory_extraction',
    'memory_half_life_days',
    'pipeline_context_limit', 'pipeline_step_result_limit',
    'memory_extraction_limit', 'http_response_limit', 'http_html_extract',
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

  // What the user actually wrote in config.json, captured BEFORE the env var
  // overwrites it. On a non-Anthropic endpoint this is the only key we can trust
  // to belong there — see the endpoint-scoped block further down.
  const configFileApiKey = merged.api_key;
  const anthropicEnvKey = process.env['ANTHROPIC_API_KEY'];
  if (anthropicEnvKey) {
    merged.api_key = anthropicEnvKey;
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
  // Lazy-tools (Slice 1): Anthropic-direct only — defer heavy/long-tail tool
  // schemas behind the native tool-search tool so the cached prefix shrinks. The
  // CP flips this per-tenant via env without editing config.json. Same explicit
  // 'true'/'1' vs 'false'/'0' parse as the mirror flag above (no z.coerce, which
  // would treat any non-empty string as true).
  const lazyTools = process.env['LYNOX_LAZY_TOOLS_ENABLED'];
  if (lazyTools === 'true' || lazyTools === '1') {
    merged.lazy_tools_enabled = true;
  } else if (lazyTools === 'false' || lazyTools === '0') {
    merged.lazy_tools_enabled = false;
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
  // Memory Foundation Wave 0: the self-reinforcement emergency-stop flag. The CP
  // flips it per-tenant via env (rafael canary first) without editing config.json.
  // Explicit 'true'/'1' vs 'false'/'0' (no z.coerce). NOT in PROJECT_SAFE_KEYS — a
  // project config must not alter the user's memory scoring/write behaviour.
  const memScoringV2 = process.env['LYNOX_MEMORY_SCORING_V2'];
  if (memScoringV2 === 'true' || memScoringV2 === '1') {
    merged.memory_scoring_v2 = true;
  } else if (memScoringV2 === 'false' || memScoringV2 === '0') {
    merged.memory_scoring_v2 = false;
  }
  // Memory Foundation Wave 0: retrieval shadow-log flag. The CP enables it
  // per-tenant via env to gather the Wave-2 floor distribution on the real corpus.
  // Explicit 'true'/'1' vs 'false'/'0' (no z.coerce). NOT in PROJECT_SAFE_KEYS — a
  // project config must not turn on plaintext retrieval telemetry.
  const retrievalShadow = process.env['LYNOX_RETRIEVAL_SHADOW_LOG'];
  if (retrievalShadow === 'true' || retrievalShadow === '1') {
    merged.retrieval_shadow_log = true;
  } else if (retrievalShadow === 'false' || retrievalShadow === '0') {
    merged.retrieval_shadow_log = false;
  }
  // Memory Foundation Wave 2: the write-trust gate enforcement flag. The CP flips it
  // per-tenant via env (rafael canary first, after the shadow window closes) without
  // editing config.json. Explicit 'true'/'1' vs 'false'/'0' (no z.coerce). NOT in
  // PROJECT_SAFE_KEYS — a project config must not be able to change the user's memory
  // trust/write behaviour (an agent-writable flag would be a self-grant of the very
  // privilege this gate withholds).
  const memWriteTrustGate = process.env['LYNOX_MEMORY_WRITE_TRUST_GATE'];
  if (memWriteTrustGate === 'true' || memWriteTrustGate === '1') {
    merged.memory_write_trust_gate = true;
  } else if (memWriteTrustGate === 'false' || memWriteTrustGate === '0') {
    merged.memory_write_trust_gate = false;
  }
  // Durable Knowledge Substrate (DK.1): the CP flips it per-tenant via env (rafael
  // canary first) without editing config.json. Explicit 'true'/'1' vs 'false'/'0' (no
  // z.coerce). NOT in PROJECT_SAFE_KEYS — a project config must not be able to swap the
  // whole memory pillar (an agent-writable flag would let injected content route its own
  // writes past the extraction-decoupling + trust routing this substrate depends on).
  const durableMemory = process.env['LYNOX_DURABLE_MEMORY_ENABLED'];
  if (durableMemory === 'true' || durableMemory === '1') {
    merged.durable_memory_enabled = true;
  } else if (durableMemory === 'false' || durableMemory === '0') {
    merged.durable_memory_enabled = false;
  }
  // Calendar reading (ICS feeds). Per-tenant via env so the CP can turn it off in production
  // without a release if a real feed behaves worse than staging did — the whole reason it
  // ships behind a flag. Explicit 'true'/'1' vs 'false'/'0' (no z.coerce). NOT in
  // PROJECT_SAFE_KEYS: an agent-writable flag would let injected content switch on a tool
  // that reads externally-authored text into context.
  const calendarRead = process.env['LYNOX_CALENDAR_ENABLED'];
  if (calendarRead === 'true' || calendarRead === '1') {
    merged.calendar_enabled = true;
  } else if (calendarRead === 'false' || calendarRead === '0') {
    merged.calendar_enabled = false;
  }
  // Extended debug capture (operator surface). Lets the CP flip it per-tenant via env
  // (rafael canary first) without editing config.json. Explicit 'true'/'1' vs 'false'/
  // '0' (no z.coerce). NOT in PROJECT_SAFE_KEYS — a project config must not be able to
  // start persisting the fully-assembled request (an agent-writable flag would let
  // injected content enable capture of what every subsequent turn sent to the model).
  const debugWireCapture = process.env['LYNOX_DEBUG_WIRE_CAPTURE'];
  if (debugWireCapture === 'true' || debugWireCapture === '1') {
    merged.debug_wire_capture = true;
  } else if (debugWireCapture === 'false' || debugWireCapture === '0') {
    merged.debug_wire_capture = false;
  }
  // Outbound egress policy. Lets the CP set it per-tenant via env without
  // editing config.json (the CP env emit itself is a separate slice). Explicit
  // enum parse — an unrecognised value is ignored (falls back to config/default
  // 'allow-all'), never coerced. NOT in PROJECT_SAFE_KEYS: a project config must
  // not be able to weaken a user/operator-set egress policy.
  const netPolicy = process.env['LYNOX_NETWORK_POLICY'];
  if (netPolicy === 'allow-all' || netPolicy === 'allow-list' || netPolicy === 'deny-all' || netPolicy === 'guarded') {
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
  // env-as-SEED (not lock): a persisted file/project `default_tier` — the user's
  // "Main chat model" picker choice — WINS; the CP env only seeds a fresh
  // instance that has none. The env var's contract is a floor/default, not a hard
  // override (env-abi-contract.ts), and this mirrors `LYNOX_LLM_PROVIDER`, which
  // is deliberately unpinned so the in-app provider switch works. Contrast
  // `max_tier` below, which STAYS env-wins because it is the cost ceiling/lock.
  const defaultTier = envTier('LYNOX_DEFAULT_MODEL_TIER');
  if (defaultTier && merged.default_tier === undefined) merged.default_tier = defaultTier;
  // Balanced-tier Sonnet selection. The CP (or a self-host operator) can flip a
  // tenant to Sonnet 5 via env without editing config.json. Assigned as-is; an
  // unrecognised value is validated + safely defaulted at resolveBalancedModel
  // (never routes balanced off-Sonnet), so no enum gate is needed here.
  const balancedModel = process.env['LYNOX_BALANCED_MODEL'];
  if (balancedModel !== undefined && balancedModel.trim() !== '') {
    merged.balanced_model = balancedModel.trim();
  }
  // Max model tier cap (managed hosting cost control — pipelines and run-options
  // are clamped): `LYNOX_MAX_MODEL_TIER` (canonical) / legacy `LYNOX_MAX_TIER`.
  const maxTier = envTier('LYNOX_MAX_MODEL_TIER');
  if (maxTier) merged.max_tier = maxTier;
  // Model blocklist: comma-separated model-id PREFIXES the engine refuses to
  // run (`LYNOX_BLOCKED_MODEL_IDS`, e.g. "claude-opus-"). Mirrors `max_tier`:
  // env WINS unconditionally over config.json — it is a lock, not a seed.
  // Unset/blank env leaves any file-config value in place; no value at all =
  // nothing blocked (byte-identical default path).
  const blockedModelIdsRaw = process.env['LYNOX_BLOCKED_MODEL_IDS'];
  if (blockedModelIdsRaw !== undefined && blockedModelIdsRaw.trim() !== '') {
    merged.blocked_model_ids = parseBlockedModelIds(blockedModelIdsRaw);
  }
  // Compaction summarizer tier (Slice A, issue #72 cost). A cost-control knob,
  // not a user preference (no UI picker) — mirrors `max_tier` above: env WINS
  // unconditionally rather than only seeding an unset value, so the CP can
  // guarantee every tenant's compaction runs cheap regardless of a stale/
  // hand-edited config.json. Default (when neither env nor config.json set it)
  // is applied at the read site (session.ts), not here.
  const compactionModel = envTier('LYNOX_COMPACTION_MODEL');
  if (compactionModel) merged.compaction_model = compactionModel;
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
  // Model blocklist × worker profile: background tasks run on the profile's raw
  // model_id WITHOUT passing through the tier-resolver chokepoint, so a blocked
  // worker profile must be cleared here (graceful degrade to the main provider,
  // where the resolver enforces the same blocklist) — same shape as the
  // dangling-profile guard above.
  if (merged.worker_profile) {
    const workerProfile = merged.model_profiles?.[merged.worker_profile];
    if (workerProfile && isBlockedModelId(workerProfile.model_id, merged.blocked_model_ids)) {
      merged.worker_profile = undefined;
    }
  }
  // Provider-agnostic routing (PR-3d): cp_supplied mirrors the billing-tier
  // key-custody flag (managed/managed_pro) so the managed tier_set allowlist can
  // gate on it. Canonical LYNOX_BILLING_TIER, legacy LYNOX_MANAGED_MODE alias.
  if (cpSuppliesLLMKey(readEnvAlias('LYNOX_BILLING_TIER'))) merged.cp_supplied = true;
  // CP-pinned preset (`LYNOX_TIER_PRESET`) — a SEED, not a lock: it fills an
  // EMPTY `tier_preset` and never overwrites one the tenant chose.
  //
  // Close to `default_tier` above but NOT the same predicate, and the difference
  // is deliberate: `default_tier` has no null state, while `tier_preset` is
  // `.nullable()` so the picker can CLEAR it. `!merged.tier_preset` would
  // conflate that clear with "never chose" and re-seed over it, so absence and
  // an explicit null are handled separately below. The seed also RESCUES an
  // unresolvable persisted name, which `default_tier` never has to.
  //
  // It used to overwrite, argued as "the preset picks the PROVIDER, and on the
  // CP-keyed tiers that set is DPA-disclosed and CP-paid, so it is an operator
  // decision". Two things broke that argument, both measured on staging
  // 2026-08-17 against a live CP pin:
  //  1. It was never a lock in the direction that mattered. A tenant writing
  //     explicit `tier_set` slots already beat the pin, because the expansion
  //     below spreads config.json slots OVER the preset's. So the "operator
  //     decision" was enforced against the settings picker and nothing else.
  //  2. Against the picker it did not fail loudly, it failed SILENTLY. The write
  //     gate accepted the tenant's preset (200), it persisted, `/api/config`
  //     reported it as their setting — and the loader discarded it. The settings
  //     surface showed a selection that did nothing, next to an `active_model`
  //     that disagreed with it, with `locks.tier_preset` unset because that
  //     channel only ever described preset AVAILABILITY.
  // Seeding removes both: the tenant's choice takes effect, so the surface stops
  // lying, and the pin still decides for every tenant who has not chosen — which
  // is the case it was actually built for (an instance sitting on default
  // Anthropic routing while a paid-for provider went unused).
  //
  // Placed BEFORE the expansion below so a seeded name goes through the same
  // fail-closed validation as a config.json one — an unknown preset must throw
  // for the CP too, not resolve to something else.
  //
  // A blank tenant value is not a choice. Left as-is it would suppress the seed
  // AND reach the fail-closed expander below, which THROWS — and the engine
  // ctor's loadConfig() has no catch, so an effectively empty field would
  // crash-loop the container. Normalized away before anything reads it.
  if (typeof merged.tier_preset === 'string' && merged.tier_preset.trim() === '') {
    delete merged.tier_preset;
  }
  const envPreset = process.env['LYNOX_TIER_PRESET']?.trim();
  if (envPreset !== undefined && envPreset !== '') {
    const chosen = merged.tier_preset;
    // A PERSISTED `routing_mode` is the tenant saying "I picked a routing
    // strategy", and it is the only signal that survives the write path.
    //
    // The picker sends `tier_preset: null` for both Standard and Custom, and the
    // PUT merge loop DELETES a null key — so by the time the loader runs, "chose
    // Standard" and "never chose anything" are the same `undefined`, and the
    // seed silently reverted the tenant to hybrid on the very reload their own
    // save triggered. `routing_mode` is not null in either message, so it
    // persists: `'standard'` for Standard, `'hybrid'` for Custom. A tenant who
    // picks a PRESET sends no `routing_mode` at all — so its presence means
    // exactly "Standard or Custom was chosen", which is what has to block the
    // seed. Absent means never chosen, which is the case the pin was built for.
    //
    // Read BEFORE the expander below: that sets `merged.routing_mode` itself, so
    // afterwards this would be reading its own output.
    const choseOwnRouting = merged.routing_mode !== undefined;
    if (chosen === null || choseOwnRouting) {
      // An explicit `null` is the picker's CLEAR — the schema is `.nullable()`
      // precisely so it can express "no preset". That IS a choice, so the seed
      // must not overwrite it. (Distinct from absent: `!chosen` would conflate
      // the two, which is why this is not the `!merged.tier_preset` shorthand.)
      // Reachable by hand-edit only, since the writer deletes the key —
      // `choseOwnRouting` is what covers the case the product can actually
      // produce, and it also stops a PARTIAL custom tier_set from being quietly
      // completed out of the pin by the spread below.
    } else if (chosen === undefined || !expandTierPreset(chosen)) {
      // Absent → seed, the normal case. Present but UNRESOLVABLE → the pin also
      // RESCUES, and that half is load-bearing: while the pin overwrote, it
      // masked any stale name in config.json. Without the rescue, retiring a
      // preset from TIER_PRESETS would crash-loop every tenant who had it
      // persisted, with no way back — the settings UI needed to clear it is
      // served by the container that will not boot.
      //
      // The pin's OWN name is validated here, and only here. Nothing downstream
      // does it: the CP checks the name once at write time against its vendored
      // vocabulary and then emits it raw forever, so a name the CP knows and the
      // RUNNING engine image does not walks straight into the fail-closed
      // expander below and takes the container down on the next sync-env. That
      // skew is structural rather than hypothetical — the CP redeploys on release
      // dispatch while the fleet rolls out manually, and a pinned instance is
      // skipped by rollouts indefinitely, so it can widen without bound.
      //
      // Ignoring is the right failure here, and the fail-closed argument does not
      // carry across: the expander throws on a TENANT-chosen name because that
      // means the tenant's persisted state is corrupt, whereas an unknown pin
      // degrades to exactly the documented meaning of an unset one — "the engine
      // keeps its own default routing". That is standard routing on the base
      // provider: no tier_set, no unregistered model, hence none of the
      // FALLBACK_CAPABILITY misbilling that justifies the throw. The operator can
      // also see and undo a pin; the tenant cannot restart their own container.
      //
      // The persisted name goes WITH it. An unresolvable pin cannot rescue an
      // unresolvable `chosen`, and those two fail together in exactly the skew
      // this guard exists for — pin an instance to an older image and both the
      // tenant's name and the CP's are drawn from a vocabulary that engine does
      // not have. Leaving `chosen` standing there would fall straight into the
      // expander and crash-loop the container, with the settings UI needed to
      // clear it served by the container that will not boot. Dropping it means
      // the instance boots on its own default routing, which is what an absent
      // preset has always meant, and the surface to fix it is reachable.
      if (expandTierPreset(envPreset)) merged.tier_preset = envPreset;
      // The unresolvable-`chosen` case is NOT handled here — see the block below.
      // Putting it here was a real bug: this arm is unreachable whenever the first
      // arm short-circuits, i.e. for every tenant carrying a persisted
      // `routing_mode`, which the settings writer plants permanently after any
      // Standard/Custom pick. The rescue was off for exactly the tenants who use
      // the picker most, and off entirely for every instance with no pin at all —
      // which is the majority, since the pin is emitted only when set.
    }
  }
  // Warn whether or not the seed branch was entered. Scoping this to the branch
  // meant a fleet-wide bad pin logged only on the subset that would have adopted
  // it — the instances with a tenant preset stayed silent, so the lines could not
  // even be counted. This is the operator's only stdout signal; the machine-
  // readable one is `env_overrides.tier_preset_ignored` on GET /api/config.
  if (envPreset !== undefined && envPreset !== '' && !expandTierPreset(envPreset)) {
    const shown = describePinForDisplay(envPreset);
    console.warn(
      `[lynox] Ignoring LYNOX_TIER_PRESET="${shown}": this engine does not know that preset. ` +
      `Known: ${Object.keys(TIER_PRESETS).join(', ')}. Routing falls back to the instance default — ` +
      `re-pin once the engine is on a version that carries the name.`,
    );
  }
  // An unresolvable PERSISTED name never costs the boot — independent of the pin
  // and of `routing_mode`.
  //
  // This sat inside the seed's `else if` and was therefore unreachable in most of
  // the cases it was written for: the arm above short-circuits on
  // `choseOwnRouting`, which the settings writer plants permanently in config.json
  // after any Standard/Custom pick, and the whole block only runs when a pin is
  // set at all — while the pin is emit-when-set, so most instances have none. The
  // motivating scenario ("retiring a preset would crash-loop every tenant who had
  // it persisted, with no way back") is precisely the no-pin case, and it was the
  // one case the guard could not reach.
  //
  // The throw it replaces bought nothing: an absent preset means the instance's
  // own default routing, so there is no tier_set, no unregistered model, and none
  // of the misbilling that justifies failing closed. It cost a container that will
  // not start, with the settings UI needed to clear the value served BY that
  // container. The fail-closed guard that does guard money — a preset that
  // RESOLVES but names a model absent from MODEL_CAPABILITIES — is untouched below.
  if (typeof merged.tier_preset === 'string' && !expandTierPreset(merged.tier_preset)) {
    const shown = describePinForDisplay(merged.tier_preset);
    merged.tier_preset = undefined;
    console.warn(
      `[lynox] Ignoring tier_preset "${shown}" from config.json: this engine does not know it. ` +
      `Known: ${Object.keys(TIER_PRESETS).join(', ')}. The instance keeps its own default routing; ` +
      `pick a strategy again in Settings to replace it.`,
    );
  }
  // Named hybrid strategy (model-presets, W2): a `tier_preset` from config.json
  // materializes to {routing_mode:'hybrid', tier_set} from the shared TIER_PRESETS
  // SoT. This is the config.json SOURCE path — placed BEFORE the LYNOX_TIER_SET_JSON
  // env block (so an env slot still wins per-slot) and BEFORE the managed-hardening
  // call (so a managed tenant's preset is still allowlist-gated). FAIL-CLOSED: an
  // unknown preset name, or a preset referencing a model absent from
  // MODEL_CAPABILITIES, THROWS — never a silent fallthrough to the Opus-rate
  // FALLBACK_CAPABILITY (a ~9-100× misbill + a false disclosure).
  if (merged.tier_preset) {
    const expanded = expandTierPreset(merged.tier_preset);
    if (!expanded) {
      throw new Error(
        `Unknown tier_preset "${merged.tier_preset}". Known presets: ${Object.keys(TIER_PRESETS).join(', ')}.`,
      );
    }
    // The preset is the base; an explicit config.json tier_set slot overrides it
    // per-slot, and the env block below overrides both (spread-last wins).
    merged.tier_set = { ...expanded.tier_set, ...merged.tier_set };
    merged.routing_mode = expanded.routing_mode;
    // FAIL-CLOSED over the FINAL merged slots (not just the preset's): a config.json
    // `tier_set` slot layered onto a preset must not smuggle an unregistered model
    // past the guard into the Opus-rate FALLBACK_CAPABILITY (a ~9-100× misbill + a
    // false disclosure).
    for (const slot of Object.values(merged.tier_set)) {
      if (slot && !modelCapability(slot.model_id)) {
        throw new Error(
          `tier_preset "${merged.tier_preset}" resolves to an unregistered model "${slot.model_id}" — refusing to load (it would misbill at the Opus fallback rate and mis-disclose). Register the model in MODEL_CAPABILITIES first.`,
        );
      }
    }
  }
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
    merged.tier_set = applyManagedTierSetConstraints(merged.tier_set, merged.blocked_model_ids);
    if (Object.keys(merged.tier_set).length === 0) {
      merged.tier_set = undefined;
      merged.routing_mode = 'standard';
      // The NAME has to go with the slots. Both all-Fireworks presets lose every
      // slot here when the credential is not provisioned, and leaving the name
      // behind made `/api/config` — and therefore the strategy picker — report a
      // preset as in effect while `routing_mode` said `standard` and every band
      // ran on the base provider. That is the silent-degradation shape the engine
      // already refuses on the tenant write path, arriving through the operator
      // path instead, and it costs real money: two of three presets exist to route
      // AWAY from the expensive base model.
      //
      // Provenance-independent on purpose. Whether the name came from the tenant's
      // config.json or a CP pin, no surface may claim a routing that is not
      // running — and the two are indistinguishable by this point anyway.
      const dropped = merged.tier_preset;
      merged.tier_preset = undefined;
      // And SAY so. This is the expensive case, not the unknown-name one: the
      // name resolves fine, so the ignore-warning above never fires, while every
      // band quietly moves to the base model. On the two Fireworks presets that
      // is roughly a tenfold price increase on the slot that runs every turn —
      // correctly metered, and therefore invisible until the invoice.
      if (dropped) {
        console.warn(
          `[lynox] tier_preset "${dropped}" resolved but none of its slots could be backed ` +
          `(missing provider credential or operator opt-in). Routing falls back to the base ` +
          `model for every band, which is materially more expensive. Provision the credential ` +
          `or pin a preset this instance can serve.`,
        );
      }
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
  // `api_key` is the LEGACY field that pre-vault callers (spawn, pipeline,
  // plan-task, process, the orchestrator) pair directly with `api_base_url`. It
  // therefore has to hold a key that BELONGS to that endpoint.
  //
  // Above, it is filled unconditionally from `ANTHROPIC_API_KEY` — the documented
  // Docker env var. That is right for the Anthropic wire and wrong for every other
  // one: on `provider: 'openai'` the endpoint may be Mistral, Groq, Together, or a
  // local Ollama, and handing any of them the Anthropic key is a cross-vendor
  // credential leak (plaintext over http, in the loopback case). The old code
  // special-cased exactly ONE endpoint — Mistral — and left the rest holding the
  // Anthropic key. Generalise it: derive the key from the endpoint, for every
  // endpoint.
  if (merged.provider === 'openai') {
    // ONLY for an endpoint lynox pins by host. A host that fell through to the
    // generic tile must not be promoted from the shared slot — that is how a
    // spoofed `api.mistral.ai.evil.com` would be handed the Mistral key, and how a
    // user's own configured `api_key` would be overwritten by a vendor key that
    // has nothing to do with their endpoint.
    const slot = pinnedVaultSlotForEndpoint('openai', merged.api_base_url);
    const fromSlot = slot ? process.env[slot] : undefined;

    if (fromSlot && fromSlot.length > 0) {
      // This endpoint's own key. (For Mistral this is the historic promotion,
      // unchanged; for Groq/Ollama/… it is the new, correctly-scoped one.)
      merged.api_key = fromSlot;
    } else if (merged.api_key === anthropicEnvKey && anthropicEnvKey) {
      // The unconditional ANTHROPIC_API_KEY promotion above does not belong on
      // ANY openai endpoint — pinned (Groq, Ollama) OR generic (OpenRouter,
      // DeepSeek, a bare proxy that fell through to the openai-compat tile).
      // Leaving it there sends the Anthropic key to that endpoint via the raw
      // config.api_key consumers.
      //
      // This is the SAME rule the vault path applies in engine-init via
      // `anthropicKeyMayHoldApiKey` (false for 'openai'). The two must strip for
      // the same set of endpoints — the leak survived a round precisely because
      // this path was narrowed to pinned-only while the vault path was not.
      if (configFileApiKey) merged.api_key = configFileApiKey;
      else delete merged.api_key;
    }

    if (isMistralHost(merged.api_base_url) && !merged.openai_model_id) {
      // Single-model fallback when the UI/CP staged no explicit model. Tier
      // routing (fast/balanced/deep) is wired separately via MISTRAL_MODEL_MAP —
      // see setOpenAIModelResolver. A pinned versioned snapshot (not `*-latest`)
      // keeps behaviour reproducible across Mistral model refreshes.
      merged.openai_model_id = 'mistral-large-2512';
    }
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
