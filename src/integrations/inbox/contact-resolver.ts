// === Inbox contact resolver — read-only CRM lookup ===
//
// PRD §Item Layout calls for sender enrichment with KG/CRM context (display
// name, company, last interaction) — and crucially, NO auto-creation. The
// "+ als Kontakt anlegen" affordance is UI-side, gated on user click.
//
// This module is intentionally read-only. Wrapping the lookup behind a
// dedicated class makes the API/UI layers testable without standing up a
// full CRM and gives us an obvious place to layer caching later.

import type { CRM } from '../../core/crm.js';

export interface ResolvedContact {
  /** Display name from the CRM record (always present — required CRM field). */
  name: string;
  /** Email used for the lookup; falls back to the input when CRM omits it. */
  email: string;
  company: string | undefined;
  /** lead / customer / partner / prospect / other. */
  type: string | undefined;
  /** Most recent interaction timestamp, when one exists. */
  lastInteractionAt: Date | undefined;
  /** Plain-text summary of the most recent interaction. */
  lastInteractionSummary: string | undefined;
}

export class InboxContactResolver {
  constructor(private readonly crm: CRM) {}

  /**
   * Look up a sender by email. Returns `null` when the address is not in
   * the CRM — the caller surfaces the "+ Kontakt anlegen" affordance.
   *
   * The lookup is case-insensitive on the address; mail addresses are
   * canonicalised at the local-part level by RFC 5321 conventions but
   * common providers treat them as case-insensitive end-to-end.
   */
  resolve(email: string): ResolvedContact | null {
    const normalized = email.trim().toLowerCase();
    if (!normalized) return null;
    const contact = this.crm.findContact({ email: normalized });
    if (!contact) return null;

    let lastInteractionAt: Date | undefined;
    let lastInteractionSummary: string | undefined;
    if (contact.name) {
      const interactions = this.crm.getInteractions(contact.name, 1);
      const latest = interactions[0];
      if (latest) {
        const rawDate = latest['date'];
        if (typeof rawDate === 'string' && rawDate.length > 0) {
          lastInteractionAt = new Date(rawDate);
        }
        const rawSummary = latest['summary'];
        if (typeof rawSummary === 'string') {
          lastInteractionSummary = rawSummary;
        }
      }
    }

    return {
      name: contact.name,
      email: contact.email ?? normalized,
      company: contact.company,
      type: contact.type,
      lastInteractionAt,
      lastInteractionSummary,
    };
  }
}
