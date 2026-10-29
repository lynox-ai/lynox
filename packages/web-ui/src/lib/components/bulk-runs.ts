// Shapes and pure helpers for the bulk-run surface (BulkRunsView, BulkRunDetail). The shapes
// mirror what core's `/api/bulk/runs…` routes return; only the fields the surface reads.
// The translator comes in as an argument: i18n is a Svelte module, and these stay testable
// without the Svelte plugin.

import { visibleText } from '../visible-text.js';

/** The two i18n lookups the helpers need, `t` and `tf` from `i18n.svelte.ts`. */
export interface BulkI18n {
	t: (key: string) => string;
	tf: (key: string, vars: Record<string, string>) => string;
}

export type BulkPhase = 'planned' | 'previewed' | 'approved' | 'writing' | 'done' | 'aborted' | 'undone';
export type BulkChange = 'update' | 'create' | 'delete' | 'unchanged' | 'invalid';

export interface BulkRun {
	id: string;
	createdAt: string;
	targetSystem: string;
	phase: BulkPhase;
	total: number;
	changes: Record<BulkChange, number>;
	applied: number;
	failed: number;
	conflicts: number;
	/** Targets not written because an earlier send reached them without a clear answer; the
	 *  engine does not send to them again. */
	sentUnknown: number;
	undone: number;
	kind: 'apply' | 'undo';
	atomic: boolean;
	sourceRunId: string | null;
	writeMethod: string | null;
	probeConfirmed: boolean;
	writeForm: 'measured' | 'unmeasured' | null;
	haltReason: string | null;
	/** The halt by name (a key of core's BULK_HALT_REASONS); the surface words its sentences on it. */
	haltKey: string | null;
	costUsd: number;
	costCapUsd: number | null;
	judge: { tier: string; unjudged: number } | null;
	/** The most different targets the approval lets the write reach; null before an approval. */
	maxTargets: number | null;
	/** Targets that failed in any pass; null for a run approved before this was counted. */
	failedOnce: number | null;
	/** How many targets may fail in one pass without the failure-rate halt. */
	failureLimit: number;
	/** The targets a resume tries again; every failure of the next pass is one of them. */
	resumeOpen: number;
	/** Of those, the most the next pass may write to under the approved maximum. */
	resumeTries: number;
	/** Writing targets the owner took out before approving; not counted in `changes`. */
	deselected: number;
}

export interface BulkRunDetailData extends BulkRun {
	checksum: string | null;
	writeFormNote: string | null;
	writeFormConfirmation: string | null;
	judgeModel: string | null;
	resumesAt: string | null;
	probe: { key: string; fields: string[] } | null;
	/** Targets an undo would take back now, a failed external write that may have landed included. */
	undoable: number;
	/** A list still to be read: the address its first page is read at, and the checksum the start presents. */
	listFirstPage: string | null;
	listStartChecksum: string | null;
	/** The engine's note on a list read page by page (English). */
	listNote: string | null;
	/** A judged run's rule as the owner starts it (owner only), and its hash the start presents. */
	judgeRule: { rule: string; schema: { properties: Record<string, unknown> }; tier: string } | null;
	judgeRuleHash: string | null;
	/** Who would judge the run now: the provider serving the call and the model's catalog name. */
	judgeServedBy: { provider: string; label: string } | null;
	/** An instance with its own model key: the engine refuses every start of a judged run there. */
	judgeOwnKey: boolean;
}

/** The word over a halted run's cause. An owner's stop is a stop, not a halt: „angehalten“ is
 *  the word of a run that ended where its approval, a failure or a limit told it to. */
export function bulkHaltHeadKey(run: Pick<BulkRun, 'haltKey'>): 'bulk.head.stopped' | 'bulk.head.halted' {
	return run.haltKey === 'stoppedByOwner' ? 'bulk.head.stopped' : 'bulk.head.halted';
}

/** The same distinction for the suffix on a run's phase in the list. */
export function bulkHaltSuffixKey(run: Pick<BulkRun, 'haltKey'>): 'bulk.stopped_suffix' | 'bulk.halted_suffix' {
	return run.haltKey === 'stoppedByOwner' ? 'bulk.stopped_suffix' : 'bulk.halted_suffix';
}

/** The start a waiting run takes: read its targets, read its list, start its judging — or none,
 *  for a judged run no model can judge now. Null for a run that does not wait for a start. */
export type BulkStartKind = 'read' | 'list' | 'judge' | 'no_judge' | 'judge_own_key';

export function bulkStartKind(run: Pick<BulkRunDetailData, 'phase' | 'haltKey' | 'listFirstPage' | 'judge' | 'judgeServedBy' | 'judgeOwnKey'>): BulkStartKind | null {
	if (!bulkWaitsForStart(run)) return null;
	// A judged run that cannot be judged is not started at all — not even its list, whose read
	// would send requests to the host for a run that can never go on.
	if (run.judge !== null && run.judgeOwnKey) return 'judge_own_key';
	if (run.judge !== null && run.judgeServedBy === null) return 'no_judge';
	// A list's first start reads only the list, judged or not.
	if (run.listFirstPage !== null) return 'list';
	return run.judge !== null ? 'judge' : 'read';
}

/** A planned run's halts that a restart moves on from, each with its own sentence on the page
 *  (`bulk.halt.<key>`). The waiting halts (`awaitingStart`, `listed`) are starts, not restarts. */
const BULK_RESTART_AS_IS = new Set([
	'unavailable', 'timeBudget', 'consecutiveFailures', 'stoppedByOwner', 'listUnreadable', 'credential', 'unauthorized',
	'blocked', 'creditRefused', 'spendLimit', 'judgeModel', 'costCap', 'unrecorded', 'listReadFailed', 'shopInactive',
]);
/** Halts a restart would meet again on the same targets: the run has to be planned again. */
const BULK_RESTART_NONE = new Set(['contract', 'listFormWithdrawn', 'listNotAList', 'listTooLarge', 'listNoProgress', 'listOrder', 'formCost', 'shopifyReadOff']);

/** How a planned run that halted on a failure goes on: read on, read its list on, judge on, judge
 *  on under a higher spend limit — or not at all (`none`, `no_judge`, `judge_own_key`). Null for a
 *  run that did not halt that way, or on a halt this page has no sentence for: then it shows the
 *  engine's reason and offers nothing. */
export type BulkRestartKind = 'read' | 'list' | 'judge' | 'judge_cap' | 'none' | 'no_judge' | 'judge_own_key';

export function bulkRestartKind(run: Pick<BulkRunDetailData, 'phase' | 'haltKey' | 'listFirstPage' | 'judge' | 'judgeServedBy' | 'judgeOwnKey'>): BulkRestartKind | null {
	if (run.phase !== 'planned' || run.haltKey === null) return null;
	if (BULK_RESTART_NONE.has(run.haltKey)) return 'none';
	if (!BULK_RESTART_AS_IS.has(run.haltKey)) return null;
	// As at the start: a judged run that cannot be judged is not moved on, not even its list.
	if (run.judge !== null && run.judgeOwnKey) return 'judge_own_key';
	if (run.judge !== null && run.judgeServedBy === null) return 'no_judge';
	// A list still being read reads on from its page, judged or not.
	if (run.listFirstPage !== null) return 'list';
	if (run.judge !== null) return run.haltKey === 'costCap' ? 'judge_cap' : 'judge';
	return 'read';
}

/** The page's own sentences for a planned run's halt: why it halted, and what the owner can do
 *  first. `managed`: whether this instance is a managed one; unknown reads as managed, the
 *  instances lynox runs. Null on a halt this page has no sentence for, and on a run past its
 *  plan: a write run halts on some of the same keys for other reasons (three failed writes,
 *  not reads), so it keeps the engine's reason. */
export function bulkHaltText(
	run: Pick<BulkRunDetailData, 'phase' | 'haltKey' | 'targetSystem' | 'costUsd' | 'costCapUsd' | 'judge'>,
	managed: boolean | null,
	i18n: BulkI18n,
): { cause: string; before: string | null } | null {
	const key = run.haltKey;
	if (run.phase !== 'planned' || key === null || !(BULK_RESTART_AS_IS.has(key) || BULK_RESTART_NONE.has(key))) return null;
	if (key === 'judgeModel') return { cause: i18n.t('bulk.start.no_judge_model'), before: null };
	// An external run's name is its host, so `{provider}` and `{host}` read the same there.
	const name = bulkSystemName(run.targetSystem, i18n);
	const vars = {
		provider: name,
		host: name,
		cap: bulkUsd(run.costCapUsd ?? 0),
		spent: bulkUsd(run.costUsd),
	};
	const tier = managed === false ? 'selfhost' : 'managed';
	const beforeKey = key === 'unauthorized' ? 'bulk.halt.credential_before'
		: key === 'blocked' || key === 'spendLimit' ? `bulk.halt.${key}_before_${tier}`
		: `bulk.halt.${key}_before`;
	const before = i18n.tf(beforeKey, vars);
	// A judged run's `unavailable` may also be its model; a run without a judge has none to blame.
	const causeKey = key === 'unavailable' && run.judge !== null ? 'bulk.halt.unavailable_judge' : `bulk.halt.${key}`;
	return { cause: i18n.tf(causeKey, vars), before: before === beforeKey ? null : before };
}

/** A write run's halts that writing on moves on from, each with its own sentence on the page. */
const BULK_RESUME_WRITE = new Set([
	'runUnrecorded', 'unavailable', 'timeBudget', 'stoppedByOwner', 'unrecorded', 'unauthorized', 'credential', 'blocked',
	'expired', 'failureRate', 'consecutiveFailures', 'shopifyWriteOff',
]);
/** Halts writing on would not get past: the run has changed since it was approved (the engine
 *  refuses), or a target lies outside what it may write (it would halt there again). */
const BULK_RESUME_NONE = new Set(['checksum', 'contract']);

/** How an approved run that halted goes on: write on (`write`), write on under a higher maximum
 *  (`max`), or not at all (`none`). Null for a run that did not halt while writing, for one at its
 *  probe (it has its own way on), and on a halt this page has no sentence for: then it shows the
 *  engine's reason and offers nothing. Null too where the engine would refuse the resume for want
 *  of a probe: without one, a run writes on only under a maximum of one target, so a higher
 *  maximum is refused, and so is writing on under a maximum above one. */
export type BulkResumeKind = 'write' | 'max' | 'none';

export function bulkResumeKind(
	run: Pick<BulkRunDetailData, 'phase' | 'haltKey' | 'probe' | 'haltReason' | 'probeConfirmed' | 'maxTargets' | 'changes'>,
): BulkResumeKind | null {
	if ((run.phase !== 'approved' && run.phase !== 'writing') || run.haltKey === null || bulkAtProbe(run)) return null;
	if (BULK_RESUME_NONE.has(run.haltKey)) return 'none';
	if (!run.probeConfirmed && (run.haltKey === 'maxTargets' || (run.maxTargets ?? bulkWriting(run)) > 1)) return null;
	if (run.haltKey === 'maxTargets') return 'max';
	return BULK_RESUME_WRITE.has(run.haltKey) ? 'write' : null;
}

/** The page's own sentences for a write run's halt (`bulkResumeKind` not null): why it halted,
 *  what the owner can do first, and for a halt on failures how many failed so far and what the
 *  next pass may still fail. Every count comes from the engine: the page computes none of them. */
export function bulkResumeText(
	run: Pick<BulkRunDetailData, 'phase' | 'haltKey' | 'probe' | 'haltReason' | 'probeConfirmed' | 'changes' | 'targetSystem' | 'maxTargets' | 'applied' | 'failed' | 'failedOnce' | 'failureLimit' | 'resumeOpen' | 'resumeTries'>,
	managed: boolean | null,
	i18n: BulkI18n,
): { cause: string; before: string | null; kept: string | null; soFar: string | null; allows: string | null } | null {
	const kind = bulkResumeKind(run);
	if (kind === null) return null;
	const key = run.haltKey!;
	const name = bulkSystemName(run.targetSystem, i18n);
	const vars = { provider: name, host: name, max: String(run.maxTargets ?? 0) };
	const tier = managed === false ? 'selfhost' : 'managed';
	const limit = run.failureLimit;
	const open = run.resumeOpen;
	const failures = key === 'failureRate' || key === 'consecutiveFailures';
	const cause = key === 'failureRate' ? (limit === 0 ? i18n.t('bulk.halt.failureRate_write0') : i18n.tf('bulk.halt.failureRate_write', { limit: String(limit) }))
		: key === 'consecutiveFailures' ? i18n.t('bulk.halt.consecutiveFailures_write')
		: key === 'unrecorded' ? i18n.tf('bulk.halt.unrecorded_write', vars)
		: key === 'maxTargets' && run.maxTargets === 1 ? i18n.t('bulk.halt.maxTargets_one')
		: i18n.tf(`bulk.halt.${key}`, vars);
	const beforeKey = failures ? 'bulk.halt.failures_before_write'
		: key === 'unauthorized' || key === 'credential' ? 'bulk.halt.credential_before'
		: key === 'blocked' || key === 'shopifyWriteOff' ? `bulk.halt.${key}_before_${tier}`
		: null;
	const before = beforeKey === null ? null : i18n.tf(beforeKey, vars);
	if (kind === 'none') return { cause, before, kept: null, soFar: null, allows: null };
	// "All the rest" holds only when the approved maximum does not stop the pass first; a run
	// written on under a new maximum is bounded by that one. With no target confirmed as written,
	// nothing is said to stay: a write sent and failed may still have reached its target, which the
	// next try reads first and counts as written.
	const capped = kind === 'max' || run.resumeTries < open;
	const kept = i18n.t(run.applied === 0
		? (capped ? 'bulk.resume.kept_write_none_capped' : 'bulk.resume.kept_write_none')
		: (capped ? 'bulk.resume.kept_write_capped' : 'bulk.resume.kept_write'));
	if (!failures) return { cause, before, kept, soFar: null, allows: null };
	const f = run.failed;
	const soFar = run.failedOnce === null
		? (f === 1 ? i18n.t('bulk.resume.failed_so_far_at_least_one') : i18n.tf('bulk.resume.failed_so_far_at_least', { n: String(f) }))
		: (run.failedOnce === 1 ? i18n.t('bulk.resume.failed_so_far_one') : i18n.tf('bulk.resume.failed_so_far', { n: String(run.failedOnce) }));
	return { cause, before, kept, soFar, allows: bulkResumeAllows(limit, open, i18n) };
}

/** What writing on lets fail before the run stops again. The next pass's failures are bounded
 *  by the open targets, not by the approved maximum: a target can fail before it is sent to.
 *  Null with nothing open: writing on then only ends the run. */
function bulkResumeAllows(limit: number, open: number, i18n: BulkI18n): string | null {
	if (open === 0) return null;
	if (limit < open) {
		if (limit === 0) return i18n.t('bulk.resume.allows_again_zero');
		if (limit === 1) return i18n.t('bulk.resume.allows_again_one');
		// Up to two, three in a row cannot come first: the third failure passes the limit too.
		if (limit === 2) return i18n.tf('bulk.resume.allows_again_few', { limit: String(limit) });
		return i18n.tf('bulk.resume.allows_again', { limit: String(limit) });
	}
	if (open >= 3) return i18n.t('bulk.resume.allows_only_consecutive');
	return open === 1 ? i18n.t('bulk.resume.allows_no_failure_stop_one') : i18n.tf('bulk.resume.allows_no_failure_stop', { open: String(open) });
}

/** The maximum a run halted at its maximum writes on with, or null: a whole number above the
 *  current maximum and at most every target it writes. The same maximum would halt it at once. */
export function bulkResumeMax(input: unknown, current: number | null, all: number): number | null {
	const n = typeof input === 'number' ? input : typeof input === 'string' && /^\d+$/.test(input.trim()) ? Number(input.trim()) : Number.NaN;
	if (!Number.isInteger(n) || n < 1 || n > all || (current !== null && n <= current)) return null;
	return n;
}

/** What the page says about the targets an earlier send reached without a clear answer, or
 *  null when there are none. It hangs on their number alone: the same on every halt, on a
 *  finished run, and for every run size. */
export function bulkSentUnknownText(run: Pick<BulkRun, 'sentUnknown'>, i18n: BulkI18n): string | null {
	if (run.sentUnknown <= 0) return null;
	return run.sentUnknown === 1 ? i18n.t('bulk.sent_unknown.one') : i18n.tf('bulk.sent_unknown.many', { count: String(run.sentUnknown) });
}

/** Whether `/api/config` says this is a managed instance: its config carries `managed` (the
 *  billing tier) only there, and a self-hosted one has no such field. Unknown (null) when the
 *  answer is not a config: a refused or failed request carries an error body, which has no tier
 *  either and would read as self-hosted. */
export function bulkManagedOf(ok: boolean, data: unknown): boolean | null {
	if (!ok || typeof data !== 'object' || data === null) return null;
	return !!(data as Record<string, unknown>)['managed'];
}

/** An amount in US dollars as the halt sentences show it, without a currency sign: to the cent,
 *  and to the hundredth of a cent below one cent, so a small spend is not shown as nothing. */
export function bulkUsd(usd: number): string {
	return usd > 0 && usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2);
}

/** The spend limit a run halted on its limit restarts with, or null: an amount `bulkCostCap`
 *  takes, and above the current limit. A limit just above what is spent would halt again at once:
 *  the run halts before a target whose worst case could cross it. */
export function bulkRestartCap(input: string, current: number | null): number | null {
	const cap = bulkCostCap(input);
	return cap === null || (current !== null && cap <= current) ? null : cap;
}

/** A merge of two contacts as `GET /api/merges` lists it. */
export interface BulkMerge {
	id: string;
	createdAt: string;
	dupName: string;
	canonicalName: string;
	applied: boolean;
	inEffect: boolean;
	superseded: boolean;
	dataStoreRows: number;
	threadRows: number;
}

/** A merge's status chip (`bulk.merges.<state>`). A merge that crashed half way never took
 *  effect, so it is not "no longer" in effect. */
export function bulkMergeState(m: Pick<BulkMerge, 'applied' | 'inEffect' | 'superseded'>): 'not_completed' | 'in_effect' | 'superseded' | 'not_in_effect' {
	if (!m.applied) return 'not_completed';
	if (m.inEffect) return 'in_effect';
	return m.superseded ? 'superseded' : 'not_in_effect';
}

/** Whether the page offers "Take back" for a merge: only one that completed and is in effect.
 *  A merge that crashed after the contact graph is in effect in the graph and still not
 *  completed (`applied: false`), and the route refuses it. */
export function bulkMergeTakeable(m: Pick<BulkMerge, 'applied' | 'inEffect'>): boolean {
	return m.applied && m.inEffect;
}

/** The rollback route's codes (`MERGE_REFUSAL_CODES` in the engine), each with its sentence. */
const BULK_MERGE_REFUSALS = new Map<unknown, string>([
	['merge_not_found', 'not_found'],
	['merge_not_applied', 'not_applied'],
	['merge_missing', 'missing'],
	['merge_superseded', 'superseded'],
	['merge_not_in_effect', 'not_in_effect'],
	['merge_unavailable', 'unavailable'],
	['merge_partial', 'partial'],
	['merge_failed', 'failed'],
]);

/** What the page says after "Yes, take it back", read from the route's status and code, never
 *  from its English sentence. `merges`: the list as loaded after the answer. A chain names the
 *  merge in the way only when the route names it AND that merge is in the list, so the owner
 *  can find it there (`goTo`); a chain the route could not name is the dead end. An answer
 *  the page cannot read says it is not certain what came of it. */
export function bulkMergeAnswer(
	status: number,
	body: unknown,
	merge: Pick<BulkMerge, 'id' | 'dupName' | 'canonicalName'>,
	merges: readonly Pick<BulkMerge, 'id' | 'dupName' | 'canonicalName' | 'applied' | 'inEffect'>[],
	i18n: BulkI18n,
): { text: string; ok: boolean; goTo: string | null } {
	const names = { dup: bulkVisibleText(merge.dupName), canonical: bulkVisibleText(merge.canonicalName) };
	if (status >= 200 && status < 300) return { text: i18n.tf('bulk.merges.done', names), ok: true, goTo: null };
	const said = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
	const refused = (key: string): { text: string; ok: boolean; goTo: string | null } =>
		({ text: i18n.tf(`bulk.merges.refused.${key}`, names), ok: false, goTo: null });
	// The owner-only refusal carries no code. A 403 with one (an access that has ended) is
	// refused before the route as well: nothing was taken back, for another reason.
	if (status === 403) return refused(said['code'] === undefined ? 'forbidden' : 'failed');
	if (said['code'] === 'merge_chained') {
		if (typeof said['blocking'] !== 'string') return refused('chained_unnamed');
		// Named by the route, but in the list as loaded after the answer it is gone or no longer
		// one to take back (taken back in another tab, say): the step named is not there now.
		const blocking = merges.find((m) => m.id === said['blocking'] && m.id !== merge.id && bulkMergeTakeable(m));
		if (!blocking) return refused('chained_changed');
		return {
			text: i18n.tf('bulk.merges.refused.chained_named', { dup2: bulkVisibleText(blocking.dupName), canonical2: bulkVisibleText(blocking.canonicalName) }),
			ok: false,
			goTo: blocking.id,
		};
	}
	const key = BULK_MERGE_REFUSALS.get(said['code']);
	return refused(key ?? 'unclear');
}

/** Text the owner reads before a run acts on it, every hidden character shown as its code point
 *  (see `visible-text.ts`, which the approval queue shares). */
export const bulkVisibleText: (text: string) => string = visibleText;

/** The provider that serves a judge call, by name. */
export function bulkJudgeProviderName(provider: string): string {
	const names: Record<string, string> = { anthropic: 'Anthropic', vertex: 'Google Vertex', mistral: 'Mistral', fireworks: 'Fireworks' };
	return names[provider] ?? provider;
}

/** The spend limit the owner typed, in US dollars, or null when it is not an amount above zero
 *  to the cent. The value returned is what the start sends: the page shows the field, not a
 *  rounded copy of it. */
export function bulkCostCap(input: unknown): number | null {
	const text = typeof input === 'number' ? String(input) : typeof input === 'string' ? input.trim().replace(',', '.') : '';
	if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
	const usd = Number(text);
	return Number.isFinite(usd) && usd > 0 ? usd : null;
}

export type TargetDiff =
	| { kind: 'none' }
	| { kind: 'text'; from: number; removed: string[]; added: string[] }
	| { kind: 'fields'; fields: { field: string; before: unknown; after: unknown }[] };

export interface BulkTarget {
	seq: number;
	key: string;
	sentUnchanged?: string[] | undefined;
	change: BulkChange;
	diff: TargetDiff;
	error: string | null;
	/** The owner took it out of the write before approving. */
	deselected: boolean;
	/** This run wrote it (not found already as planned). Optional: an older engine sends neither. */
	written?: boolean | undefined;
	/** A rollback or an undo took this run's write back. */
	undone?: boolean | undefined;
}

/** The external host of a run's target system, or null for a local run. */
export function bulkHostOf(targetSystem: string): string | null {
	return targetSystem.startsWith('http:') ? targetSystem.slice('http:'.length) : null;
}

/** A Shopify store's host, as the engine's preset derives it (`core/src/core/shopify-graphql.ts`). */
const SHOPIFY_STORE_HOST = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** Whether an external run writes to a Shopify store. */
export function bulkIsShopifyHost(host: string | null): boolean {
	return host !== null && SHOPIFY_STORE_HOST.test(host);
}

/** The fields a Shopify run writes, each with the i18n key of its readable name. */
const SHOPIFY_FIELD_KEYS: Readonly<Record<string, string>> = {
	title: 'bulk.field.shopify.title',
	descriptionHtml: 'bulk.field.shopify.descriptionHtml',
	seo_title: 'bulk.field.shopify.seo_title',
	seo_description: 'bulk.field.shopify.seo_description',
};

/** The i18n key of a field's readable name on this host, or null: the field is then shown by its own name. */
export function bulkFieldLabelKey(host: string | null, field: string): string | null {
	return bulkIsShopifyHost(host) && Object.hasOwn(SHOPIFY_FIELD_KEYS, field) ? SHOPIFY_FIELD_KEYS[field]! : null;
}

/** Field names as the owner reads them, joined: a readable name where the host has one, else the
 *  field's own name, shown through {@link bulkVisibleText} — a field name is the planner's text. */
export function bulkFieldNamesText(host: string | null, fields: readonly string[], label: (key: string) => string): string {
	return fields.map((f) => { const key = bulkFieldLabelKey(host, f); return key === null ? bulkVisibleText(f) : label(key); }).join(', ');
}

/** The target system as the owner reads it: the host of an external run, a name otherwise. */
export function bulkSystemName(targetSystem: string, i18n: BulkI18n): string {
	const host = bulkHostOf(targetSystem);
	if (host !== null) return host;
	const key = `bulk.system.${targetSystem}`;
	const name = i18n.t(key);
	return name === key ? targetSystem : name;
}

/** A run has no title: it is named by its size and where it writes. */
export function bulkLabel(run: Pick<BulkRun, 'kind' | 'total' | 'targetSystem'>, i18n: BulkI18n): string {
	return i18n.tf(run.kind === 'undo' ? 'bulk.label_undo' : 'bulk.label', { n: String(run.total), target: bulkSystemName(run.targetSystem, i18n) });
}

/** Targets the run writes — the most an approval can let it write. */
export function bulkWriting(run: Pick<BulkRun, 'changes'>): number {
	return run.changes.update + run.changes.create + run.changes.delete;
}

/** Whether the run stands at its probe: an external run that wrote one target and halted.
 *  The server names a probe only where confirming it can succeed. A run that finished is not
 *  at its probe: it has nothing left to write. */
export function bulkAtProbe(run: Pick<BulkRunDetailData, 'probe' | 'haltReason' | 'phase'>): boolean {
	return run.probe !== null && run.haltReason !== null && run.phase === 'writing';
}

/** Whether a planned run waits for the owner to start it, rather than having halted on a failure. */
export function bulkWaitsForStart(run: Pick<BulkRun, 'phase' | 'haltKey'>): boolean {
	return run.phase === 'planned' && (run.haltKey === 'awaitingStart' || run.haltKey === 'listed');
}

/** Whether the run can be taken back now: an apply run that stopped, has something an undo
 *  would take back, and is not at its probe (that has its own way back). An atomic run is taken
 *  back whole or not at all, so only once it finished: the engine refuses any other
 *  (`atomic_partial`), and one that aborted has already rolled back what it could. */
export function bulkCanUndo(run: Pick<BulkRunDetailData, 'kind' | 'phase' | 'haltReason' | 'undoable' | 'probe' | 'atomic'>): boolean {
	if (run.kind !== 'apply' || run.undoable <= 0 || bulkAtProbe(run)) return false;
	if (run.atomic) return run.phase === 'done';
	return run.phase === 'done' || run.phase === 'aborted' || (run.phase === 'writing' && run.haltReason !== null);
}

/** The halts that end an atomic run in a rollback, each with its own sentence on the page
 *  (`bulk.halt.<key>`). The incomplete ones name targets, which the page marks. */
const BULK_ROLLED_BACK = new Set(['atomicRolledBack', 'atomicStoppedRolledBack', 'atomicTimeRolledBack']);
const BULK_ROLLBACK_INCOMPLETE = new Set(['atomicRollbackIncomplete', 'atomicStoppedRollbackIncomplete', 'atomicTimeRollbackIncomplete']);

/** The page's own sentence for an atomic run that rolled back, and whether the rollback left
 *  targets to mark. Null for any other run: it keeps the other sentences or the engine's reason.
 *  A rolled-back run offers no way on: it is aborted, so neither writing on nor an undo applies. */
export function bulkRollbackText(run: Pick<BulkRun, 'phase' | 'haltKey'>, i18n: BulkI18n): { cause: string; incomplete: boolean } | null {
	const key = run.haltKey;
	if (run.phase !== 'aborted' || key === null) return null;
	const incomplete = BULK_ROLLBACK_INCOMPLETE.has(key);
	if (!incomplete && !BULK_ROLLED_BACK.has(key)) return null;
	return { cause: i18n.t(`bulk.halt.${key}`), incomplete };
}

/** Whether the page marks this target: the run's rollback did not complete, and this is a
 *  target it wrote and did not take back. */
export function bulkRollbackLeft(run: Pick<BulkRun, 'phase' | 'haltKey'>, target: Pick<BulkTarget, 'written' | 'undone'>): boolean {
	return run.phase === 'aborted' && run.haltKey !== null && BULK_ROLLBACK_INCOMPLETE.has(run.haltKey)
		&& target.written === true && target.undone !== true;
}

export const BULK_STEPS = ['planned', 'preview', 'approval', 'probe', 'run', 'done'] as const;

/** Which of {@link BULK_STEPS} the run is at. */
export function bulkStep(run: Pick<BulkRunDetailData, 'probe' | 'haltReason' | 'phase'>): number {
	if (run.phase === 'planned') return 0;
	if (run.phase === 'previewed') return 2;
	if (bulkAtProbe(run)) return 3;
	if (run.phase === 'approved' || run.phase === 'writing') return 4;
	return 5;
}

/** The sentence of each reason a Shopify run leaves a target out for (core `BulkInvalidReason`),
 *  as the i18n key under `bulk.invalid.`. Reasons that read the same share a key. */
const BULK_INVALID_SHOPIFY: Readonly<Record<string, string>> = {
	not_found: 'not_found', redirect: 'redirect', not_json: 'not_json', read_failed: 'read_failed', bad_url: 'bad_url',
	secret_in_target: 'secret_in_target', secret_in_after: 'secret_in_after', secret_in_before: 'secret_in_before',
	mail_api: 'mail_api', field_missing: 'field_missing',
	before_not_object: 'shape', after_not_object: 'shape', field_not_scalar: 'shape',
	list_item_no_id: 'list_item', list_item_bad_id: 'list_item', list_item_not_object: 'list_item', list_item_outside_list: 'list_item',
	list_item_mismatch: 'list_item_mismatch',
	list_item_truncated: 'list_item_truncated',
	cut_off: 'cut_off', verdict_invalid: 'verdict_invalid', verdict_without_after: 'verdict_without_after',
	markup_in_text: 'markup_in_text', hidden_char: 'hidden_char',
};
/** The refusals of taking a target out or putting it back that the owner's page words by
 *  their code (`bulk.deselect.refused.<code>`), not by the engine's English. */
export const BULK_DESELECT_REFUSALS: readonly string[] = ['atomic_undo', 'not_writing', 'not_taken_out'];
/** Sentences a managed instance follows with a way to support; a self-hosted one has none to name. */
const BULK_INVALID_SUPPORT: Readonly<Record<string, string>> = {
	not_json: 'bulk.invalid.persists_support', read_failed: 'bulk.invalid.persists_support', shape: 'bulk.invalid.many_support',
};

/** What the owner reads under a target lynox leaves out: on a Shopify run what is wrong, that
 *  lynox does not change it, and the next step; elsewhere the reason by its code and the step
 *  every run has. Unknown (not yet loaded) reads as managed, as the halt sentences do. */
export function bulkInvalidText(reason: string, shopify: boolean, managed: boolean | null, i18n: BulkI18n): string {
	const key = shopify ? BULK_INVALID_SHOPIFY[reason] : undefined;
	if (key === undefined) return i18n.tf('bulk.invalid.other', { code: bulkVisibleText(reason) });
	const support = BULK_INVALID_SUPPORT[key];
	const text = i18n.t(`bulk.invalid.${key}`);
	return support !== undefined && managed !== false ? `${text} ${i18n.t(support)}` : text;
}

/** The line above a preview's targets: how many lynox leaves out and the owner took out, and
 *  whether anything is left to approve. `nothing` disables the approval: the engine would
 *  refuse it (`nothing_to_apply`), and a button that only fails after the click says less. */
export function bulkSkippedHead(
	run: Pick<BulkRun, 'changes' | 'deselected' | 'judge'>,
	shopify: boolean,
	i18n: BulkI18n,
): { text: string | null; nothing: boolean } {
	const n = run.changes.invalid;
	const m = run.deselected;
	const noun = shopify ? 'products' : 'targets';
	const judged = n > 0 && run.judge !== null ? ` ${i18n.t(shopify ? 'bulk.skipped.judged' : 'bulk.skipped.judged_targets')}` : '';
	if (bulkWriting(run) === 0) {
		// "All" holds only where every target is one lynox leaves out.
		const text = n > 0 && m === 0 && run.changes.unchanged === 0 ? i18n.tf(`bulk.nothing.all_skipped_${noun}`, { n: String(n) }) : i18n.t(`bulk.nothing.${noun}`);
		return { text: text + judged, nothing: true };
	}
	if (n > 0 && m > 0) return { text: i18n.tf(`bulk.skipped.both_${noun}`, { n: String(n), m: String(m) }) + judged, nothing: false };
	if (n > 0) return { text: i18n.tf(`bulk.skipped.${noun}`, { n: String(n) }) + judged, nothing: false };
	if (m > 0) return { text: i18n.tf('bulk.skipped.taken_out', { m: String(m) }), nothing: false };
	return { text: null, nothing: false };
}

/** A value of a target as the preview shows it: text as it is, anything else as JSON. */
export function bulkValueText(v: unknown): string {
	if (v === undefined || v === null || v === '') return '';
	return bulkVisibleText(typeof v === 'string' ? v : JSON.stringify(v));
}
