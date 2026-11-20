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
 * Who can change the cap, which decides the next step:
 * - `self`: the owner of a self-hosted or hosted (own key) instance — the limits page;
 * - `plan`: a managed plan — the cap comes with the plan, support changes it;
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

/** A cap as the engine names it: `$5` for a whole amount, `$7.50` otherwise. */
export function formatCapUSD(usd: number): string {
	return Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`;
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
 * The reset in the reader's own time, with its day: "heute um 19:00", "morgen um 01:00",
 * "am 1. Dezember um 01:00" / "today at 7:00 PM", "tomorrow at 1:00 AM", "on 1 December at 1:00 AM".
 * `timeZone` is for tests; the page passes none and gets the browser's.
 */
export function formatResetWhen(at: Date, now: Date, lang: 'de' | 'en', timeZone?: string): string {
	const locale = lang === 'de' ? 'de-DE' : 'en-US';
	const zone = timeZone === undefined ? {} : { timeZone };
	const time = at.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', ...zone });
	const day = (d: Date): string => d.toLocaleDateString('en-CA', zone);
	const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
	if (day(at) === day(now)) return lang === 'de' ? `heute um ${time}` : `today at ${time}`;
	if (day(at) === day(tomorrow)) return lang === 'de' ? `morgen um ${time}` : `tomorrow at ${time}`;
	const date = lang === 'de'
		? at.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', ...zone })
		: at.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', ...zone });
	return lang === 'de' ? `am ${date} um ${time}` : `on ${date} at ${time}`;
}

/** The note's lines: the reason with its amounts and reset, and the step with where it leads. */
export interface BudgetNoteLines {
	/** Text key of the reason, and the values for its slots. */
	reasonKey: string;
	reasonVars: Record<string, string>;
	/** Text key of the next step, or none. */
	nextKey?: string;
	/** Where the step leads: the limits page or a mail to support. None for the owner case. */
	href?: string;
}

export const LIMITS_PAGE = '/app/settings/workspace/limits';
export const SUPPORT_MAILTO = 'mailto:support@lynox.ai';

/**
 * The note's lines for a blocked run. `audience` and `selfHosted` are null while the page does not
 * know them yet; then the note names no step rather than a wrong one. A cap reached without its
 * amounts, or with spend that cannot be checked, says so without numbers.
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
		else if (selfHosted === false) { lines.nextKey = 'chat.note.budget.support_if_stays'; lines.href = SUPPORT_MAILTO; }
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
	if (audience === 'self') { lines.nextKey = 'chat.note.budget.next_self'; lines.href = LIMITS_PAGE; }
	else if (audience === 'plan') { lines.nextKey = 'chat.note.budget.next_plan'; lines.href = SUPPORT_MAILTO; }
	else if (audience === 'owner') lines.nextKey = 'chat.note.budget.next_owner';
	return lines;
}
