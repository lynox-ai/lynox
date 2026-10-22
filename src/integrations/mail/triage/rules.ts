// === Deterministic pre-filter rules ===
//
// Cheap, no-LLM rules that decide whether an envelope is worth classifying
// further. Every rule that fires saves an LLM call (~$0.001/msg on Haiku),
// and the PRD targets ~60% skip rate from these alone.
//
// Phase 0 only ships sender-pattern rules. A mail from a mailing list (a
// `List-Id` header) is never dropped here, whatever its sender: the inbox hook
// files it as a visible, automatically handled item. The "known
// contact in CRM" and "thread reply inherits classification" rules are
// Phase 2 territory because they need CRM/state coupling.

import type { MailEnvelope } from '../provider.js';

export type PrefilterCategory = 'noise' | 'unknown';

export interface PrefilterDecision {
  category: PrefilterCategory;
  /** Short reason for the decision — used in logs and audit trails. */
  reason: string | undefined;
}

const KEEP: PrefilterDecision = { category: 'unknown', reason: undefined };

/**
 * The one place that decides what counts as mail from a mailing list: the
 * list-id when it does, `undefined` when not. Today a `List-Id` header alone
 * decides. The prefilter keeps such mail, and the inbox hook files it as
 * handled.
 */
export function mailingListOf(env: MailEnvelope): string | undefined {
  return env.listId;
}

const NOREPLY_PATTERN = /^(?:no-?reply|donotreply|do-not-reply|notifications?|alerts?|mailer-?daemon|postmaster)@/i;

/**
 * Apply deterministic rules to one envelope. Returns 'noise' when the
 * message should be skipped entirely, 'unknown' when an LLM (or human)
 * still needs to look at it.
 *
 * No header decides here. `List-Unsubscribe` is set by transactional senders
 * too (invoices, receipts), so it is no mark of bulk mail; `List-Id` is, and
 * the inbox hook handles it visibly instead of dropping it.
 */
export function prefilter(env: MailEnvelope): PrefilterDecision {
  // A list mail passes to the inbox hook, which shows it as handled.
  if (mailingListOf(env) !== undefined) return KEEP;

  // Rule 2: noreply / notifications / mailer-daemon sender
  for (const addr of env.from) {
    if (NOREPLY_PATTERN.test(addr.address)) {
      return { category: 'noise', reason: `noreply sender: ${addr.address}` };
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
      return { category: 'noise', reason: `newsletter domain: ${domain}` };
    }
    const parts = domain.split('.');
    const hasThreePlusSubdomainLevels = parts.length >= 4;
    if (
      hasThreePlusSubdomainLevels
      && /^(mail|email|m|e|news|info|marketing|promo)\./.test(domain)
      && !LEGITIMATE_MAIL_DOMAINS.has(domain)
    ) {
      return { category: 'noise', reason: `bulk-sender subdomain: ${domain}` };
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
