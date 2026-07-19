/**
 * Host-level disclosure data for the model-presets three-axis disclosure
 * (PRD `model-presets.md` §P1b). This is the DATA SOURCE only — the picker (W4)
 * renders it and the managed write-gate (W3) reads it; nothing here decides
 * routing.
 *
 * The three axes, split by WHERE the fact lives:
 *   (a) HOST residency + (b) transfer basis + posture  → THIS file, keyed by host.
 *       A US host is a US host regardless of which model runs on it.
 *   (c) MODEL weights-provenance                        → `ModelCapability.provenance`
 *       (`WeightsOrigin` in types/models.ts). CN weights travel with the model
 *       even when served from a Western host (GLM/DeepSeek via Fireworks).
 *
 * R2 GATE (PRD §S5): a host's retention/security posture ('zero-retention',
 * 'SOC2', …) is only a factual claim once the provider contract is pinned. Until
 * then the disclosure MUST NOT assert it — see {@link FIREWORKS_CONTRACT_CONFIRMED}.
 */

/** Where a host processes data. Distinct from a model's weights-origin. */
export type HostResidency = 'US' | 'EU';

export interface HostDisclosure {
  /** Canonical host (matches the `endpoint-allowlist.ts` allowlist hosts). */
  host: string;
  /** Where data sent to this host is processed. */
  residency: HostResidency;
  /**
   * GDPR Chapter-V transfer basis for a non-EU host (e.g. 'SCC/DPF'), or `null`
   * for an EU host where no Chapter-V transfer occurs. Independent of retention:
   * a US host is a Chapter-V transfer even with zero retention.
   */
  transferBasis: string | null;
  /**
   * Retention/security posture note (e.g. 'zero-retention · SOC2'). Only a
   * FACTUAL claim when {@link HostDisclosure.postureConfirmed} is true (R2 gate);
   * while unconfirmed the picker must render the neutral fallback, not this text.
   */
  posture: string;
  /** R2 gate: is `posture` contractually confirmed (safe to assert in-product)? */
  postureConfirmed: boolean;
}

/**
 * R2 gate for the Fireworks host (PRD §S5). Flip to `true` ONLY when the Fireworks
 * DPA / sub-processor contract is pinned — that is what makes 'zero-retention ·
 * SOC2' a claim we may show. Until then the disclosure shows the neutral fallback.
 */
export const FIREWORKS_CONTRACT_CONFIRMED = false;

export const HOST_DISCLOSURES: Record<string, HostDisclosure> = {
  'api.anthropic.com': {
    host: 'api.anthropic.com',
    residency: 'US',
    transferBasis: 'SCC/DPF',
    posture: 'US · zero-retention (API default) · SOC2',
    postureConfirmed: true,
  },
  'api.mistral.ai': {
    host: 'api.mistral.ai',
    residency: 'EU',
    transferBasis: null,
    posture: 'EU-resident (France)',
    postureConfirmed: true,
  },
  'api.fireworks.ai': {
    host: 'api.fireworks.ai',
    residency: 'US',
    transferBasis: 'SCC/DPF',
    // R2-gated: only asserted once the contract is pinned (FIREWORKS_CONTRACT_CONFIRMED).
    posture: 'US · zero-retention · SOC2',
    postureConfirmed: FIREWORKS_CONTRACT_CONFIRMED,
  },
};

/** The neutral posture shown while a host's posture is not yet contract-confirmed. */
export const UNCONFIRMED_POSTURE = 'retention/security not yet contractually confirmed';

/** Disclosure for a host, or `undefined` if the host carries no disclosure entry. */
export function hostDisclosure(host: string): HostDisclosure | undefined {
  return HOST_DISCLOSURES[host];
}

/**
 * The posture string safe to SHOW for a host: the confirmed posture, or the
 * neutral fallback while unconfirmed (R2 gate). Never asserts an unconfirmed claim.
 */
export function displayPosture(host: string): string | undefined {
  const d = HOST_DISCLOSURES[host];
  if (!d) return undefined;
  return d.postureConfirmed ? d.posture : `${d.residency} · ${UNCONFIRMED_POSTURE}`;
}
