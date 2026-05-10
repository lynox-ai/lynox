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
// Per-(tenant, account) cache: a 50-mail tick fires the watcher hook 50
// times; without caching that's 50 identical SELECTs plus per-rule
// `toLowerCase()` JS scans on the synchronous event-loop path. The cache
// stores already-lowercased matcher values so the hot loop is a string
// compare. Mutations through the API layer call `invalidate()` /
// `invalidateAll()` to keep the cache honest.

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

/** Pre-lowercased rule for fast hot-loop matching. */
interface CachedRule {
  rule: InboxRule;
  matcherLower: string;
}

/**
 * Match an envelope against the user-confirmed rules for its account.
 * Returns the first matching rule or `null` when nothing applies.
 */
export class InboxRulesLoader {
  private readonly cache = new Map<string, ReadonlyArray<CachedRule>>();

  constructor(private readonly state: InboxStateDb) {}

  match(input: RuleMatchInput): InboxRule | null {
    const fromLower = input.from.toLowerCase();
    const subjectLower = input.subject.toLowerCase();
    const listIdLower = input.listId?.toLowerCase();
    for (const cached of this._rulesFor(input.accountId, input.tenantId)) {
      switch (cached.rule.matcherKind) {
        case 'from':
          if (fromLower === cached.matcherLower) return cached.rule;
          break;
        case 'subject_contains':
          if (subjectLower.includes(cached.matcherLower)) return cached.rule;
          break;
        case 'list_id':
          if (listIdLower !== undefined && listIdLower === cached.matcherLower) {
            return cached.rule;
          }
          break;
      }
    }
    return null;
  }

  /** Drop the cache entry for one account — call after rule insert/delete. */
  invalidate(accountId: string, tenantId?: string | undefined): void {
    this.cache.delete(this._key(accountId, tenantId));
  }

  /** Drop the entire cache — used when the caller cannot pinpoint the account. */
  invalidateAll(): void {
    this.cache.clear();
  }

  private _rulesFor(accountId: string, tenantId: string | undefined): ReadonlyArray<CachedRule> {
    const key = this._key(accountId, tenantId);
    let cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const fresh = this.state
      .listRulesForAccount(accountId, tenantId)
      .map((rule) => ({ rule, matcherLower: rule.matcherValue.toLowerCase() }));
    cached = fresh;
    this.cache.set(key, cached);
    return cached;
  }

  private _key(accountId: string, tenantId: string | undefined): string {
    return `${tenantId ?? 'default'}:${accountId}`;
  }
}
