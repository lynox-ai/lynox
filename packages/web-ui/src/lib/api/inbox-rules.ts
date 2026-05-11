// === Inbox rules HTTP client ===
//
// Pure async fetchers around `/api/inbox/rules`. Kept off the Svelte
// store on purpose: rules are scoped to the RulesView and shared with
// nothing else, so the testability win of a non-`.svelte.ts` module
// outweighs surface consistency with the inbox store.
//
// Wire shapes mirror `core/src/types/inbox.ts` — keep in sync when the
// engine adds a new matcher kind or action.

import { getApiBase } from '../config.svelte.js';

export type InboxRuleMatcherKind = 'from' | 'subject_contains' | 'list_id';
export type InboxRuleAction = 'archive' | 'mark_read' | 'label' | 'show';
export type InboxRuleSource = 'proactive_threshold' | 'on_demand';
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
}

export interface CreateRuleBody {
	accountId: string;
	matcherKind: InboxRuleMatcherKind;
	matcherValue: string;
	bucket: InboxRuleBucket;
	action: InboxRuleAction;
	source: InboxRuleSource;
	tenantId?: string;
}

export async function listInboxRules(
	accountId: string,
	tenantId?: string,
): Promise<InboxRule[] | null> {
	const params = new URLSearchParams({ accountId });
	if (tenantId !== undefined) params.set('tenantId', tenantId);
	try {
		const res = await fetch(`${getApiBase()}/inbox/rules?${params.toString()}`);
		if (!res.ok) return null;
		const data = (await res.json()) as { rules?: InboxRule[] };
		return Array.isArray(data.rules) ? data.rules : [];
	} catch {
		return null;
	}
}

export async function createInboxRule(
	body: CreateRuleBody,
): Promise<{ id: string } | null> {
	try {
		const res = await fetch(`${getApiBase()}/inbox/rules`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { id?: string };
		return typeof data.id === 'string' ? { id: data.id } : null;
	} catch {
		return null;
	}
}

export async function deleteInboxRule(id: string): Promise<boolean> {
	try {
		const res = await fetch(`${getApiBase()}/inbox/rules/${encodeURIComponent(id)}`, {
			method: 'DELETE',
		});
		return res.ok || res.status === 204;
	} catch {
		return false;
	}
}
