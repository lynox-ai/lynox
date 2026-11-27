// === Deterministic pre-filter rules ===
//
// Cheap, no-LLM rules that say what kind of sender an envelope has. The
// inbox hook files a newsletter domain's mail as handled and a delivery
// failure notice as needing the user, both without an LLM call, and
// classifies an automated sender's like any mail; nothing is dropped unseen
// on them. The
// `mail_triage` tool counts all of them as noise.
//
// Phase 0 only ships sender-pattern rules; no header decides here. The "known
// contact in CRM" and "thread reply inherits classification" rules are
// Phase 2 territory because they need CRM/state coupling.

import type { MailEnvelope } from '../provider.js';

export type PrefilterCategory = 'noise' | 'unknown';

/**
 * Which rule called a mail noise. An automated sender (no-reply,
 * notifications, alerts) writes invoices and warnings too; a delivery
 * failure notice (mailer-daemon, postmaster), a newsletter domain or a bulk
 * subdomain does not.
 */
export type PrefilterRule = 'automated_sender' | 'bounce' | 'newsletter_domain' | 'bulk_subdomain';

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

const NOREPLY_PATTERN = /^(?:no-?reply|donotreply|do-not-reply|notifications?|alerts?)@/i;
const BOUNCE_PATTERN = /^(?:mailer-?daemon|postmaster)@/i;
const HOST_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Two-label public suffixes common among our customers' correspondents. A
 * domain under one counts its suffix as one level, so `info.firma.co.uk` is a
 * company's own two-level domain, not a bulk subdomain. Not the full public
 * suffix list: a suffix missing here counts one level too many.
 */
const TWO_LABEL_SUFFIXES: ReadonlySet<string> = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
  'co.at', 'or.at', 'gv.at', 'ac.at',
  'com.au', 'co.nz', 'co.jp', 'com.br',
]);

/**
 * Apply deterministic rules to one envelope. Returns 'noise' with the rule
 * that fired, 'unknown' when none did.
 *
 * No header decides here. `List-Unsubscribe` is set by transactional senders
 * too (invoices, receipts), so it is no mark of bulk mail, and the sender
 * writes `List-Id` as freely as it writes From.
 */
export function prefilter(env: MailEnvelope): PrefilterDecision {
  // Rule 2: a delivery failure notice, or a noreply / notifications sender
  for (const addr of env.from) {
    if (BOUNCE_PATTERN.test(addr.address)) {
      return { category: 'noise', reason: `delivery failure notice: ${addr.address}`, rule: 'bounce' };
    }
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
    // A domain rule decides only on a domain shaped like a host name. The
    // address comes from the sender (Gmail keeps whatever stands between
    // `<` and `>`), and the domain is shown to the user in the reason; text,
    // spaces or invisible characters there are not a newsletter's domain.
    if (domain.length > 253 || !HOST_NAME.test(domain)) continue;
    if (/^newsletter\./.test(domain)) {
      return { category: 'noise', reason: `newsletter domain: ${domain}`, rule: 'newsletter_domain', domain };
    }
    const parts = domain.split('.');
    const levels = TWO_LABEL_SUFFIXES.has(parts.slice(-2).join('.')) ? parts.length - 1 : parts.length;
    const hasThreePlusSubdomainLevels = levels >= 4;
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
