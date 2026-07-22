/**
 * Symbols whose SINGLE SOURCE OF TRUTH moved into `src/contract/`. The
 * orphan-twin drift test (`tests/contract-drift.test.ts`) fails CI when any of
 * these is REDEFINED locally anywhere in `src/` or `packages/web-ui/src/`
 * outside the contract dirs — pure re-export shims (export-from statements
 * only, no local declaration) are the one permitted form.
 *
 * Add a row when a symbol migrates into the contract; never remove one without
 * migrating the symbol back out deliberately.
 */
export interface MigratedSymbol {
  /** Exported symbol name. */
  name: string;
  /** Contract file that owns it now. */
  contractFile: 'vocab.ts' | 'shapes.ts';
  /** The declaration pattern the orphan-twin test hunts (regex source, applied per line). */
  twinPattern: string;
}

export const MIGRATED: readonly MigratedSymbol[] = [
  { name: 'BillingTier', contractFile: 'vocab.ts', twinPattern: 'type\\s+BillingTier\\s*=' },
  // Function/const patterns are anchored past the name (`(`, `=` or `:`) so a
  // deliberately-differently-named delegating helper (e.g. web-ui's
  // `cpSuppliesLLMKeyForInstance`) is not a prefix false-positive.
  { name: 'LEGACY_BILLING_TIER_ALIASES', contractFile: 'vocab.ts', twinPattern: 'const\\s+LEGACY_BILLING_TIER_ALIASES\\s*[=:]' },
  { name: 'normalizeBillingTier', contractFile: 'vocab.ts', twinPattern: 'function\\s+normalizeBillingTier\\s*\\(' },
  { name: 'isHostedInstance', contractFile: 'vocab.ts', twinPattern: 'function\\s+isHostedInstance\\s*\\(' },
  { name: 'cpSuppliesLLMKey', contractFile: 'vocab.ts', twinPattern: 'function\\s+cpSuppliesLLMKey\\s*\\(' },
  { name: 'ModelTier', contractFile: 'vocab.ts', twinPattern: 'type\\s+ModelTier\\s*=' },
  { name: 'LEGACY_TIER_ALIASES', contractFile: 'vocab.ts', twinPattern: 'const\\s+LEGACY_TIER_ALIASES\\s*[=:]' },
  { name: 'normalizeTier', contractFile: 'vocab.ts', twinPattern: 'function\\s+normalizeTier\\s*\\(' },
  { name: 'AccountTier', contractFile: 'vocab.ts', twinPattern: 'type\\s+AccountTier\\s*=' },
  { name: 'LLMProvider', contractFile: 'vocab.ts', twinPattern: 'type\\s+LLMProvider\\s*=' },
  { name: 'NetworkPolicy', contractFile: 'vocab.ts', twinPattern: 'type\\s+NetworkPolicy\\s*=' },
  { name: 'ModelProfile', contractFile: 'shapes.ts', twinPattern: 'interface\\s+ModelProfile\\s' },
  { name: 'isModelProfile', contractFile: 'shapes.ts', twinPattern: 'function\\s+isModelProfile\\s*\\(' },
];
