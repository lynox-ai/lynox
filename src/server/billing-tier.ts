/**
 * Billing/hosting tier — pure re-export shim over the wire-contract module
 * (`src/contract/vocab.ts`), which is the SINGLE SOURCE OF TRUTH for the
 * shared core↔pro vocabulary (K-W1, PRD-CORE-PRO-CONTRACT / DEF-0030).
 *
 * The tier string arrives via the `LYNOX_MANAGED_MODE` env var, set by the CP
 * at provision/sync time. Legacy values (`starter`, `eu`) are still accepted so
 * an instance running a pre-rename env keeps working until it is re-synced.
 *
 * NOTE: this is the BILLING tier (hosting plan), NOT the model tier
 * (`deep`/`balanced`/`fast`) — a different axis.
 */

export type { BillingTier } from '../contract/vocab.js';
export { normalizeBillingTier, isHostedInstance, cpSuppliesLLMKey } from '../contract/vocab.js';
