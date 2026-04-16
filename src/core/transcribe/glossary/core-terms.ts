/**
 * Core lynox product glossary — static, hand-curated.
 *
 * Seeded from Phase 0 failure modes: each entry captures a canonical product
 * term plus the mishearings Voxtral produced on real business German + English
 * recordings. Grown via PR when new user-facing names ship.
 *
 * Kept intentionally narrow: only unambiguous product terms whose variants
 * cannot plausibly occur as ordinary German/English words. (Example of a term
 * deliberately NOT included: `Messaging` → `Meeting` — "Meeting" is a common
 * word on its own and a blind rewrite would corrupt legitimate sentences.
 * Context-aware rewriting for that class lives in the session-glossary path.)
 */

export interface GlossaryTerm {
  /** Authoritative spelling to emit in the final transcript. */
  readonly canonical: string;
  /** Strings the STT may emit in place of `canonical`. Matched case-insensitive, word-boundary aware. */
  readonly variants: readonly string[];
}

export const CORE_GLOSSARY: readonly GlossaryTerm[] = [
  // Phase 0 — setup / onboarding
  {
    canonical: 'Setup Wizard',
    variants: ['Setup-Result', 'Setup Result', 'Set-up Wizard', 'Setup Wiser'],
  },
  {
    canonical: 'Starter Tier',
    variants: ['Started hier', 'Starter here', 'Started Tier', 'Star to Tier'],
  },
  {
    canonical: 'Go-Live',
    variants: ['Go life', 'Go live', 'Golive', 'Goalive'],
  },
  {
    canonical: 'Customer Journey',
    variants: ['Customer Journee', 'Kostumer Journey', 'Customer Jurney'],
  },
  {
    canonical: 'Onboarding Flow',
    variants: ['On-Boarding Flow', 'Onboarding Flo', 'Onboarding Floh'],
  },
  {
    canonical: 'Landing Page',
    variants: ['Landingpage', 'Lending Page', 'Landing Peich'],
  },

  // Phase 0 — product / engine concepts
  {
    canonical: 'Knowledge Graph',
    variants: ['Knowledge Graf', 'Nollitsch Graph', 'Knowledge Graff'],
  },
  {
    canonical: 'Agent Memory',
    variants: ['Agent Memoree', 'Agent Memri', 'Agend Memory'],
  },
  {
    canonical: 'Pipeline Engine',
    variants: ['Pipeline Engin', 'Peipline Engine'],
  },
  {
    canonical: 'Thread',
    // No cheap variants — legitimate overlap with common English word. Kept as
    // placeholder so additions land in one place when a mishearing shows up.
    variants: [],
  },

  // Phase 0 — business / workflow terms
  {
    canonical: 'Blocker',
    variants: ['Blockierer', 'Bloker', 'Blokker'],
  },
  {
    canonical: 'A/B Testing',
    variants: ['AB Testing', 'A-B Testing', 'Ah Beh Testing', 'A B Testing'],
  },
  {
    canonical: 'Action Items',
    variants: ['Aktion Items', 'Action Eidems', 'Action Eitems'],
  },
  {
    canonical: 'Follow-up',
    variants: ['Follow up', 'Follow-App', 'Follow Ab', 'Fallow-up'],
  },

  // Phase 0 — DevOps vocabulary
  {
    canonical: 'Deployment',
    variants: ['Deployement', 'Diploiment'],
  },
  {
    canonical: 'Staging',
    variants: ['Stehging', 'Steiging'],
  },
  {
    canonical: 'Release',
    variants: ['Rilies', 'Rehlease'],
  },
  {
    canonical: 'Pipeline',
    // Voxtral handled this well in Phase 0 — kept for documentation + future drift.
    variants: [],
  },

  // Phase 0 — product surface names
  {
    canonical: 'Dashboard',
    variants: ['Dashbord', 'Daschboard'],
  },
  {
    canonical: 'Pricing',
    variants: ['Preising', 'Prising'],
  },

  // lynox brand
  {
    canonical: 'lynox',
    variants: ['Lynox', 'Linox', 'Lainox', 'Line-Ox', 'Lineox', 'Lynox.', 'Lynocs'],
  },
  {
    canonical: 'lynox.cloud',
    variants: ['Lynox Cloud', 'Linox cloud', 'Line-Ox Cloud'],
  },
];
