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
 * 'SOC2', …) is only a factual claim once the provider contract is pinned. The
 * gate is STRUCTURAL: the raw confirmed-posture text lives in the private `RAW`
 * table and never escapes the module while unconfirmed — every exported surface
 * (`HOST_DISCLOSURES`, `hostDisclosure`, `displayPosture`) carries the already
 * -gated posture, so a consumer that reads `.posture` directly still can't assert
 * an un-pinned contract. See {@link FIREWORKS_CONTRACT_CONFIRMED}.
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
   * The posture SAFE TO SHOW — always R2-gated. When the host's posture is not
   * yet contract-confirmed this is the neutral fallback, NEVER the raw claim.
   */
  posture: string;
  /** R2 gate: is the posture contractually confirmed (safe to assert in-product)? */
  postureConfirmed: boolean;
}

/**
 * R2 gate for the Fireworks host (PRD §S5). `true` since 2026-08-11: the Fireworks
 * DPA is pinned, and it is what makes 'zero-retention · SOC2' a claim we may show.
 *
 * WHAT PINNED IT. <https://fireworks.ai/dpa> is incorporated automatically into the
 * agreement of any customer bound by the terms of service — no signature, so there
 * is no counter-signed artefact to point at; the document itself is the pin. It
 * carries the two claims below as obligations, not marketing:
 *   - §4.5  no retention of prompt inputs or model outputs beyond the request
 *           lifecycle, conditioned on using the ZDR configuration (which is the
 *           default for open models — the opt-in turns prompt LOGGING on).
 *   - Sch.2 SOC 2 Type II, ISO 27001 / 27701 / 42001.
 * §4.3(f) additionally prohibits training or fine-tuning on the data. The customer
 * -facing wording lives in `SUBPROCESSORS.md` and the website's DPA page; both were
 * corrected in the same change, so the screen and the disclosure now agree.
 *
 * ⚠️ Do NOT read this flag as "the transfer basis is settled". It gates the
 * RETENTION/SECURITY posture only. `transferBasis` is a separate field, and the
 * Fireworks DPA completes SCC **Module Two only** (Schedule 3 §1.1) — whether that
 * carries a processor-to-processor onward transfer is an open legal question.
 */
export const FIREWORKS_CONTRACT_CONFIRMED = true;

/** The neutral posture shown while a host's posture is not yet contract-confirmed. */
export const UNCONFIRMED_POSTURE = 'retention/security not yet contractually confirmed';

/**
 * Private raw table — carries the CONFIRMED posture text a host WOULD show once
 * its contract is pinned. NOT exported: the raw confirmed claim must never escape
 * except through the gate (`gatePosture`), so an unconfirmed claim can't leak.
 */
export interface RawDisclosure {
  host: string;
  residency: HostResidency;
  transferBasis: string | null;
  confirmedPosture: string;
  postureConfirmed: boolean;
}

const RAW: Record<string, RawDisclosure> = {
  'api.anthropic.com': {
    host: 'api.anthropic.com',
    residency: 'US',
    transferBasis: 'SCC/DPF',
    confirmedPosture: 'US · zero-retention (API default) · SOC2',
    postureConfirmed: true,
  },
  'api.mistral.ai': {
    host: 'api.mistral.ai',
    residency: 'EU',
    transferBasis: null,
    confirmedPosture: 'EU-resident (France)',
    postureConfirmed: true,
  },
  'api.fireworks.ai': {
    host: 'api.fireworks.ai',
    residency: 'US',
    // SCC only — NOT 'SCC/DPF'. The Fireworks DPA's Schedule 3 is SCCs plus the UK
    // and Swiss addenda; it never invokes the Data Privacy Framework, and Fireworks
    // is not asserted to be DPF-certified anywhere we have checked. The sibling
    // entries earn their 'DPF' from their own contracts; this one did not, and the
    // string was copied.
    transferBasis: 'SCC',
    confirmedPosture: 'US · zero-retention · SOC2',
    postureConfirmed: FIREWORKS_CONTRACT_CONFIRMED,
  },
};

/**
 * The R2 gate: the confirmed claim only when confirmed, else the neutral fallback.
 *
 * EXPORTED FOR ITS OWN TEST, and that is not incidental. The gate used to be proven
 * by asserting on Fireworks, the only unconfirmed host — so confirming Fireworks
 * would have left the mechanism with no subject and a test that passes vacuously.
 * The next host added unconfirmed would then have shipped its raw claim with a
 * green suite. Testing the function directly keeps the proof independent of whatever
 * the table happens to hold.
 */
export function gatePosture(d: RawDisclosure): string {
  return d.postureConfirmed ? d.confirmedPosture : `${d.residency} · ${UNCONFIRMED_POSTURE}`;
}

/**
 * The public disclosure table — every `posture` is already R2-gated, so no
 * exported path can surface an unconfirmed claim.
 */
export const HOST_DISCLOSURES: Record<string, HostDisclosure> = Object.fromEntries(
  Object.entries(RAW).map(([host, d]) => [
    host,
    {
      host: d.host,
      residency: d.residency,
      transferBasis: d.transferBasis,
      posture: gatePosture(d),
      postureConfirmed: d.postureConfirmed,
    },
  ]),
);

/** Disclosure for a host, or `undefined` if the host carries no disclosure entry. */
export function hostDisclosure(host: string): HostDisclosure | undefined {
  return HOST_DISCLOSURES[host];
}

/** The R2-gated posture string safe to SHOW for a host (never an unconfirmed claim). */
export function displayPosture(host: string): string | undefined {
  return HOST_DISCLOSURES[host]?.posture;
}
