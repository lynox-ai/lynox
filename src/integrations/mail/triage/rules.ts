// === Deterministic pre-filter rules ===
//
// Cheap, no-LLM rules that decide whether an envelope is worth classifying
// further. Every rule that fires saves an LLM call (~$0.001/msg on Haiku),
// and the PRD targets ~60% skip rate from these alone.
//
// Phase 0 only ships sender-pattern rules; no header decides here. Nothing
// drops a mail on these rules unseen: the inbox hook files a newsletter
// domain's mail visibly as handled and classifies an automated sender's like
// any mail, and the `mail_triage` tool counts both as noise. The "known
// contact in CRM" and "thread reply inherits classification" rules are
// Phase 2 territory because they need CRM/state coupling.

import type { MailEnvelope } from '../provider.js';

export type PrefilterCategory = 'noise' | 'unknown';

/**
 * Which rule called a mail noise. An automated sender (no-reply,
 * notifications, alerts, bounces) writes invoices and warnings too; a
 * newsletter domain or a bulk subdomain does not.
 */
export type PrefilterRule = 'automated_sender' | 'newsletter_domain' | 'bulk_subdomain';

export interface PrefilterDecision {
  category: PrefilterCategory;
  /** Short reason for the decision — used in logs and audit trails. */
  reason: string | undefined;
  /** The rule that fired, with a noise decision. */
  rule?: PrefilterRule | undefined;
  /** The sender domain a domain rule fired on. */
  domain?: string | undefined;
}

const KEEP: PrefilterDecision = { category: 'unknown', reason: undefined };

const NOREPLY_PATTERN = /^(?:no-?reply|donotreply|do-not-reply|notifications?|alerts?|mailer-?daemon|postmaster)@/i;

/**
 * Apply deterministic rules to one envelope. Returns 'noise' with the rule
 * that fired, 'unknown' when none did.
 *
 * No header decides here. `List-Unsubscribe` is set by transactional senders
 * too (invoices, receipts), so it is no mark of bulk mail, and the sender
 * writes `List-Id` as freely as it writes From.
 */
export function prefilter(env: MailEnvelope): PrefilterDecision {
  // Rule 2: noreply / notifications / mailer-daemon sender
  for (const addr of env.from) {
    if (NOREPLY_PATTERN.test(addr.address)) {
      return { category: 'noise', reason: `noreply sender: ${addr.address}`, rule: 'automated_sender' };
    }
  }

  // Rule 3: bulk-sender domains by convention.
  //
  // `newsletter.*` always counts — there's no legitimate transactional use
  // of that prefix. For other bulk-typical prefixes (`mail.*`, `info.*`,
  // `marketing.*`, …) we used to fire on ANY 2-level subdomain match,
  // which silently swallowed `mail.stripe.com`, `info.docusign.com`,
  // `mail.protection.outlook.com` etc. — invoices and signing requests
  // that absolutely need to reach the inbox (audit K-LE-08). The fix:
  //
  // - Transactional bulk senders use a 2-level subdomain
  //   (`mail.stripe.com`) AND set `List-Unsubscribe` only sometimes;
  //   real marketing campaigns use 3+ levels (`mail.notifications.…`)
  //   or carry `List-Unsubscribe`. Require 3+ subdomain levels here so
  //   genuine transactional 2-level domains pass through. A 2-level sender
  //   that only carries `List-Unsubscribe` reaches the classifier: nothing
  //   here drops it on that header (it marks invoices too).
  for (const addr of env.from) {
    const at = addr.address.lastIndexOf('@');
    if (at < 0) continue;
    const domain = addr.address.slice(at + 1).toLowerCase();
    if (/^newsletter\./.test(domain)) {
      return { category: 'noise', reason: `newsletter domain: ${domain}`, rule: 'newsletter_domain', domain };
    }
    const parts = domain.split('.');
    const hasThreePlusSubdomainLevels = parts.length >= 4;
    if (
      hasThreePlusSubdomainLevels
      && /^(mail|email|m|e|news|info|marketing|promo)\./.test(domain)
      && !LEGITIMATE_MAIL_DOMAINS.has(domain)
    ) {
      return { category: 'noise', reason: `bulk-sender subdomain: ${domain}`, rule: 'bulk_subdomain', domain };
    }
  }

  return KEEP;
}

/**
 * Mail providers that legitimately use mail.* / m.* subdomains as primary
 * mail hostnames. We never flag these as bulk senders even though the
 * pattern matches.
 */
const LEGITIMATE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'mail.google.com',
  'mail.icloud.com',
  'mail.me.com',
  'mail.yahoo.com',
  'mail.proton.me',
  'mail.protonmail.com',
  'mail.tutanota.com',
  // Microsoft's outbound rewriter — exempts EOP-stamped mail (legitimate
  // transactional traffic that the recipient absolutely needs to see).
  'mail.protection.outlook.com',
]);
