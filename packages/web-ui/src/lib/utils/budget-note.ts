/**
 * The words of a note for a message the instance's own spending cap blocked: why, when the cap
 * opens again, and what the person can do. The engine sends which cap it was and the two amounts
 * (`budget` on the note and on the `done` event); the sentence is built here, in the page's
 * language. The engine's English reason stays a debug line under it.
 */

/** Which cap a blocked run reached, as the engine sends it. */
export interface BudgetNoteRef {
	cap: 'daily' | 'monthly' | 'unknown';
	limitUSD?: number;
	spentUSD?: number;
}

/**
 * Who the session belongs to, which decides the next step:
 * - `self`: the owner of a self-hosted or hosted (own key) instance. Only a self-hosted owner
 *   gets the limits page: on hosted the control plane sets the daily cap in the environment,
 *   and that wins over the page, so the page cannot change the cap that applies;
 * - `plan`: a managed plan — the cap comes with the plan, so the note names no step;
 * - `owner`: someone else's workspace (a mandate) — only the owner can.
 */
export type BudgetAudience = 'self' | 'plan' | 'owner';

/** A budget reference read from the wire; anything else is dropped, field by field. */
export function parseBudgetNoteRef(v: unknown): BudgetNoteRef | undefined {
	if (typeof v !== 'object' || v === null) return undefined;
	const r = v as Record<string, unknown>;
	const cap = r['cap'];
	if (cap !== 'daily' && cap !== 'monthly' && cap !== 'unknown') return undefined;
	const ref: BudgetNoteRef = { cap };
	const limitUSD = amount(r['limitUSD']);
	const spentUSD = amount(r['spentUSD']);
	if (limitUSD !== undefined) ref.limitUSD = limitUSD;
	if (spentUSD !== undefined) ref.spentUSD = spentUSD;
	return ref;
}

function amount(x: unknown): number | undefined {
	return typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : undefined;
}

/** A cap as the engine names it, with cents like the spend: `$5.00`, `$7.50`. */
export function formatCapUSD(usd: number): string {
	return `$${usd.toFixed(2)}`;
}

/** Spend held against a cap, as the engine names it: `$5.12`. */
export function formatSpentUSD(usd: number): string {
	return `$${usd.toFixed(2)}`;
}

/**
 * When the cap opens again: the daily cap at the next midnight UTC, the monthly cap at midnight
 * UTC on the first of the next month — the boundaries the engine sums spend by.
 */
export function budgetResetAt(cap: 'daily' | 'monthly', now: Date): Date {
	return cap === 'daily'
		? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
		: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/**
 * The reset in the reader's own time, with its day. In German it opens the sentence
 * ("… beginnt ein neuer Tag"): "Heute um 19:00", "Morgen um 01:00", "Am 1. Dezember um 01:00".
 * In English it follows "A new day starts": "today at 07:00 PM", "tomorrow at 01:00 AM",
 * "on December 1 at 01:00 AM". `timeZone` is for tests; the page passes none and gets the
 * browser's.
 */
export function formatResetWhen(at: Date, now: Date, lang: 'de' | 'en', timeZone?: string): string {
	const locale = lang === 'de' ? 'de-DE' : 'en-US';
	const zone = timeZone === undefined ? {} : { timeZone };
	const time = at.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', ...zone });
	const day = (d: Date): string => d.toLocaleDateString('en-CA', zone);
	const today = day(now);
	// The next calendar day from today's date in the reader's zone, not now + 24 h: a day of a
	// clock change is 23 or 25 hours long.
	const [y, m, d] = today.split('-').map(Number) as [number, number, number];
	const tomorrow = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
	if (day(at) === today) return lang === 'de' ? `Heute um ${time}` : `today at ${time}`;
	if (day(at) === tomorrow) return lang === 'de' ? `Morgen um ${time}` : `tomorrow at ${time}`;
	const date = at.toLocaleDateString(locale, { day: 'numeric', month: 'long', ...zone });
	return lang === 'de' ? `Am ${date} um ${time}` : `on ${date} at ${time}`;
}

/** The note's lines: the reason with its amounts and reset, and the step with where it leads. */
export interface BudgetNoteLines {
	/** Text key of the reason, and the values for its slots. */
	reasonKey: string;
	reasonVars: Record<string, string>;
	/** Text key of the next step, or none. Its `{link}` slot, if any, holds the link. */
	nextKey?: string;
	/** Where the step's link leads: the limits page or a mail to support. None for the owner case. */
	href?: string;
	/** Text key of the link's words in the step: only the place it leads is a link, not the step. */
	linkKey?: string;
}

/** A step split around its `{link}` slot: the text before and after the link. */
export function splitAtLink(step: string): { before: string; after: string } | null {
	const at = step.indexOf('{link}');
	return at < 0 ? null : { before: step.slice(0, at), after: step.slice(at + '{link}'.length) };
}

export const LIMITS_PAGE = '/app/settings/workspace/limits';
export const SUPPORT_MAILTO = 'mailto:support@lynox.ai';

/**
 * The note's lines for a blocked run. `audience` and `selfHosted` are null while the page does not
 * know them yet; then the note names no step rather than a wrong one. The limits page is the step
 * only for the owner of a self-hosted instance; a hosted owner and a managed plan get the reason
 * alone, a mandate the owner. A cap reached without its amounts, or with spend that cannot be
 * checked, says so without numbers.
 */
export function budgetNoteLines(
	ref: BudgetNoteRef,
	audience: BudgetAudience | null,
	selfHosted: boolean | null,
	now: Date,
	lang: 'de' | 'en',
): BudgetNoteLines {
	if (ref.cap === 'unknown' || ref.limitUSD === undefined || ref.spentUSD === undefined) {
		const lines: BudgetNoteLines = { reasonKey: 'chat.note.budget.unverifiable', reasonVars: {} };
		if (selfHosted === true) lines.nextKey = 'chat.note.budget.restart';
		else if (selfHosted === false) { lines.nextKey = 'chat.note.budget.support_if_stays'; lines.href = SUPPORT_MAILTO; lines.linkKey = 'chat.note.budget.link_support'; }
		return lines;
	}
	const lines: BudgetNoteLines = {
		reasonKey: ref.cap === 'daily' ? 'chat.note.budget.daily' : 'chat.note.budget.monthly',
		reasonVars: {
			limit: formatCapUSD(ref.limitUSD),
			spent: formatSpentUSD(ref.spentUSD),
			when: formatResetWhen(budgetResetAt(ref.cap, now), now, lang),
		},
	};
	if (audience === 'self' && selfHosted === true) { lines.nextKey = 'chat.note.budget.next_self'; lines.href = LIMITS_PAGE; lines.linkKey = 'chat.note.budget.link_limits'; }
	else if (audience === 'owner') lines.nextKey = 'chat.note.budget.next_owner';
	return lines;
}
