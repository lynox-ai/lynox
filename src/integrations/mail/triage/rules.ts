// === Deterministic pre-filter rules ===
//
// Cheap, no-LLM rules that decide whether an envelope is worth classifying
// further. Every rule that fires saves an LLM call (~$0.001/msg on Haiku),
// and the PRD targets ~60% skip rate from these alone.
//
// Phase 0 only ships sender-pattern + List-Unsubscribe rules. The "known
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

const NOREPLY_PATTERN = /^(?:no-?reply|donotreply|do-not-reply|notifications?|alerts?|mailer-?daemon|postmaster)@/i;

/**
 * Apply deterministic rules to one envelope. Returns 'noise' when the
 * message should be skipped entirely, 'unknown' when an LLM (or human)
 * still needs to look at it.
 *
 * `headers` is optional — pass it when you have the parsed RFC 5322 headers
 * (lowercase keys) to enable List-Unsubscribe detection.
 */
export function prefilter(env: MailEnvelope, headers?: ReadonlyMap<string, string>): PrefilterDecision {
  // Rule 1: List-Unsubscribe header → bulk mail
  if (headers && (headers.has('list-unsubscribe') || headers.has('list-id'))) {
    return { category: 'noise', reason: 'list-unsubscribe header' };
  }

  // Rule 2: noreply / notifications / mailer-daemon sender
  for (const addr of env.from) {
    if (NOREPLY_PATTERN.test(addr.address)) {
      return { category: 'noise', reason: `noreply sender: ${addr.address}` };
    }
  }

  // Rule 3: bulk-sender domains by convention (newsletter.*, mail.*-but-not-mail-providers)
  for (const addr of env.from) {
    const at = addr.address.lastIndexOf('@');
    if (at < 0) continue;
    const domain = addr.address.slice(at + 1).toLowerCase();
    if (/^newsletter\./.test(domain)) {
      return { category: 'noise', reason: `newsletter domain: ${domain}` };
    }
    if (/^(mail|email|m|e|news|info|marketing|promo)\./.test(domain) && !LEGITIMATE_MAIL_DOMAINS.has(domain)) {
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
]);
