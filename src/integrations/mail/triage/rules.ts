// === Deterministic pre-filter rules ===
//
// Cheap, no-LLM rules that decide whether an envelope is worth classifying
// further. Every rule that fires saves an LLM call (~$0.001/msg on Haiku),
// and the PRD targets ~60% skip rate from these alone.
//
// Phase 0 only ships sender-pattern rules; no header decides here. A mail
// that carries a `List-Id` header is kept out of the watcher's silent drop
// (`watch.ts`), and `mailingListOf` below decides whether the inbox hook files
// it as mail from a mailing list. The "known
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
 * list-id when it does, `undefined` when not. A `List-Id` header decides,
 * unless the list sits under the domain of a mailbox connected here
 * (`ownDomains`): a group address such as `info@` set up as a Google group
 * stamps a list-id on every mail, and that mail is the business's own, not a
 * newsletter. `info.firma.ch` is under `firma.ch`; `firma.ch.example` is not.
 */
export function mailingListOf(env: MailEnvelope, ownDomains: ReadonlyArray<string>): string | undefined {
  const id = env.listId;
  if (id === undefined) return undefined;
  // A trailing dot names the same domain (`info.firma.ch.`).
  const lower = id.toLowerCase().replace(/\.$/, '');
  for (const domain of ownDomains) {
    const own = domain.toLowerCase();
    if (lower === own || lower.endsWith(`.${own}`)) return undefined;
  }
  return id;
}

/** The domain part of an address, lowercased; empty when there is none. */
export function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at < 0 ? '' : address.slice(at + 1).trim().toLowerCase();
}

const NOREPLY_PATTERN = /^(?:no-?reply|donotreply|do-not-reply|notifications?|alerts?|mailer-?daemon|postmaster)@/i;

/**
 * Apply deterministic rules to one envelope. Returns 'noise' when the
 * message should be skipped entirely, 'unknown' when an LLM (or human)
 * still needs to look at it.
 *
 * No header decides here. `List-Unsubscribe` is set by transactional senders
 * too (invoices, receipts), so it is no mark of bulk mail. Mail with a
 * `List-Id` is handled by the watcher and the inbox hook, see above.
 */
export function prefilter(env: MailEnvelope): PrefilterDecision {
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
