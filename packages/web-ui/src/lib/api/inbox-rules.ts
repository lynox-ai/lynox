// === Inbox rules HTTP client ===
//
// Pure async fetchers around `/api/inbox/rules`. Kept off the Svelte
// store on purpose — rules are scoped to RulesView, and the api base
// is passed in as a parameter so this module has no `$state` import.
// That keeps the file testable from the engine-root vitest config.
//
// Wire shapes mirror `core/src/types/inbox.ts` — keep in sync when the
// engine adds a new matcher kind or action.

import type { InboxRuleAction, InboxRuleBucket, InboxRuleMatcherKind, InboxRuleSource } from './inbox-rules-read.js';

// The types and the read live in `inbox-rules-read.ts`; they are exported from here as before.
export { isRulePending, listInboxRules } from './inbox-rules-read.js';
export type { InboxRule, InboxRuleAction, InboxRuleBucket, InboxRuleMatcherKind, InboxRuleSource } from './inbox-rules-read.js';

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
 * it holds a label such as "R1", which the rule check uses to tell rules apart. `notOneAddress`:
 * the server refused a sender rule whose value is not one whole sender address.
 */
export type CreateRuleResult = { ok: true; id: string } | { ok: false; namesRuleLabel: boolean; notOneAddress: boolean };

/** The server's refusal of a name or description that holds a rule label (`api.ts`). */
const RULE_LABEL_REFUSAL = /rule label such as R1/;
/** The server's refusal of a sender that is not one whole address (`rule-text.ts` fixedValueProblem). */
const FROM_ADDRESS_REFUSAL = /^matcherValue must be one sender address$/;

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
			return { ok: false, namesRuleLabel: RULE_LABEL_REFUSAL.test(error), notOneAddress: FROM_ADDRESS_REFUSAL.test(error) };
		}
		const data = (await res.json()) as { id?: string };
		return typeof data.id === 'string' ? { ok: true, id: data.id } : { ok: false, namesRuleLabel: false, notOneAddress: false };
	} catch {
		return { ok: false, namesRuleLabel: false, notOneAddress: false };
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
