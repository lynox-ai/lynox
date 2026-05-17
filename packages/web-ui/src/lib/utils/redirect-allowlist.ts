// === Redirect target allowlist (PRD-IA-V2 Security S2) ===
//
// Every `+page.ts` redirect-handler used in the IA refactor (P2-PR-D,
// P3-PR-A2, P3-PR-B, P3-PR-E …) hands its target through `assertChannelTarget`
// so a future refactor can't accidentally introduce an Open-Redirect via a
// crafted query/hash. Today the targets are all hard-coded string literals;
// the helper exists so the contract is enforced in code, not by convention.
//
// Spec reference: PRD-IA-CONSOLIDATION-V2.md Risks table line "Open-Redirect
// via crafted Query/Hash in 301-chain" (HIGH).

/**
 * Allowlisted redirect targets for the P3-PR-A2 channel route split.
 * Hard-coded — never expand from user input.
 */
const P3_PR_A2_CHANNEL_TARGETS = new Set<string>([
  '/app/settings/channels',
  '/app/settings/channels/mail',
  '/app/settings/channels/mail/rules',
  '/app/settings/channels/whatsapp',
  '/app/settings/channels/google',
  '/app/settings/channels/notifications',
  '/app/settings/channels/search',
]);

/**
 * Validate that a redirect target is on the channel-route allowlist.
 * Throws if the target is not allowed — callers should never catch this;
 * a thrown error here means a developer broke the S2 contract.
 *
 * The target MUST be:
 *  - On the static allowlist set above
 *  - Start with `/app/` (defence in depth: even if the set is bypassed,
 *    we reject anything that could become a protocol-relative redirect
 *    like `//evil.com`).
 */
export function assertChannelTarget(target: string): string {
  if (!target.startsWith('/app/')) {
    throw new Error(`redirect-allowlist: target must start with /app/, got: ${target}`);
  }
  if (!P3_PR_A2_CHANNEL_TARGETS.has(target)) {
    throw new Error(`redirect-allowlist: target not allowlisted: ${target}`);
  }
  return target;
}
