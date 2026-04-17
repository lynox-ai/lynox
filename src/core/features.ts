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
  | 'whatsapp-inbox';

// Core feature flags (immutable)
const CORE_FEATURE_ENV_MAP: Record<FeatureFlag, string> = {
  'plugins': 'LYNOX_FEATURE_PLUGINS',
  'flat-file-memory': 'LYNOX_FEATURE_FLAT_FILE_MEMORY',
  'whatsapp-inbox': 'LYNOX_FEATURE_WHATSAPP_INBOX',
};

const CORE_FEATURE_DEFAULTS: Record<FeatureFlag, boolean> = {
  'plugins': true,
  'flat-file-memory': true,
  // Phase-0 BYOK pilot. Off by default — flip to `true` when the feature graduates.
  'whatsapp-inbox': false,
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
