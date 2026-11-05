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
//
// Both sides are compared as the inbox stores a header (`normalizeHeaderText`, the steps of
// `sanitizeHeader` without its length cut): the owner reads the stored subject and sender and
// makes a rule from them, while the watcher hands over the mail as it arrived. A warning sign
// that arrives as emoji (with its variation selector), a tab or a double space would otherwise
// keep a rule made from what the owner sees from matching the mail it was made from.

import type { InboxRule } from '../../types/index.js';
import type { InboxStateDb } from './state.js';
import { MAX_DESCRIPTION_RULES, ruleMatchText } from './rule-text.js';

// The match form lives next to the create check that counts on it; re-exported for the callers here.
export { ruleMatchText };

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

/** Rule with its value in match form (`ruleMatchText`) for fast hot-loop matching. */
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
    const fromLower = ruleMatchText(input.from);
    const subjectLower = ruleMatchText(input.subject);
    const listIdLower = input.listId === undefined ? undefined : ruleMatchText(input.listId);
    for (const cached of this._rulesFor(input.accountId, input.tenantId)) {
      // A value with nothing left once normalized would be contained in every subject: an
      // archive rule would then file every mail. Create refuses one; a stored one never matches.
      if (cached.matcherLower === '') continue;
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

  /** The confirmed description rules of an account, in the order they were confirmed: what the
   *  runner's model call checks (PRD inbox-user-rules E3). `match` never takes one. */
  descriptionRules(accountId: string, tenantId?: string | undefined): ReadonlyArray<InboxRule> {
    return this._rulesFor(accountId, tenantId)
      .map((c) => c.rule)
      .filter((r) => r.matcherKind === 'matches_description')
      // Writes are capped; a restored or hand-edited database is not. Every rule is in every call.
      .slice(0, MAX_DESCRIPTION_RULES);
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
      .listConfirmedRulesForAccount(accountId, tenantId)
      .map((rule) => ({ rule, matcherLower: ruleMatchText(rule.matcherValue) }));
    cached = fresh;
    this.cache.set(key, cached);
    return cached;
  }

  private _key(accountId: string, tenantId: string | undefined): string {
    return `${tenantId ?? 'default'}:${accountId}`;
  }
}
