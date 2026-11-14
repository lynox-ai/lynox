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
 * A refusal the rule form can name next to the field it concerns:
 * - `rule_label`: the name or description holds a label such as "R1", which the rule check uses to
 *   tell rules apart;
 * - `not_one_address`: a sender rule whose value is not one whole sender address;
 * - `hidden_chars`: the value holds a character a reader does not see, a line break or a tab;
 * - `subject_short`: a subject phrase under the minimum, which would match almost any mail;
 * - `too_long`: a sender, subject or list id value over the server's cap;
 * - `list_id`: a list id rule, which cannot be created while the mail's List-ID is not read.
 */
export type CreateRuleRefusal = 'rule_label' | 'not_one_address' | 'hidden_chars' | 'subject_short' | 'too_long' | 'list_id';

/** The outcome of a create; `refusal` is null for a failure the form cannot name. */
export type CreateRuleResult = { ok: true; id: string } | { ok: false; refusal: CreateRuleRefusal | null };

/** The server's refusals the form names, as `api.ts` and `rule-text.ts` word them. */
const REFUSALS: ReadonlyArray<readonly [RegExp, CreateRuleRefusal]> = [
	[/rule label such as R1/, 'rule_label'],
	[/^matcherValue must be one sender address$/, 'not_one_address'],
	[/^(matcherValue|description) holds characters a reader does not see$/, 'hidden_chars'],
	[/^(matcherValue|description) must be one line$/, 'hidden_chars'],
	[/^subject phrase must be at least \d+ characters$/, 'subject_short'],
	[/^matcherValue exceeds \d+ characters$/, 'too_long'],
	[/^list_id rules do not apply yet$/, 'list_id'],
];

function refusalOf(error: string): CreateRuleRefusal | null {
	return REFUSALS.find(([pattern]) => pattern.test(error))?.[1] ?? null;
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
			return { ok: false, refusal: refusalOf(error) };
		}
		const data = (await res.json()) as { id?: string };
		return typeof data.id === 'string' ? { ok: true, id: data.id } : { ok: false, refusal: null };
	} catch {
		return { ok: false, refusal: null };
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
