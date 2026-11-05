// === Inbox rules HTTP client ===
//
// Pure async fetchers around `/api/inbox/rules`. Kept off the Svelte
// store on purpose — rules are scoped to RulesView, and the api base
// is passed in as a parameter so this module has no `$state` import.
// That keeps the file testable from the engine-root vitest config.
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

export interface CreateRuleBody {
	accountId: string;
	matcherKind: InboxRuleMatcherKind;
	matcherValue: string;
	bucket: InboxRuleBucket;
	action: InboxRuleAction;
	source: InboxRuleSource;
	tenantId?: string;
	/** What the rule is called; optional. Unnamed, the server names it after its value. */
	name?: string;
}

/**
 * The outcome of a create. `namesRuleLabel`: the server refused the name or description because
 * it holds a label such as "R1", which the rule check uses to tell rules apart.
 */
export type CreateRuleResult = { ok: true; id: string } | { ok: false; namesRuleLabel: boolean };

/** The server's refusal of a name or description that holds a rule label (`api.ts`). */
const RULE_LABEL_REFUSAL = /rule label such as R1/;

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

export async function createInboxRule(
	apiBase: string,
	body: CreateRuleBody,
): Promise<CreateRuleResult> {
	try {
		const res = await fetch(`${apiBase}/inbox/rules`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			let error = '';
			try {
				const data = (await res.json()) as { error?: unknown };
				if (typeof data.error === 'string') error = data.error;
			} catch {
				// No JSON body: an unnamed refusal.
			}
			return { ok: false, namesRuleLabel: RULE_LABEL_REFUSAL.test(error) };
		}
		const data = (await res.json()) as { id?: string };
		return typeof data.id === 'string' ? { ok: true, id: data.id } : { ok: false, namesRuleLabel: false };
	} catch {
		return { ok: false, namesRuleLabel: false };
	}
}

/** The owner confirms a rule the assistant proposed; from then on it applies. */
export async function confirmInboxRule(apiBase: string, id: string): Promise<boolean> {
	try {
		const res = await fetch(`${apiBase}/inbox/rules/${encodeURIComponent(id)}/confirm`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{}',
		});
		if (!res.ok) return false;
		const data = (await res.json()) as { id?: unknown };
		return data.id === id;
	} catch {
		return false;
	}
}

export async function deleteInboxRule(apiBase: string, id: string): Promise<boolean> {
	try {
		const res = await fetch(`${apiBase}/inbox/rules/${encodeURIComponent(id)}`, {
			method: 'DELETE',
		});
		return res.ok || res.status === 204;
	} catch {
		return false;
	}
}
