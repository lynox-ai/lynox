/**
 * Feature flags for gating experimental functionality.
 *
 * v1.0 — all flags OFF by default (core CLI only).
 * v1.1 — flip defaults to ON as features stabilize.
 *
 * Set via environment variables: LYNOX_FEATURE_<FLAG>=1
 * Pro packages can register additional flags via registerFeature().
 */

export type FeatureFlag =
  | 'plugins'
  | 'flat-file-memory'
  | 'whatsapp-inbox'
  | 'unified-inbox'
  | 'api-setup-v2'
  | 'api-cost-display';

// Core feature flags (immutable)
const CORE_FEATURE_ENV_MAP: Record<FeatureFlag, string> = {
  'plugins': 'LYNOX_FEATURE_PLUGINS',
  'flat-file-memory': 'LYNOX_FEATURE_FLAT_FILE_MEMORY',
  'whatsapp-inbox': 'LYNOX_FEATURE_WHATSAPP_INBOX',
  'unified-inbox': 'LYNOX_FEATURE_UNIFIED_INBOX',
  'api-setup-v2': 'LYNOX_FEATURE_API_SETUP_V2',
  'api-cost-display': 'LYNOX_FEATURE_API_COST_DISPLAY',
};

const CORE_FEATURE_DEFAULTS: Record<FeatureFlag, boolean> = {
  'plugins': true,
  'flat-file-memory': true,
  // Phase-0 BYOK pilot. Off by default — flip to `true` when the feature graduates.
  'whatsapp-inbox': false,
  // PRD-UNIFIED-INBOX Phase 1a foundation. Off by default — flip on when the
  // /app/inbox UI ships in Phase 1b and the classifier has been piloted.
  'unified-inbox': false,
  // PRD-UNIFIED-API-PROFILE-V2 Phase B. Gates `api_setup bootstrap docs_url=…`
  // (Haiku-extracted v2 profile draft). Default-on as of the HN-launch — Smart
  // Bootstrap is the headline differentiator and self-hosters need it
  // out-of-the-box. Set LYNOX_FEATURE_API_SETUP_V2=0 to disable.
  'api-setup-v2': true,
  // PRD-UNIFIED-API-PROFILE-V2 Phase E. Surfaces per-call cost in the tool_result
  // block + a thread-footer API rollup when an ApiProfile carries a `cost` field
  // (per_call only — per_token / per_unit are deferred). Off by default; users
  // opt in once their own keys are configured. The public demo MUST NOT route
  // through paid APIs (DataForSEO etc.) — that would charge the lynox.ai bill
  // for anonymous traffic; demo instances use only the Meridian seed data plus
  // bundled web_search.
  'api-cost-display': false,
};

// Dynamic registry for Pro/plugin feature flags
const _dynamicEnvMap = new Map<string, string>();
const _dynamicDefaults = new Map<string, boolean>();

/**
 * Register a dynamic feature flag (for Pro or plugins).
 */
export function registerFeature(flag: string, envVar: string, defaultValue: boolean): void {
  _dynamicEnvMap.set(flag, envVar);
  _dynamicDefaults.set(flag, defaultValue);
}

/**
 * Check if a feature flag is enabled.
 * Resolution: env var > default. Accepts core flags and dynamically registered flags.
 */
export function isFeatureEnabled(flag: FeatureFlag | string): boolean {
  // Check core flags first
  const coreEnvVar = CORE_FEATURE_ENV_MAP[flag as FeatureFlag];
  const envVar = coreEnvVar ?? _dynamicEnvMap.get(flag);
  if (!envVar) return false;

  const value = process.env[envVar];
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;

  return CORE_FEATURE_DEFAULTS[flag as FeatureFlag] ?? _dynamicDefaults.get(flag) ?? false;
}

/**
 * Get all feature flags and their current state.
 */
export function getFeatureFlags(): Record<string, boolean> {
  const flags: Record<string, boolean> = {};
  for (const flag of Object.keys(CORE_FEATURE_ENV_MAP) as FeatureFlag[]) {
    flags[flag] = isFeatureEnabled(flag);
  }
  for (const flag of _dynamicEnvMap.keys()) {
    flags[flag] = isFeatureEnabled(flag);
  }
  return flags;
}

/**
 * Get the env var name for a feature flag.
 */
export function getFeatureEnvVar(flag: FeatureFlag | string): string | undefined {
  return CORE_FEATURE_ENV_MAP[flag as FeatureFlag] ?? _dynamicEnvMap.get(flag);
}

/**
 * Clear dynamic feature registry (for tests).
 */
export function clearDynamicFeatures(): void {
  _dynamicEnvMap.clear();
  _dynamicDefaults.clear();
}
