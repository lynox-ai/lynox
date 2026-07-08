/**
 * Environment-variable reader with permanent canonical→legacy read-aliases.
 *
 * The naming-migration window renames several CP→engine and self-host env vars
 * to one consistent scheme (`LYNOX_<noun>`). Per the established alias-forever
 * pattern, the OLD names are accepted **forever**: the engine reads the
 * canonical name first and falls back to every legacy name, so a tenant running
 * a pre-rename `.env` (restored backup, pinned canary, an old self-host setup)
 * keeps working with no drop-old-read step ever.
 *
 * The control plane emits the canonical name only once the whole fleet reads it
 * (the migration's order-of-operations); until then the legacy emit keeps these
 * reads satisfied. `ENV_ALIASES` is the single declaration of which names the
 * engine honours — `tests/doc-drift.test.ts` pins it so a consume-side rename
 * that drops either the canonical or a legacy name fails CI.
 */
import type { ModelTier } from '../types/index.js';
import { normalizeTier } from '../types/index.js';

/**
 * Canonical env var → its accepted legacy alias names, in fallback order.
 * Add a pair here (and migrate the read to `readEnvAlias`/`envTier`) when a var
 * is renamed; never remove a legacy name (the read-alias is permanent).
 */
export const ENV_ALIASES = {
  LYNOX_BILLING_TIER: ['LYNOX_MANAGED_MODE'],
  LYNOX_MAX_MODEL_TIER: ['LYNOX_MAX_TIER'],
  LYNOX_DEFAULT_MODEL_TIER: ['LYNOX_DEFAULT_TIER'],
  LYNOX_API_BASE_URL: ['ANTHROPIC_BASE_URL'],
  LYNOX_DATA_DIR: ['LYNOX_DIR'],
  // No legacy name (new var) — routed through this registry anyway so it reads
  // via the single vetted `envTier` helper, keeping legacy Anthropic-brand
  // values (haiku/sonnet/opus) accepted consistently with every other tier var.
  LYNOX_COMPACTION_MODEL: [],
} as const satisfies Record<string, readonly string[]>;

export type CanonicalEnvName = keyof typeof ENV_ALIASES;

/**
 * First non-empty value among the given env var names, in order. An unset OR
 * empty-string var is skipped — an empty env var means "not provided" here.
 */
function envFirst(...names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

/**
 * Read a renamed env var by its canonical name, falling back to every
 * registered legacy alias. The canonical name wins when both are set.
 */
export function readEnvAlias(canonical: CanonicalEnvName): string | undefined {
  return envFirst(canonical, ...ENV_ALIASES[canonical]);
}

/**
 * Read a model-tier env var (canonical + legacy aliases) through
 * `normalizeTier`, so both the canonical band names (`fast|balanced|deep`) and
 * the legacy Anthropic-brand names (`haiku|sonnet|opus`) are accepted.
 * Returns undefined for an unset or unrecognized value.
 */
export function envTier(canonical: CanonicalEnvName): ModelTier | undefined {
  const raw = readEnvAlias(canonical);
  return raw === undefined ? undefined : normalizeTier(raw);
}
