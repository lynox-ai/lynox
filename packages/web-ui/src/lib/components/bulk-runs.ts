// Shapes and pure helpers for the bulk-run surface (BulkRunsView, BulkRunDetail). The shapes
// mirror what core's `/api/bulk/runs…` routes return; only the fields the surface reads.
// The translator comes in as an argument: i18n is a Svelte module, and these stay testable
// without the Svelte plugin.

import { hiddenCharIndexes } from '../hidden-chars.js';

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
	'expired', 'failureRate', 'consecutiveFailures',
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
		: key === 'blocked' ? `bulk.halt.blocked_before_${tier}`
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

/** Text the owner reads before a run acts on it, with every hidden character (`hidden-chars.ts`,
 *  the same file the engine refuses a judge rule by) shown as its code point. Not removed: the
 *  run reads the text as it is, so what the owner reads must be that text too: a removed
 *  character would be one the owner never saw and the model still reads. */
export function bulkVisibleText(text: string): string {
	const hidden = new Set(hiddenCharIndexes(text));
	if (hidden.size === 0) return text;
	return Array.from(text, (c, i) => (hidden.has(i) ? `⟨U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩` : c)).join('');
}

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
}

/** The external host of a run's target system, or null for a local run. */
export function bulkHostOf(targetSystem: string): string | null {
	return targetSystem.startsWith('http:') ? targetSystem.slice('http:'.length) : null;
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
 *  would take back, and is not at its probe (that has its own way back). */
export function bulkCanUndo(run: Pick<BulkRunDetailData, 'kind' | 'phase' | 'haltReason' | 'undoable' | 'probe'>): boolean {
	if (run.kind !== 'apply' || run.undoable <= 0 || bulkAtProbe(run)) return false;
	return run.phase === 'done' || run.phase === 'aborted' || (run.phase === 'writing' && run.haltReason !== null);
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

/** A value of a target as the preview shows it: text as it is, anything else as JSON. */
export function bulkValueText(v: unknown): string {
	if (v === undefined || v === null || v === '') return '';
	return bulkVisibleText(typeof v === 'string' ? v : JSON.stringify(v));
}
