/**
 * Symbols whose SINGLE SOURCE OF TRUTH moved into `src/contract/`. The
 * orphan-twin drift test (`tests/contract-drift.test.ts`) fails CI when any of
 * these is REDEFINED locally anywhere in `src/` or `packages/web-ui/src/`
 * outside the contract dirs — pure re-export shims (export-from statements
 * only, no local declaration) are the one permitted form.
 *
 * Add a row when a symbol migrates into the contract; never remove one without
 * migrating the symbol back out deliberately.
 *
 * Pattern rules (each `twinPattern` is a regex source, applied per line):
 * - Anchored on a DECLARATION keyword (`type`/`interface`, `function`/`const`/
 *   `let`/`var`) so re-export shims (`export { X } from …`) and call sites
 *   never match.
 * - Anchored past the name (`=`, `(`, `:`, or a word boundary) so a
 *   deliberately-differently-named delegating helper (e.g. web-ui's
 *   `cpSuppliesLLMKeyForInstance`) is not a prefix false-positive.
 * - Known limitation: an object/class METHOD named like a migrated function
 *   (`normalizeTier(v) { … }`) is not hunted — any pattern for it would also
 *   match ordinary call sites. The sweep is a drift tripwire, not a parser.
 */
export interface MigratedSymbol {
  /** Exported symbol name. */
  name: string;
  /** Contract file that owns it now. */
  contractFile: 'vocab.ts' | 'shapes.ts' | 'env-registry.ts';
  /** The declaration pattern the orphan-twin test hunts (regex source, applied per line). */
  twinPattern: string;
}

// Anchored past the name on a declaration continuation (`=`, `{`, `<`,
// `extends`) so inline type-imports (`import { type BillingTier } from …`)
// never match.
const typeTwin = (name: string): string => `\\b(?:type|interface)\\s+${name}\\s*(?:=|\\{|<|extends\\b)`;
const valueTwin = (name: string): string => `\\b(?:function|const|let|var)\\s+${name}\\s*[=(:]`;

export const MIGRATED: readonly MigratedSymbol[] = [
  { name: 'BillingTier', contractFile: 'vocab.ts', twinPattern: typeTwin('BillingTier') },
  { name: 'LEGACY_BILLING_TIER_ALIASES', contractFile: 'vocab.ts', twinPattern: valueTwin('LEGACY_BILLING_TIER_ALIASES') },
  { name: 'CANONICAL_BILLING_TIERS', contractFile: 'vocab.ts', twinPattern: valueTwin('CANONICAL_BILLING_TIERS') },
  { name: 'normalizeBillingTier', contractFile: 'vocab.ts', twinPattern: valueTwin('normalizeBillingTier') },
  { name: 'isHostedInstance', contractFile: 'vocab.ts', twinPattern: valueTwin('isHostedInstance') },
  { name: 'cpSuppliesLLMKey', contractFile: 'vocab.ts', twinPattern: valueTwin('cpSuppliesLLMKey') },
  { name: 'ModelTier', contractFile: 'vocab.ts', twinPattern: typeTwin('ModelTier') },
  { name: 'LEGACY_TIER_ALIASES', contractFile: 'vocab.ts', twinPattern: valueTwin('LEGACY_TIER_ALIASES') },
  { name: 'normalizeTier', contractFile: 'vocab.ts', twinPattern: valueTwin('normalizeTier') },
  { name: 'AccountTier', contractFile: 'vocab.ts', twinPattern: typeTwin('AccountTier') },
  { name: 'LLMProvider', contractFile: 'vocab.ts', twinPattern: typeTwin('LLMProvider') },
  { name: 'NetworkPolicy', contractFile: 'vocab.ts', twinPattern: typeTwin('NetworkPolicy') },
  { name: 'ModelProfile', contractFile: 'shapes.ts', twinPattern: typeTwin('ModelProfile') },
  { name: 'isModelProfile', contractFile: 'shapes.ts', twinPattern: valueTwin('isModelProfile') },
  // Not migrated FROM anywhere (born in the contract), but vendored downstream —
  // a local re-declaration would be the same silent-divergence failure mode.
  { name: 'ENV_REGISTRY', contractFile: 'env-registry.ts', twinPattern: valueTwin('ENV_REGISTRY') },
  { name: 'ENV_REGISTRY_BY_NAME', contractFile: 'env-registry.ts', twinPattern: valueTwin('ENV_REGISTRY_BY_NAME') },
  { name: 'SELF_HOST_ONLY', contractFile: 'env-registry.ts', twinPattern: valueTwin('SELF_HOST_ONLY') },
  { name: 'PREFIX_FAMILIES', contractFile: 'env-registry.ts', twinPattern: valueTwin('PREFIX_FAMILIES') },
];
