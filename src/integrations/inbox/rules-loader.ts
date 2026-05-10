// === Inbox rules loader — user-confirmed deterministic prefilter ===
//
// Sits between the static `mail/triage/rules.ts` prefilter and the LLM
// classifier. Loads rows from the `inbox_rules` table (added in migration
// v7) and decides whether an incoming envelope already matches a user
// confirmed action — "from:noreply@stripe.com -> auto_handled+archive".
//
// First-match-wins per PRD §Learning Model. Phase 4 will add explicit
// conflict-resolution UI; Phase 1a relies on creation-order semantics
// (the repository returns rules ordered by created_at ASC).
//
// No caching: rule sets are tiny (a handful of rows per account) and
// queries hit a tenant-scoped index. A profile-driven cache can land later
// if hot paths warrant it.

import type { InboxRule } from '../../types/index.js';
import type { InboxStateDb } from './state.js';

export interface RuleMatchInput {
  accountId: string;
  tenantId?: string | undefined;
  /** Sender's address (envelope `from`), case-insensitive compare. */
  from: string;
  /** Subject line, case-insensitive substring compare. */
  subject: string;
  /** RFC 2919 List-Id header value, when present. */
  listId?: string | undefined;
}

/**
 * Match an envelope against the user-confirmed rules for its account.
 * Returns the first matching rule or `null` when nothing applies.
 */
export class InboxRulesLoader {
  constructor(private readonly state: InboxStateDb) {}

  match(input: RuleMatchInput): InboxRule | null {
    const rules = this.state.listRulesForAccount(input.accountId, input.tenantId);
    for (const rule of rules) {
      if (this._matches(rule, input)) return rule;
    }
    return null;
  }

  private _matches(rule: InboxRule, input: RuleMatchInput): boolean {
    switch (rule.matcherKind) {
      case 'from':
        return input.from.toLowerCase() === rule.matcherValue.toLowerCase();
      case 'subject_contains':
        return input.subject.toLowerCase().includes(rule.matcherValue.toLowerCase());
      case 'list_id':
        if (input.listId === undefined) return false;
        return input.listId.toLowerCase() === rule.matcherValue.toLowerCase();
    }
  }
}
