// === Inbox rules HTTP client: the reads ===
//
// The rule types and the list of an account's rules. Kept apart from the writes (`inbox-rules.ts`,
// owner-only routes) so a page that only reads the rules, such as the inbox naming the rule it
// filters by, imports no write. `inbox-rules.ts` re-exports everything here.
//
// Wire shapes mirror `core/src/types/inbox.ts` — keep in sync when the
// engine adds a new matcher kind or action.

export type InboxRuleMatcherKind = 'from' | 'subject_contains' | 'list_id' | 'matches_description';
export type InboxRuleAction = 'archive' | 'mark_read' | 'label' | 'show';
/** `agent`: proposed by the assistant; it applies only once the owner confirms it. */
export type InboxRuleSource = 'proactive_threshold' | 'on_demand' | 'agent';
export type InboxRuleBucket = 'requires_user' | 'auto_handled';

export interface InboxRule {
	id: string;
	tenantId: string;
	accountId: string;
	matcherKind: InboxRuleMatcherKind;
	matcherValue: string;
	bucket: InboxRuleBucket;
	action: InboxRuleAction;
	source: InboxRuleSource;
	createdAt: string;
	/** What the rule is called. Absent on rules from before names existed. */
	name?: string | undefined;
	/** When the owner confirmed it (ISO); absent while a proposed rule waits. Only confirmed rules apply. */
	confirmedAt?: string | null | undefined;
	/** The run that proposed it (`source: 'agent'`). */
	runId?: string | undefined;
}

/** True while a rule waits for the owner's confirmation. */
export function isRulePending(rule: InboxRule): boolean {
	return rule.confirmedAt === undefined || rule.confirmedAt === null;
}

export async function listInboxRules(
	apiBase: string,
	accountId: string,
	tenantId?: string,
): Promise<InboxRule[] | null> {
	const params = new URLSearchParams({ accountId });
	if (tenantId !== undefined) params.set('tenantId', tenantId);
	try {
		const res = await fetch(`${apiBase}/inbox/rules?${params.toString()}`);
		if (!res.ok) return null;
		const data = (await res.json()) as { rules?: InboxRule[] };
		return Array.isArray(data.rules) ? data.rules : [];
	} catch {
		return null;
	}
}
