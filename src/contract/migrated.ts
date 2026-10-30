/**
 * Symbols whose SINGLE SOURCE OF TRUTH moved into `src/contract/`.
 *
 * VENDORED DOWNSTREAM — edit ONLY here (`core/src/contract/`); a vendored
 * copy of this file is read-only for its consumer.
 *
 * The orphan-twin drift test (`tests/contract-drift.test.ts`) fails CI when any of
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
  contractFile:
    | 'vocab.ts'
    | 'shapes.ts'
    | 'env-registry.ts'
    | 'broker-start.ts'
    | 'http.ts'
    | 'marker.ts'
    | 'fixtures/mirrors.ts';
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
  // K-W2 — money-HTTP + health wire shapes (born in the contract; a local
  // re-declaration downstream is the same silent-divergence failure mode).
  { name: 'UsageReportRun', contractFile: 'http.ts', twinPattern: typeTwin('UsageReportRun') },
  { name: 'UsageFlushRequest', contractFile: 'http.ts', twinPattern: typeTwin('UsageFlushRequest') },
  { name: 'UsageFlushResponse', contractFile: 'http.ts', twinPattern: typeTwin('UsageFlushResponse') },
  { name: 'SpendGate', contractFile: 'http.ts', twinPattern: typeTwin('SpendGate') },
  { name: 'UsageStatusResponse', contractFile: 'http.ts', twinPattern: typeTwin('UsageStatusResponse') },
  // Born in the contract: the exact-attach answer and the reader of `exact_held`.
  { name: 'ExactAttachRequest', contractFile: 'http.ts', twinPattern: typeTwin('ExactAttachRequest') },
  { name: 'EXACT_ATTACH_REFUSALS', contractFile: 'http.ts', twinPattern: valueTwin('EXACT_ATTACH_REFUSALS') },
  { name: 'ExactAttachRefusal', contractFile: 'http.ts', twinPattern: typeTwin('ExactAttachRefusal') },
  { name: 'isExactAttachRefusal', contractFile: 'http.ts', twinPattern: valueTwin('isExactAttachRefusal') },
  { name: 'ExactAttachResponse', contractFile: 'http.ts', twinPattern: typeTwin('ExactAttachResponse') },
  { name: 'isExactAttachCleared', contractFile: 'http.ts', twinPattern: valueTwin('isExactAttachCleared') },
  { name: 'readExactHeld', contractFile: 'http.ts', twinPattern: valueTwin('readExactHeld') },
  { name: 'UsageSummaryPeriod', contractFile: 'http.ts', twinPattern: typeTwin('UsageSummaryPeriod') },
  { name: 'UsageSummaryResponse', contractFile: 'http.ts', twinPattern: typeTwin('UsageSummaryResponse') },
  { name: 'HealthBody', contractFile: 'http.ts', twinPattern: typeTwin('HealthBody') },
  { name: 'TYPED_MIRRORS', contractFile: 'fixtures/mirrors.ts', twinPattern: valueTwin('TYPED_MIRRORS') },
  // K-W3 — auth + OAuth wire shapes.
  { name: 'MagicLinkVerifyRequest', contractFile: 'http.ts', twinPattern: typeTwin('MagicLinkVerifyRequest') },
  { name: 'MAGIC_LINK_ERROR_CODES', contractFile: 'http.ts', twinPattern: valueTwin('MAGIC_LINK_ERROR_CODES') },
  { name: 'MagicLinkErrorCode', contractFile: 'http.ts', twinPattern: typeTwin('MagicLinkErrorCode') },
  { name: 'isMagicLinkErrorCode', contractFile: 'http.ts', twinPattern: valueTwin('isMagicLinkErrorCode') },
  { name: 'BROKER_START_FAILURES', contractFile: 'http.ts', twinPattern: valueTwin('BROKER_START_FAILURES') },
  { name: 'BrokerStartFailure', contractFile: 'http.ts', twinPattern: typeTwin('BrokerStartFailure') },
  { name: 'OAUTH_DECLINE_CODES', contractFile: 'http.ts', twinPattern: valueTwin('OAUTH_DECLINE_CODES') },
  { name: 'OAuthDeclineCode', contractFile: 'http.ts', twinPattern: typeTwin('OAuthDeclineCode') },
  { name: 'isOAuthDeclineCode', contractFile: 'http.ts', twinPattern: valueTwin('isOAuthDeclineCode') },
  { name: 'AuthErrorBody', contractFile: 'http.ts', twinPattern: typeTwin('AuthErrorBody') },
  // Born in the contract: the login principal the control plane hands the web-ui.
  { name: 'LOGIN_PRINCIPAL_VERSION', contractFile: 'http.ts', twinPattern: valueTwin('LOGIN_PRINCIPAL_VERSION') },
  { name: 'AuthCodeRequest', contractFile: 'http.ts', twinPattern: typeTwin('AuthCodeRequest') },
  { name: 'AuthCodeVerifyRequest', contractFile: 'http.ts', twinPattern: typeTwin('AuthCodeVerifyRequest') },
  { name: 'MandateLoginPrincipal', contractFile: 'http.ts', twinPattern: typeTwin('MandateLoginPrincipal') },
  { name: 'AuthLoginSuccessBody', contractFile: 'http.ts', twinPattern: typeTwin('AuthLoginSuccessBody') },
  { name: 'readLoginPrincipal', contractFile: 'http.ts', twinPattern: valueTwin('readLoginPrincipal') },
  { name: 'OAuthClaimRequest', contractFile: 'http.ts', twinPattern: typeTwin('OAuthClaimRequest') },
  { name: 'OAuthClaimResponse', contractFile: 'http.ts', twinPattern: typeTwin('OAuthClaimResponse') },
  { name: 'OAuthClaimPreviewRequest', contractFile: 'http.ts', twinPattern: typeTwin('OAuthClaimPreviewRequest') },
  { name: 'OAuthClaimPreviewResponse', contractFile: 'http.ts', twinPattern: typeTwin('OAuthClaimPreviewResponse') },
  // Born in the contract rather than migrated into it (W5, PRD Stage 1 §3.4).
  // Listed anyway, and the reason is the sweep rather than the history: without a
  // row, a local re-declaration of one of these anywhere in `src/` or the web-ui
  // is invisible to `tests/contract-drift.test.ts`, which is the one thing that
  // keeps a second definition of a wire format from existing quietly.
  { name: 'BROKER_START_VERSION', contractFile: 'broker-start.ts', twinPattern: valueTwin('BROKER_START_VERSION') },
  { name: 'BROKER_START_TTL_SEC', contractFile: 'broker-start.ts', twinPattern: valueTwin('BROKER_START_TTL_SEC') },
  { name: 'BROKER_START_SKEW_SEC', contractFile: 'broker-start.ts', twinPattern: valueTwin('BROKER_START_SKEW_SEC') },
  { name: 'BROKER_START_PURPOSE', contractFile: 'broker-start.ts', twinPattern: valueTwin('BROKER_START_PURPOSE') },
  { name: 'BROKER_START_NONCE_BYTES', contractFile: 'broker-start.ts', twinPattern: valueTwin('BROKER_START_NONCE_BYTES') },
  { name: 'BrokerStartToken', contractFile: 'broker-start.ts', twinPattern: typeTwin('BrokerStartToken') },
  { name: 'brokerStartPayload', contractFile: 'broker-start.ts', twinPattern: valueTwin('brokerStartPayload') },
  { name: 'parseBrokerStartToken', contractFile: 'broker-start.ts', twinPattern: valueTwin('parseBrokerStartToken') },
  { name: 'formatBrokerStartToken', contractFile: 'broker-start.ts', twinPattern: valueTwin('formatBrokerStartToken') },
  // The shared golden vector. A same-named local copy is how one side would
  // quietly re-pick it. Two copies this sweep cannot see: one under ANOTHER
  // name, and one under `tests/`, which is outside its roots — which is why this
  // repo's minter test imports the constant rather than restating it.
  { name: 'BROKER_START_GOLDEN', contractFile: 'broker-start.ts', twinPattern: valueTwin('BROKER_START_GOLDEN') },
  // Engine → CP report shapes of the usage routes. Born in the contract; a local copy on
  // either side is how the two would drift apart.
  { name: 'ProviderIncidentRequest', contractFile: 'http.ts', twinPattern: typeTwin('ProviderIncidentRequest') },
  { name: 'EscalationNoticeRequest', contractFile: 'http.ts', twinPattern: typeTwin('EscalationNoticeRequest') },
  { name: 'ESCALATION_NOTICE_KINDS', contractFile: 'http.ts', twinPattern: valueTwin('ESCALATION_NOTICE_KINDS') },
  { name: 'EscalationNoticeKind', contractFile: 'http.ts', twinPattern: typeTwin('EscalationNoticeKind') },
  { name: 'isEscalationNoticeKind', contractFile: 'http.ts', twinPattern: valueTwin('isEscalationNoticeKind') },
  { name: 'OAuthRefreshRequest', contractFile: 'http.ts', twinPattern: typeTwin('OAuthRefreshRequest') },
  { name: 'OAuthRefreshResponse', contractFile: 'http.ts', twinPattern: typeTwin('OAuthRefreshResponse') },
  { name: 'OAuthRevokeRequest', contractFile: 'http.ts', twinPattern: typeTwin('OAuthRevokeRequest') },
  { name: 'OAuthRevokeResponse', contractFile: 'http.ts', twinPattern: typeTwin('OAuthRevokeResponse') },
  // Born in the contract: the handle-only claim and the Microsoft decline vocabulary.
  { name: 'OAuthHandleProvider', contractFile: 'http.ts', twinPattern: typeTwin('OAuthHandleProvider') },
  { name: 'OAuthHandleClaimResponse', contractFile: 'http.ts', twinPattern: typeTwin('OAuthHandleClaimResponse') },
  { name: 'MICROSOFT_OAUTH_DECLINE_CODES', contractFile: 'http.ts', twinPattern: valueTwin('MICROSOFT_OAUTH_DECLINE_CODES') },
  { name: 'MicrosoftOAuthDeclineCode', contractFile: 'http.ts', twinPattern: typeTwin('MicrosoftOAuthDeclineCode') },
  { name: 'isMicrosoftOAuthDeclineCode', contractFile: 'http.ts', twinPattern: valueTwin('isMicrosoftOAuthDeclineCode') },
  // Born in the contract: the Microsoft return parameters and the admin-consent status route.
  { name: 'MICROSOFT_OAUTH_CLAIM_PARAM', contractFile: 'http.ts', twinPattern: valueTwin('MICROSOFT_OAUTH_CLAIM_PARAM') },
  { name: 'MICROSOFT_OAUTH_ERROR_PARAM', contractFile: 'http.ts', twinPattern: valueTwin('MICROSOFT_OAUTH_ERROR_PARAM') },
  { name: 'AdminConsentStatusRequest', contractFile: 'http.ts', twinPattern: typeTwin('AdminConsentStatusRequest') },
  { name: 'AdminConsentStatusResponse', contractFile: 'http.ts', twinPattern: typeTwin('AdminConsentStatusResponse') },
  // K-W3 — the guarded-capable boot marker. The literal existed twice by hand
  // across the repo boundary; a local re-declaration is that failure returning.
  { name: 'GUARDED_CAPABLE_MARKER', contractFile: 'marker.ts', twinPattern: valueTwin('GUARDED_CAPABLE_MARKER') },
  { name: 'EGRESS_POLICY_LOG_PREFIX', contractFile: 'marker.ts', twinPattern: valueTwin('EGRESS_POLICY_LOG_PREFIX') },
  { name: 'guardedCapableBootLine', contractFile: 'marker.ts', twinPattern: valueTwin('guardedCapableBootLine') },
  { name: 'GUARDED_CAPABLE_LINE_ERE', contractFile: 'marker.ts', twinPattern: valueTwin('GUARDED_CAPABLE_LINE_ERE') },
  { name: 'guardedCapableLineRegex', contractFile: 'marker.ts', twinPattern: valueTwin('guardedCapableLineRegex') },
];
