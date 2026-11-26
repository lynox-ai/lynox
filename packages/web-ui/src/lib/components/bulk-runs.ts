// Shapes and pure helpers for the bulk-run surface (BulkRunsView, BulkRunDetail). The shapes
// mirror what core's `/api/bulk/runs…` routes return; only the fields the surface reads.
// The translator comes in as an argument: i18n is a Svelte module, and these stay testable
// without the Svelte plugin.

import { visibleText } from '../visible-text.js';
import { hiddenCharIndexes, inPlaceReferences } from '../hidden-chars.js';
import { startDomainOf } from './bulk-start-domains.js';
import { fillTemplate } from '../i18n-fill.js';

/** The two i18n lookups the helpers need, `t` and `tf` from `i18n.svelte.ts`. */
export interface BulkI18n {
	t: (key: string) => string;
	tf: (key: string, vars: Record<string, string>) => string;
}

/** The sentences that name the owner's own act ("you approved", "you took out", "the limit you
 *  set"). Every such act is the owner's alone (the routes refuse a mandate), so a mandate's
 *  session reads each in its `_mandate` form, which names the owner instead (ux U-111). */
export const BULK_MANDATE_KEYS: ReadonlySet<string> = new Set([
	'bulk.intro', 'bulk.deselect.taken_out',
	'bulk.skipped.products', 'bulk.skipped.targets', 'bulk.skipped.both_products', 'bulk.skipped.both_targets', 'bulk.skipped.taken_out',
	'bulk.halt.probeRequired', 'bulk.halt.shopifyWriteOff', 'bulk.halt.costCap', 'bulk.halt.superseded', 'bulk.halt.discarded',
	'bulk.halt.mandateEnded', 'bulk.halt.checksum', 'bulk.markup.restores_note', 'bulk.markup.restores_note_active',
	// Only the owner approves: a mandate reads that the owner can still approve the rest.
	'bulk.invalid.html_too_long', 'bulk.invalid.html_too_long_woocommerce',
	'bulk.halt.consentOutdated', 'bulk.halt.consentOutdated_more',
	'bulk.halt.consentOutdated_undo', 'bulk.halt.consentOutdated_more_undo', 'bulk.halt.discarded_undo',
	// Only the owner starts an undo again: a mandate reads that the owner does it, and where.
	'bulk.sent_unknown.one_undo', 'bulk.sent_unknown.many_undo',
	'bulk.invalid.before_has_shop_markup', 'bulk.invalid.before_has_shop_markup_undated',
]);

/** `i18n` as a mandate's session reads it: the keys above in their `_mandate` form, a key's
 *  singular (`_one`, {@link bulkOne}) in its `_mandate_one` form. */
export function bulkMandateI18n(i18n: BulkI18n): BulkI18n {
	const key = (k: string): string => {
		if (BULK_MANDATE_KEYS.has(k)) return `${k}_mandate`;
		const base = k.endsWith('_one') ? k.slice(0, -'_one'.length) : null;
		return base !== null && BULK_MANDATE_KEYS.has(base) ? `${base}_mandate_one` : k;
	};
	return { t: (k) => i18n.t(key(k)), tf: (k, vars) => i18n.tf(key(k), vars) };
}

/** A count's sentence at one: the key's `_one` form, which says "1 product", not "1 products".
 *  Only for the keys that have a worded singular. */
export function bulkOne(key: string, n: number): string {
	return n === 1 ? `${key}_one` : key;
}

/** The halts an undo reaches whose sentence names the write: an undo has its own (U-335). */
const BULK_UNDO_HALT_WORDS: ReadonlySet<string> = new Set([
	'bulk.halt.consentOutdated', 'bulk.halt.consentOutdated_more', 'bulk.halt.contract', 'bulk.halt.markupAddedByShop',
	'bulk.halt.markupAddedByShop_before', 'bulk.halt.atomicRolledBack', 'bulk.halt.atomicTimeRolledBack', 'bulk.halt.discarded', 'bulk.halt.runUnrecorded',
	'bulk.halt.storeRequestRefused', 'bulk.halt.storeRequestRefused_kept',
]);

/** A halt sentence's key in the words of the run's kind: an undo's `_undo` form where it has one. */
export function bulkHaltKeyOf(run: { kind?: 'apply' | 'undo' | undefined }, key: string): string {
	return run.kind === 'undo' && BULK_UNDO_HALT_WORDS.has(key) ? `${key}_undo` : key;
}

export type BulkPhase = 'planned' | 'previewed' | 'approved' | 'writing' | 'done' | 'aborted' | 'undone';
export type BulkChange = 'update' | 'create' | 'delete' | 'unchanged' | 'invalid';

/** A run's targets by class, as the engine counts them: taken out, left out by the plan,
 *  unchanged, written and taken back since, written, in conflict, sent without a clear answer,
 *  failed, taken back without being written, and the rest. */
export interface BulkHeads {
	deselected: number; invalid: number; unchanged: number; takenBack: number; written: number;
	conflict: number; unclear: number; failed: number; settled: number; open: number;
}

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
	/** The run's list as the engine counts it; null for a run without one. Absent from an engine
	 *  older than the field, which reads as no list. The runs list carries it too, from the run's own row. */
	list?: { state: string } | null;
	/** Written targets the store kept with markup lynox did not send. Optional: an older engine sends none. */
	shopAddedMarkup?: number | undefined;
	/** Written targets whose store kept a description otherwise than sent, without outside markup: counted, not halted. */
	hostRewrote?: number | undefined;
	undone: number;
	/** Every target in exactly one class; the classes sum to `total`. Absent on an older engine. */
	heads?: BulkHeads | undefined;
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
	/** `judged`: targets with a verdict, a refused one included; absent on an older engine. */
	judge: { tier: string; unjudged: number; judged?: number | undefined } | null;
	/** The form a list run reads, as stored (detail only). */
	listForm?: string | null | undefined;
	/** A judged run whose rule decides an HTML field (detail only). */
	judgesHtml?: boolean | undefined;
	/** The most different targets the approval lets the write reach; null before an approval. */
	maxTargets: number | null;
	/** Targets that failed in any pass; null for a run approved before this was counted. */
	failedOnce: number | null;
	/** Of the targets this pass recorded as failed, those whose send is unclear now. Absent on an
	 *  older engine. */
	passUnclear?: number | undefined;
	/** How many targets may fail in one pass without the failure-rate halt. */
	failureLimit: number;
	/** The targets a resume tries again; every failure of the next pass is one of them. */
	resumeOpen: number;
	/** Of those, the most the next pass may write to under the approved maximum. */
	resumeTries: number;
	/** Of those, the most the next pass sends to: not a target left unclear (`sentUnknown`),
	 *  which it only reads at the provider. Zero with unclear targets open: writing on only checks. */
	resumeSends: number;
	/** Writing targets the owner took out before approving; not counted in `changes`. */
	deselected: number;
}

export interface BulkRunDetailData extends BulkRun {
	checksum: string | null;
	/** Targets the owner has not taken out that add hidden characters the page marks; null where
	 *  the run is neither approved nor confirmed from this page. */
	hiddenAddsTargets?: number | null | undefined;
	/** Targets with an HTML field too large or too complex to check for hidden characters. */
	hiddenUncheckedTargets?: number | null | undefined;
	/** A judged run's verdicts that differ from the rest of it, where the preview can be approved;
	 *  null elsewhere. A reading order, never a check. */
	judgeOutliers?: BulkJudgeOutliers | null | undefined;
	writeFormNote: string | null;
	writeFormConfirmation: string | null;
	judgeModel: string | null;
	resumesAt: string | null;
	/** The target the run waits on as its probe. `found`: lynox sent to it without a clear answer
	 *  and then found it as planned, so it cannot say it wrote it; absent reads as written. */
	probe: { key: string; fields: string[]; found?: boolean } | null;
	/** A Shopify run halted because its connection does not yet cover some of its fields: those
	 *  fields. Absent or null for every other run. */
	consentFields?: string[] | null;
	/** Whether this run confirmed a probe of its own: it stays a step the run went through once
	 *  the probe holds. Absent reads as false. */
	probeOwn?: boolean;
	/** Targets an undo would take back now, a failed external write that may have landed included. */
	undoable: number;
	/** Of `undoable`: the written targets, and those with a send of which it is open whether the
	 *  change arrived. A target whose sends the host all refused is in neither. Absent from an
	 *  engine before this field. */
	undoableParts?: { written: number; open: number };
	/** For an undo: how many of the targets it gives a value back take back a write never confirmed. */
	undoOpen?: number;
	/** A list still to be read: the address its first page is read at, and the checksum the start presents. */
	listFirstPage: string | null;
	/** A Shopify list narrowed to a product type and/or vendor: the values as the planner gave them (supplied text). */
	listFilters: Readonly<Record<string, string | readonly string[]>> | null;
	listStartChecksum: string | null;
	/** An undone run: the undo that took it back and when its last target was taken back. Absent on an older engine. */
	undoneBy?: { runId: string; at: string } | null | undefined;
	/** The engine's note on a list read page by page (English). */
	listNote: string | null;
	/** A judged run's rule as the owner starts it (owner only), and its hash the start presents. */
	judgeRule: { rule: string; schema: { properties: Record<string, unknown> }; tier: string; context?: string[] | undefined } | null;
	/** Set when the rule is an artifact's text, taken word for word; `title` is the artifact's title
	 *  as planned. The owner's only, as the rule is; absent on an older engine. */
	ruleFromArtifact?: { title?: string | undefined } | null | undefined;
	judgeRuleHash: string | null;
	/** Who would judge the run now: the provider serving the call and the model's catalog name. */
	judgeServedBy: { provider: string; label: string } | null;
	/** An instance with its own model key: the engine refuses every start of a judged run there. */
	judgeOwnKey: boolean;
	/** The link domains the owner allowed at the start of a judged list run, besides the store's
	 *  own (PRD shopify-preset §20.2 item 5); null or absent where none were given. */
	startDomains?: string[] | null;
}

/** Whether a run takes allowed link domains: a judged run over a list on an external store, the
 *  only start the engine accepts them at. Its start offers the field; its restart and its
 *  approval show the list, which is fixed from the judge's first start on. */
export function bulkTakesStartDomains(run: Pick<BulkRunDetailData, 'judge' | 'list' | 'targetSystem'>): boolean {
	return run.judge !== null && (run.list ?? null) !== null && bulkHostOf(run.targetSystem) !== null;
}

/** The word over a halted run's cause: it says whether the run can go on from there (U-342). An
 *  owner's stop is a stop, not a halt: „angehalten“ is the word of a run that stopped where its
 *  approval, a failure or a limit told it to and can be continued. An aborted run cannot: one
 *  lynox ended reads „abgebrochen“, or „ersetzt“ where a newer run took its place; one the owner
 *  stopped reads „gestoppt“ as any owner's stop. `startStep`: the sentence under it names the
 *  start the viewer makes (a start button the page shows to the owner). */
export function bulkHaltHeadKey(run: Pick<BulkRun, 'haltKey'> & Partial<Pick<BulkRun, 'phase'>>, startStep = false): 'bulk.head.stopped' | 'bulk.head.halted' | 'bulk.head.discarded' | 'bulk.head.aborted' | 'bulk.head.replaced' | 'bulk.head.next' | 'bulk.head.waiting' {
	// A discarded run reads "Discarded" next to the sentence and the chip that say so (U-324).
	if (run.haltKey === 'discarded') return 'bulk.head.discarded';
	if (bulkOwnerStopped(run)) return 'bulk.head.stopped';
	if (run.phase === 'aborted') return run.haltKey === 'superseded' ? 'bulk.head.replaced' : 'bulk.head.aborted';
	// A run that waits for its start has not halted (U-437): it reads "Next step" where its sentence
	// names the start the viewer makes (`startStep`), else "Waiting".
	if (run.phase === 'planned' && (run.haltKey === 'awaitingStart' || run.haltKey === 'listed')) return startStep ? 'bulk.head.next' : 'bulk.head.waiting';
	return 'bulk.head.halted';
}

/** A run's phase as the list names it. An aborted run reads who or what ended it, as the run page's
 *  head does (U-342): one the owner discarded before approving it „verworfen“ (U-324), one the
 *  owner stopped and lynox rolled back „gestoppt“, one a newer run replaced „ersetzt“, and one
 *  lynox ended „abgebrochen“. Every other run by its phase. */
export function bulkPhaseKey(run: Pick<BulkRun, 'phase' | 'haltKey'>): string {
	if (run.phase === 'aborted') {
		if (run.haltKey === 'discarded') return 'bulk.phase.discarded';
		if (bulkOwnerStopped(run)) return 'bulk.phase.stopped';
		if (run.haltKey === 'superseded') return 'bulk.phase.replaced';
	}
	return `bulk.phase.${run.phase}`;
}

/** A run's phase carries the halted or stopped suffix in the list. An aborted one does not: its
 *  phase already says how it ended, and „angehalten“ would say it can go on (U-342). */
export function bulkPhaseHasSuffix(run: Pick<BulkRun, 'phase' | 'haltKey' | 'haltReason'>): boolean {
	return run.haltReason !== null && run.phase !== 'aborted';
}

/** The same distinction for the suffix on a run's phase in the list. */
export function bulkHaltSuffixKey(run: Pick<BulkRun, 'haltKey'>): 'bulk.stopped_suffix' | 'bulk.halted_suffix' {
	return bulkOwnerStopped(run) ? 'bulk.stopped_suffix' : 'bulk.halted_suffix';
}

/** The halts an owner's stop ends in: the same act reads the same with or without the atomic
 *  rollback after it, on the run page and in the list (U-342). */
const BULK_OWNER_STOPS = new Set(['stoppedByOwner', 'atomicStoppedRolledBack', 'atomicStoppedRollbackIncomplete']);
function bulkOwnerStopped(run: Pick<BulkRun, 'haltKey'>): boolean {
	return run.haltKey !== null && BULK_OWNER_STOPS.has(run.haltKey);
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
	'storeAccessEnded', 'storeClientMisnamed',
	// A store's own cause: going on helps once it is gone (lynox fixed it, or a few minutes passed).
	'shopifyNotSetUp', 'shopifyUnconfirmed', 'shopifyNotCleared', 'containmentUnwritable',
]);
/** Halts a restart would meet again on the same targets: the run has to be planned again. */
const BULK_RESTART_NONE = new Set(['contract', 'listFormWithdrawn', 'listFilterWithdrawn', 'listNotAList', 'listTooLarge', 'listNoProgress', 'listOrder', 'formCost', 'shopifyReadOff', 'shopifySelfHosted', 'shopifyNoApiVersion',
	// The store's pass refuses the request as it is formed: going on sends the same one again.
	'storeRequestRefused']);

/** The note beside a run no restart moves on: plan it again, as a rule. Not for a self-hosted
 *  instance, which no plan reaches a store from, and none for a missing setting of lynox's, whose
 *  own sentence already says that going on does not help (U-232). */
export function bulkRestartNoneNote(haltKey: string | null): 'bulk.restart.none' | 'bulk.restart.none_self_hosted' | null {
	if (haltKey === 'shopifySelfHosted') return 'bulk.restart.none_self_hosted';
	if (haltKey === 'shopifyNoApiVersion') return null;
	return 'bulk.restart.none';
}

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

/** The restarts the page offers no button for. */
const BULK_NO_RESTART_BUTTON: ReadonlySet<BulkRestartKind> = new Set(['none', 'no_judge', 'judge_own_key']);
/** A planned run's steps that tell the owner to go on, or that they can: shown only with a button to do so. */
const BULK_BEFORE_PROMISES_GOING_ON: ReadonlySet<string> = new Set([
	'bulk.halt.unavailable_before', 'bulk.halt.unavailable_judge_before', 'bulk.halt.unauthorized_before',
	'bulk.halt.blocked_before_managed', 'bulk.halt.blocked_before_selfhost', 'bulk.halt.creditRefused_before',
	'bulk.halt.spendLimit_before_managed', 'bulk.halt.spendLimit_before_selfhost', 'bulk.halt.consecutiveFailures_before',
	'bulk.halt.storeAccessEnded_before', 'bulk.halt.storeClientMisnamed_before',
	'bulk.halt.shopifyNotSetUp_before', 'bulk.halt.shopifyUnconfirmed_before', 'bulk.halt.shopifyNotCleared_before',
	'bulk.halt.containmentUnwritable_before',
]);

/** A store's own causes that going on moves past once they are gone (U-232): the cause says only
 *  what happened, the step that promises going on stands where the page offers it, and a mandate
 *  reads that the owner can go on (`_before_mandate`). */
const BULK_STORE_CAUSES_GOING_ON: ReadonlySet<string> = new Set([
	'shopifyNotSetUp', 'shopifyUnconfirmed', 'shopifyNotCleared', 'containmentUnwritable',
]);
/** A store's own causes no going on gets past: the page says the cause in every phase and offers
 *  nothing to go on with. */
const BULK_STORE_CAUSES_NO_WAY_ON: ReadonlySet<string> = new Set(['shopifySelfHosted', 'shopifyNoApiVersion']);

/** The page's own sentences for a planned run's halt: why it halted, and what the owner can do
 *  first. `managed`: whether this instance is a managed one; unknown reads as managed, the
 *  instances lynox runs. Null on a halt this page has no sentence for, and on a run past its
 *  plan: a write run halts on some of the same keys for other reasons (three failed writes,
 *  not reads), so it keeps the engine's reason. */
export function bulkHaltText(
	run: Pick<BulkRunDetailData, 'phase' | 'haltKey' | 'targetSystem' | 'costUsd' | 'costCapUsd' | 'judge' | 'listFirstPage' | 'judgeServedBy' | 'judgeOwnKey'> & { listForm?: string | null | undefined },
	managed: boolean | null,
	i18n: BulkI18n,
	/** Whether the preview marks a target with a failure ({@link bulkShowsFailure}). */
	failureMarked: boolean,
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
	// A judged run's `unavailable` may also be its model; a run without a judge has none to blame.
	const judgedUnavailable = key === 'unavailable' && run.judge !== null;
	const beforeKey = key === 'blocked' || key === 'spendLimit' ? `bulk.halt.${key}_before_${tier}`
		: judgedUnavailable ? 'bulk.halt.unavailable_judge_before'
		// A Shopify list narrows by product type or vendor; any other list only where its source splits (U-186).
		: key === 'listTooLarge' && (run.listForm === 'shopify' || run.listForm === 'shopify_filtered') ? 'bulk.halt.listTooLarge_before_shopify'
		: `bulk.halt.${key}_before`;
	// A step that promises going on stands only where the page offers to go on (ux U-105 L1): a
	// run that cannot be moved on as it is gets the warning's way instead.
	const offersRestart = !BULK_NO_RESTART_BUTTON.has(bulkRestartKind(run) ?? 'none');
	// "Check the targets with an error below" only where the preview marks one.
	if (key === 'consecutiveFailures' && !failureMarked) return { cause: i18n.tf(`bulk.halt.${key}`, vars), before: null };
	const before = BULK_BEFORE_PROMISES_GOING_ON.has(beforeKey) && !offersRestart ? beforeKey : i18n.tf(beforeKey, vars);
	const causeKey = judgedUnavailable ? 'bulk.halt.unavailable_judge' : `bulk.halt.${key}`;
	return { cause: i18n.tf(causeKey, vars), before: before === beforeKey ? null : before };
}

/** A write run's halts that writing on moves on from, each with its own sentence on the page. */
const BULK_RESUME_WRITE = new Set([
	'runUnrecorded', 'unavailable', 'timeBudget', 'stoppedByOwner', 'unrecorded', 'unauthorized', 'credential', 'blocked',
	'expired', 'failureRate', 'consecutiveFailures', 'shopifyWriteOff', 'markupAddedByShop',
	'storeAccessEnded', 'storeClientMisnamed',
	'shopifyNotSetUp', 'shopifyUnconfirmed', 'shopifyNotCleared', 'containmentUnwritable',
]);
/** Halts writing on would not get past: the run has changed since it was approved (the engine
 *  refuses), or a target lies outside what it may write (it would halt there again). */
const BULK_RESUME_NONE = new Set(['checksum', 'contract', 'consentOutdated', 'storeRequestRefused']);

/** The fields a connection does not cover yet, by name with their article, joined with "und"/"and";
 *  "these fields" where one has no name on this page (U-281). */
export function bulkConsentFields(fields: readonly string[] | null | undefined, i18n: BulkI18n): string {
	const known = new Set(['title', 'descriptionHtml', 'seo_title', 'seo_description', 'alt']);
	const list = fields ?? [];
	if (list.length === 0 || list.some((f) => !known.has(f))) return i18n.t('bulk.consent.fields_other');
	const names = list.map((f) => i18n.t(`bulk.consent.field.${f}`));
	return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} ${i18n.t('bulk.consent.and')} ${names[names.length - 1]!}`;
}

/** How an approved run that halted goes on: write on (`write`), write on under a higher maximum
 *  (`max`), only check the targets an earlier send left unclear (`check`: the next pass would send
 *  nothing and only read those at the provider; offered again after a check that did not find
 *  them, since a change can arrive late), not at all because the run would send nothing more
 *  (`nothing`: every target left had changed at the provider since its send, a conflict), or not
 *  at all because the run changed (`none`). A run at its maximum whose probe
 *  holds is offered `max`: a higher maximum checks them too. Null for a run that did not halt while writing, for one at its
 *  probe (it has its own way on), and on a halt this page has no sentence for: then it shows the
 *  engine's reason and offers nothing. Null too where the engine would refuse the resume for want
 *  of a probe: without one, a run writes on only under a maximum of one target, so a higher
 *  maximum is refused, and so is writing on under a maximum above one. */
export type BulkResumeKind = 'write' | 'max' | 'check' | 'nothing' | 'none';

export function bulkResumeKind(
	run: Pick<BulkRunDetailData, 'phase' | 'haltKey' | 'probe' | 'haltReason' | 'probeConfirmed' | 'maxTargets' | 'changes' | 'sentUnknown' | 'resumeSends' | 'resumeTries' | 'resumeOpen' | 'conflicts'>,
): BulkResumeKind | null {
	if ((run.phase !== 'approved' && run.phase !== 'writing') || run.haltKey === null || bulkAtProbe(run)) return null;
	if (BULK_RESUME_NONE.has(run.haltKey)) return 'none';
	// Every target left within the maximum (`resumeOpen === resumeTries`: none held back by it,
	// which writing on under a higher maximum would send), none of them sent to again, none still
	// unclear, and every one a conflict (`conflicts === resumeTries`, and some are left): each was
	// sent to without a clear answer and has a third value at the provider now. Not a target a
	// loop still holds within the claim bound, which is neither unclear on this page nor a conflict.
	if (BULK_RESUME_WRITE.has(run.haltKey) && run.resumeOpen === run.resumeTries && run.resumeSends === 0
		&& run.sentUnknown === 0 && run.conflicts > 0 && run.conflicts === run.resumeTries) return 'nothing';
	const narrow = (run.maxTargets ?? bulkWriting(run)) <= 1;
	if (run.sentUnknown > 0 && run.resumeSends === 0 && (run.haltKey === 'maxTargets' || BULK_RESUME_WRITE.has(run.haltKey))
		&& (run.probeConfirmed ? run.haltKey !== 'maxTargets' : narrow)) return 'check';
	if (!run.probeConfirmed && (run.haltKey === 'maxTargets' || !narrow)) return null;
	if (run.haltKey === 'maxTargets') return 'max';
	return BULK_RESUME_WRITE.has(run.haltKey) ? 'write' : null;
}

/** The page's own sentences for a write run's halt (`bulkResumeKind` not null): why it halted,
 *  what the owner can do first, and for a halt on failures how many failed so far and what the
 *  next pass may still fail. Every count comes from the engine: the page computes none of them. */
export function bulkResumeText(
	run: Pick<BulkRunDetailData, 'phase' | 'haltKey' | 'probe' | 'haltReason' | 'probeConfirmed' | 'changes' | 'targetSystem' | 'maxTargets' | 'applied' | 'failed' | 'failedOnce' | 'failureLimit' | 'resumeOpen' | 'resumeTries' | 'sentUnknown' | 'resumeSends' | 'conflicts' | 'heads' | 'passUnclear'> & Partial<Pick<BulkRunDetailData, 'consentFields' | 'kind'>>,
	managed: boolean | null,
	i18n: BulkI18n,
	/** Whether the preview marks a target with a failure ({@link bulkShowsFailure}): only then
	 *  does the page tell the owner to check the targets with an error below. */
	failureMarked: boolean,
): { cause: string; before: string | null; check: string | null; after: string | null; kept: string | null; soFar: string | null; allows: string | null } | null {
	const kind = bulkResumeKind(run);
	if (kind === null) return null;
	const key = run.haltKey!;
	const name = bulkSystemName(run.targetSystem, i18n);
	const vars = { provider: name, host: name, max: String(run.maxTargets ?? 0) };
	const tier = managed === false ? 'selfhost' : 'managed';
	const limit = run.failureLimit;
	const open = run.resumeOpen;
	const failures = key === 'failureRate' || key === 'consecutiveFailures';
	// An undo takes its targets back: its own words wherever the sentence names the write (U-335).
	const verb = run.kind === 'undo' ? 'undo' : 'write';
	// A write's failure rate names this pass's failed and unclear targets; an undo keeps its own words.
	const cause = key === 'failureRate' ? (verb === 'write' ? bulkFailureRateCause(run, limit, i18n) : limit === 0 ? i18n.t(`bulk.halt.failureRate_${verb}0`) : i18n.tf(`bulk.halt.failureRate_${verb}`, { limit: String(limit) }))
		: key === 'consecutiveFailures' ? i18n.t(`bulk.halt.consecutiveFailures_${verb}`)
		: key === 'unrecorded' ? i18n.tf(`bulk.halt.unrecorded_${verb}`, vars)
		: key === 'maxTargets' && run.maxTargets === 1 ? i18n.t('bulk.halt.maxTargets_one')
		// Going on by checking: the cause leaves out "continue it here", the way follows the check.
		: key === 'shopifyWriteOff' && kind === 'check' ? i18n.t('bulk.halt.shopifyWriteOff_check')
		// "wrote nothing" only where nothing of the run was written or sent.
		: key === 'consentOutdated' ? i18n.tf(bulkHaltKeyOf(run, run.applied === 0 && run.sentUnknown === 0 ? 'bulk.halt.consentOutdated' : 'bulk.halt.consentOutdated_more'), {
			field: bulkConsentFields(run.consentFields, i18n), path: `${i18n.t('nav.settings')} → ${i18n.t('settings.apis')}`,
		})
		: i18n.tf(bulkHaltKeyOf(run, `bulk.halt.${key}`), vars);
	// "Check the targets with an error below" only where the preview marks one.
	const beforeKey = failures ? (failureMarked ? `bulk.halt.failures_before_${verb}` : null)
		: key === 'credential' ? 'bulk.halt.credential_before'
		: key === 'unauthorized' || key === 'unavailable' ? `bulk.halt.${key}_before`
		: key === 'blocked' || key === 'shopifyWriteOff' ? `bulk.halt.${key}_before_${tier}`
		: key === 'markupAddedByShop' ? bulkHaltKeyOf(run, 'bulk.halt.markupAddedByShop_before')
		// Writing on meets the same refusal until the store is connected again or its profile fixed.
		: key === 'storeAccessEnded' || key === 'storeClientMisnamed' ? `bulk.halt.${key}_before`
		: BULK_STORE_CAUSES_GOING_ON.has(key) ? `bulk.halt.${key}_before`
		// What a value carries is the owner's to take out before the run is planned again; an undo
		// writes back what the store held, which has nothing to take out (U-232).
		: key === 'storeRequestRefused' && run.kind !== 'undo' ? 'bulk.halt.storeRequestRefused_before'
		: null;
	const before = beforeKey === null ? null : i18n.tf(beforeKey, vars);
	// What was written (or taken back) before the refused request stays; from it on nothing was
	// sent. Said only where something was: before the first target the cause says it all.
	const stays = key === 'storeRequestRefused' && run.applied > 0 ? i18n.t(bulkHaltKeyOf(run, 'bulk.halt.storeRequestRefused_kept')) : null;
	if (kind === 'none') return { cause, before, check: null, after: null, kept: stays, soFar: null, allows: null };
	// Nothing to send: no step before writing on applies, and what is left needs a new run.
	if (kind === 'nothing') return { cause, before: null, check: i18n.tf(`bulk.resume.nothing_left${run.kind === 'undo' ? '_undo' : ''}`, vars), after: null, kept: null, soFar: null, allows: null };
	// The next step is to check, not to continue: checking sends nothing, so the failures' "before
	// you continue writing" does not apply. What would stop the check too (no access, a host the
	// instance may not reach, Shopify bulk switched off) comes first and ends with checking; anything
	// else follows the check.
	if (kind === 'check') {
		const check = run.sentUnknown === 1 ? i18n.tf('bulk.resume.check_before', vars)
			: i18n.tf('bulk.resume.check_before_many', { ...vars, n: String(run.sentUnknown) });
		const first = key === 'unauthorized' ? 'bulk.halt.unauthorized_before_check'
			: key === 'blocked' || key === 'shopifyWriteOff' ? `bulk.halt.${key}_before_check_${tier}`
			: key === 'credential' ? 'bulk.halt.credential_before'
			// A store whose access ended or whose profile names its app wrongly cannot be read either.
			: key === 'storeAccessEnded' || key === 'storeClientMisnamed' ? `bulk.halt.${key}_before_check`
			// A store refusing for its own cause refuses the check too, until the cause is gone.
			: BULK_STORE_CAUSES_GOING_ON.has(key) ? `bulk.halt.${key}_before_check`
			: null;
		const then = key === 'unavailable' ? 'bulk.halt.unavailable_before_check'
			: key === 'markupAddedByShop' ? bulkHaltKeyOf(run, 'bulk.halt.markupAddedByShop_before')
			: null;
		return { cause, before: first === null ? null : i18n.tf(first, vars), check, after: then === null ? null : i18n.tf(then, vars), kept: null, soFar: null, allows: null };
	}
	// "All the rest" holds only when the approved maximum does not stop the pass first; a run
	// written on under a new maximum is bounded by that one. With no target confirmed as written,
	// nothing is said to stay: a write sent and failed may still have reached its target, which the
	// next try reads first and counts as written. A target found already holding its value was not
	// written by the run (the head's `unchanged`), so it does not count: the applied ones less those
	// are the head's written and taken back.
	const capped = kind === 'max' || run.resumeTries < open;
	// Only for a write: an undo's sentence keeps reading the applied count, as before.
	const written = verb === 'write' && run.heads !== undefined ? run.heads.written + run.heads.takenBack : run.applied;
	const kept = i18n.t(`bulk.resume.kept_${verb}${written === 0 ? '_none' : ''}${capped ? '_capped' : ''}`);
	if (!failures) return { cause, before, check: null, after: null, kept, soFar: null, allows: null };
	const f = run.failed;
	const soFar = run.failedOnce === null
		? (f === 1 ? i18n.t('bulk.resume.failed_so_far_at_least_one') : i18n.tf('bulk.resume.failed_so_far_at_least', { n: String(f) }))
		: (run.failedOnce === 1 ? i18n.t('bulk.resume.failed_so_far_one') : i18n.tf('bulk.resume.failed_so_far', { n: String(run.failedOnce) }));
	return { cause, before, check: null, after: null, kept, soFar, allows: bulkResumeAllows(limit, open, i18n, run.kind === 'undo') };
}

/** Why a write run halted on its failure rate, with this pass's numbers: the targets that failed
 *  now (`heads.failed`) and those whose send is unclear (`passUnclear`). A timeout counts toward
 *  the halt, but it is not a target that could not be written. An older engine without these
 *  counts gets the sentence on the limit. */
function bulkFailureRateCause(run: Pick<BulkRunDetailData, 'heads' | 'passUnclear'>, limit: number, i18n: BulkI18n): string {
	const f = run.heads?.failed;
	const u = run.passUnclear;
	if (f === undefined || u === undefined || u === 0) {
		return limit === 0 ? i18n.t('bulk.halt.failureRate_write0') : i18n.tf('bulk.halt.failureRate_write', { limit: String(limit) });
	}
	if (f === 0) return u === 1 ? i18n.t('bulk.halt.failureRate_unclear_one') : i18n.tf('bulk.halt.failureRate_unclear', { n: String(u) });
	return i18n.tf(`bulk.halt.failureRate_mixed_${f === 1 ? 'f1' : 'fn'}_${u === 1 ? 'u1' : 'un'}`, { f: String(f), u: String(u) });
}

/** Whether the preview marks this target with a failure: a write or read failure the row shows
 *  as such. A target with a diff shows the diff, not its error; a conflict and a send without a
 *  clear answer are not failures. A target left out after its second failed read shows that
 *  read's failure too. */
export function bulkShowsFailure(target: Pick<BulkTarget, 'error' | 'change' | 'diff'>): boolean {
	if (target.change === 'invalid') return target.error === 'read_failed';
	return target.error !== null && target.diff.kind === 'none'
		&& target.error !== 'conflict' && target.error !== 'sent_unknown';
}

/** What writing on lets fail before the run stops again. The next pass's failures are bounded
 *  by the open targets, not by the approved maximum: a target can fail before it is sent to.
 *  Null with nothing open: writing on then only ends the run. */
function bulkResumeAllows(limit: number, open: number, i18n: BulkI18n, undo: boolean): string | null {
	if (open === 0) return null;
	// An undo's sentence says "continuing", not "writing on" (U-335).
	const k = (key: string): string => `bulk.resume.${key}${undo ? '_undo' : ''}`;
	if (limit < open) {
		if (limit === 0) return i18n.t(k('allows_again_zero'));
		if (limit === 1) return i18n.t(k('allows_again_one'));
		// Up to two, three in a row cannot come first: the third failure passes the limit too.
		if (limit === 2) return i18n.tf(k('allows_again_few'), { limit: String(limit) });
		return i18n.tf(k('allows_again'), { limit: String(limit) });
	}
	if (open >= 3) return i18n.t(k('allows_only_consecutive'));
	return open === 1 ? i18n.t(k('allows_no_failure_stop_one')) : i18n.tf(k('allows_no_failure_stop'), { open: String(open) });
}

/** The words of a halted run's resume that do not depend on why it halted: its button, the
 *  sentence that continuing approves it again, and the sentence where continuing does not help,
 *  split around the link to the run an undo takes back. An undo has its own (U-335): it takes
 *  targets back, and it is started again only from the page of the run it undoes. */
export function bulkResumeWords(run: Pick<BulkRun, 'kind' | 'haltKey'>, i18n: Pick<BulkI18n, 't'>): {
	button: string; window: string; none: { before: string; link: string | null; after: string };
} {
	if (run.kind !== 'undo') {
		return { button: i18n.t('bulk.resume.write'), window: i18n.t('bulk.resume.window'), none: { before: i18n.t('bulk.resume.none'), link: null, after: '' } };
	}
	// A halt that names its own step first (reconnect the store) is followed by starting again "afterwards" (U-335).
	const [before = '', after = ''] = i18n.t(run.haltKey === 'consentOutdated' ? 'bulk.resume.none_undo_after' : 'bulk.resume.none_undo').split('{link}');
	return { button: i18n.t('bulk.resume.write_undo'), window: i18n.t('bulk.resume.window_undo'), none: { before, link: i18n.t('bulk.resume.none_undo_link'), after } };
}

/** The maximum a run halted at its maximum writes on with, or null: a whole number above the
 *  current maximum and at most every target it writes. The same maximum would halt it at once. */
export function bulkResumeMax(input: unknown, current: number | null, all: number): number | null {
	const n = typeof input === 'number' ? input : typeof input === 'string' && /^\d+$/.test(input.trim()) ? Number(input.trim()) : Number.NaN;
	if (!Number.isInteger(n) || n < 1 || n > all || (current !== null && n <= current)) return null;
	return n;
}

/** The run fields that decide what the page says about unclear sends. */
type BulkSentUnknownRun = Pick<BulkRunDetailData, 'sentUnknown' | 'phase' | 'haltKey' | 'haltReason'> & Partial<Pick<BulkRun, 'kind'>>;

/** The key of the sentence about unclear sends: a write's, an undo's while it still runs (it
 *  cannot be started again then, so the sentence only says that the way on follows once it
 *  stops), or a stopped undo's, which says to start it again from the run it undoes. */
function bulkSentUnknownKey(run: BulkSentUnknownRun): string {
	const n = run.sentUnknown === 1 ? 'one' : 'many';
	if (run.kind !== 'undo') return `bulk.sent_unknown.${n}`;
	return `bulk.sent_unknown.${n}_undo${bulkEngineWorking(run) ? '_running' : ''}`;
}

/** What the page says about the targets an earlier send reached without a clear answer, or
 *  null when there are none. It hangs on their number and on the kind of run alone: the same on
 *  every halt, on a finished run, and for every run size. A write sends the owner to the chat to
 *  plan it again; an undo is not planned there. A stopped undo says to start it again from the
 *  run it undoes, whose new pass reads each target first and sends only where the change still
 *  stands; a mandate reads that the owner does that (`view`, {@link bulkMandateI18n}). An undo
 *  that still runs says only that the way on follows once it stops: starting it again is refused
 *  while it runs. The link words stand unlinked here; {@link bulkSentUnknownParts} links them. */
export function bulkSentUnknownText(run: BulkSentUnknownRun, i18n: BulkI18n): string | null {
	if (run.sentUnknown <= 0) return null;
	return i18n.tf(bulkSentUnknownKey(run), { count: String(run.sentUnknown), link: i18n.t('bulk.resume.none_undo_link') });
}

/** A stopped undo's sentence about unclear sends, split around the words the page links to the
 *  run it undoes. Null for a write, for no unclear send, for an undo that still runs (its sentence
 *  names no page), and for an undo that names no run (its sentence then stands as
 *  {@link bulkSentUnknownText} words it). */
export function bulkSentUnknownParts(
	run: BulkSentUnknownRun & Pick<BulkRun, 'sourceRunId'>,
	i18n: BulkI18n,
): { before: string; link: string; after: string } | null {
	if (run.kind !== 'undo' || run.sentUnknown <= 0 || run.sourceRunId === null || bulkEngineWorking(run)) return null;
	const [before = '', after = ''] = i18n.tf(bulkSentUnknownKey(run), { count: String(run.sentUnknown) }).split('{link}');
	return { before, link: i18n.t('bulk.resume.none_undo_link'), after };
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

/** At most this many characters of a refused link's domain on the page (U-311). */
export const BULK_LINK_DOMAIN_SHOWN_MAX = 64;
/** A refused link's domain as the page names it: visible as text, and cut with „…“ past
 *  {@link BULK_LINK_DOMAIN_SHOWN_MAX} characters, the „…“ counted. */
export function bulkLinkDomainShown(domain: string): string {
	const chars = [...bulkVisibleText(domain)];
	return chars.length <= BULK_LINK_DOMAIN_SHOWN_MAX ? chars.join('') : `${chars.slice(0, BULK_LINK_DOMAIN_SHOWN_MAX - 1).join('')}…`;
}

/** The start refusals of a run whose rule came from a saved artifact, by the engine's code. */
export const BULK_RULE_SOURCE_CODES: readonly string[] = ['rule_source_changed', 'rule_source_gone', 'rule_source_unreadable'];

/** An artifact's title as the page may name it: the one it had when the run was planned, or null
 *  when it had none (absent, not text, or only spaces). An access can write a title, so the page
 *  draws it as a value someone else wrote (`shownValue`, `MarkedLine`), never as its own words. */
export function bulkArtifactTitle(title: unknown): string | null {
	return typeof title === 'string' && title.trim() !== '' ? title : null;
}

/** The key of the owner's sentence for a start the engine refused because the rule's artifact
 *  changed, is gone or cannot be read now; null for any other code. `titled` picks the sentence
 *  that names the artifact by its planned title; one that cannot be read is never named. */
export function bulkRuleSourceKey(code: string | undefined, titled: boolean): string | null {
	if (code === 'rule_source_unreadable') return 'bulk.rule_source.unreadable';
	if (code !== 'rule_source_changed' && code !== 'rule_source_gone') return null;
	return `bulk.rule_source.${code === 'rule_source_changed' ? 'changed' : 'gone'}${titled ? '_titled' : ''}`;
}

/** The key of the sentence under a rule taken word for word from a saved artifact, in place of
 *  "lynox wrote this rule": at the start of judging, where judging goes on after a halt, or at the
 *  approval, named by its planned title when it had one. */
export function bulkRuleFromArtifactKey(step: 'start' | 'restart' | 'approve', titled: boolean): string {
	return `bulk.${step}.rule_from_artifact${titled ? '' : '_untitled'}`;
}

/** A list of more values than this is folded until the owner shows it all (ux U-175). */
export const BULK_LIST_FILTER_UNFOLDED_MAX = 5;
/** How many values a folded list shows before the count of the rest. */
const BULK_LIST_FILTER_FOLDED_SHOWN = 3;

/** How many values the folded filter line leaves out a click would show: every value of each
 *  list longer than {@link BULK_LIST_FILTER_UNFOLDED_MAX}, together. 0 when nothing folds. */
export function bulkListFilterFolded(filters: Readonly<Record<string, string | readonly string[]>> | null): number {
	if (filters === null) return 0;
	return Object.values(filters).reduce((n, v) => (typeof v !== 'string' && v.length > BULK_LIST_FILTER_UNFOLDED_MAX ? n + v.length : n), 0);
}

/** The line naming a filtered Shopify list's group, where the run is started and approved. The
 *  values are the planner's, so they are shown through {@link bulkVisibleText}. Null without a group.
 *  `folded` shows each list of more than {@link BULK_LIST_FILTER_UNFOLDED_MAX} values folded. */
export function bulkListFilterText(filters: Readonly<Record<string, string | readonly string[]>> | null, i18n: BulkI18n, folded = false): string | null {
	if (filters === null) return null;
	const values = bulkFilterValues(i18n, folded);
	const type = filters['product_type'];
	const vendor = filters['vendor'];
	if (type !== undefined && vendor !== undefined) return i18n.tf('bulk.list.filter_both', { type: values(type), vendor: values(vendor) });
	if (type !== undefined) return i18n.tf('bulk.list.filter_type', { type: values(type) });
	if (vendor !== undefined) return i18n.tf('bulk.list.filter_vendor', { vendor: values(vendor) });
	return null;
}

/** A filter's values for its line: every value in its own quotes, they are the scope the owner
 *  approves. Folded, a long list shows its first values and the count of the rest, so the line
 *  stays true (U-175). */
function bulkFilterValues(i18n: BulkI18n, folded: boolean): (v: string | readonly string[]) => string {
	return (v) => {
		const quoted = (typeof v === 'string' ? [v] : v).map((x) => i18n.tf('bulk.list.value', { value: bulkVisibleText(x) }));
		if (folded && quoted.length > BULK_LIST_FILTER_UNFOLDED_MAX) {
			return `${quoted.slice(0, BULK_LIST_FILTER_FOLDED_SHOWN).join(', ')} ${i18n.tf('bulk.list.more', { n: String(quoted.length - BULK_LIST_FILTER_FOLDED_SHOWN) })}`;
		}
		return quoted.length === 1 ? quoted[0]! : `${quoted.slice(0, -1).join(', ')} ${i18n.t('bulk.list.or')} ${quoted[quoted.length - 1]!}`;
	};
}

/** The line naming the statuses a Shopify product list reads, under the group's line; `{}` is a
 *  list of every product. A store's search lists drafts, archived products and gift cards unless a
 *  status narrows it, and the targets name none of them as such. Null for a list that is not a
 *  store's products. A status filter naming every status narrows nothing, so it reads as no status
 *  filter: a planner asked for every product often lists all of them, and "only" beside the whole
 *  set would promise a narrowing there is not. */
export function bulkListStatusText(filters: Readonly<Record<string, string | readonly string[]>> | null, i18n: BulkI18n): string | null {
	if (filters === null) return null;
	const status = filters['status'];
	if (status !== undefined) {
		const values = typeof status === 'string' ? [status] : status;
		// Exactly the four (four entries holding all four repeat none): a stored list with another
		// value or a repeat is one the engine reads nothing for, and its line names the values as they came.
		const everyStatus = values.length === BULK_STORE_STATUSES.length && BULK_STORE_STATUSES.every((s) => values.includes(s));
		if (!everyStatus) {
			const names = values.map((s) => bulkStatusName(s, i18n));
			return i18n.tf('bulk.list.filter_status', { status: bulkFilterValues(i18n, false)(names) });
		}
	}
	const group = filters['product_type'] !== undefined || filters['vendor'] !== undefined;
	return i18n.t(group ? 'bulk.list.any_status' : 'bulk.list.all_status');
}

/** Every status a Shopify product can have, as the store's search spells them. */
const BULK_STORE_STATUSES: readonly string[] = ['active', 'draft', 'archived', 'unlisted'];

/** A Shopify product status by its name in the page's language; one no store has, as it came. */
function bulkStatusName(status: string, i18n: BulkI18n): string {
	return BULK_STORE_STATUSES.includes(status) ? i18n.t(`bulk.list.status.${status}`) : status;
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
	/** A Shopify product's title as the store answered the preview's read. Optional: an older
	 *  engine sends none, nor does an image target or a product without one. Text, never markup. */
	title?: string | undefined;
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
	/** Written, and the store kept it with markup lynox did not send: the target the halt
	 *  `markupAddedByShop` is about. Set only where it holds. */
	shopAddedMarkup?: true | undefined;
	/** Written, and the store kept the description otherwise than sent, without outside markup. */
	hostRewrote?: true | undefined;
	/** With `before_has_shop_markup`: when the earlier write that left this description marked was
	 *  applied, or null where that run is no longer kept. */
	shopMarkedAt?: string | null | undefined;
	/** The fields behind a Shopify product page's SEO title and description whose text gains an `&`,
	 *  which a theme may show as `&amp;`. A note; nothing is refused. */
	seoEntityFields?: string[] | undefined;
	/** Refused for `shortcode_changed`: each field the shortcode check refuses, with its whole
	 *  planned value, for the owner to copy into the shop (1130). Set only where one holds. */
	refusedValues?: { field: string; value: string; codePoints?: number[] | undefined }[] | undefined;
	/** With `secret_in_context`: the field the judge only reads that held it, by its name. */
	contextField?: string | undefined;
	/** With `new_link_domain`: the domain the refused link points to, as the engine recorded it. */
	linkDomain?: string | undefined;
	/** With `verdict_invalid`: the field of the rule the model's answer broke, the rule's kind and
	 *  its bound, all from the rule (never the answer). Absent on older rows. */
	refusalDetail?: BulkRefusalDetail | undefined;
	/** Per HTML field an `update` target changes: the elements and comments its new value adds and
	 *  removes, each with its full value (PRD shopify-preset §20.2 item 5, sec-core M3). Computed by
	 *  the engine from the parser's tree; the page only lists it, as text. */
	markupChanges?: BulkFieldMarkupChange[] | undefined;
	/** Per text field an `update` or `create` target writes: the hidden characters it holds more of
	 *  than its before-image, where text may carry one and the page would not show it. Counted by
	 *  the engine; the page marks every occurrence of each in that field ({@link bulkHiddenSegments}). */
	hiddenAdds?: { field: string; codePoints: number[]; html?: true | undefined }[] | undefined;
	/** HTML fields not checked for hidden characters: too large or too complex to read. */
	hiddenUnchecked?: string[] | undefined;
}

/** One element or comment a new value adds or removes, as the engine's parser read it. */
export interface BulkMarkupItem {
	kind: 'element' | 'comment';
	namespace: string;
	element: string;
	attributes: (readonly [name: string, value: string])[];
	/** The raw text of an element that holds it (a `script`, a `style`), or a comment's text. */
	text: string | null;
	/** Inside a `template`'s content. */
	inTemplate: boolean;
}

export interface BulkFieldMarkupChange {
	field: string;
	added: BulkMarkupItem[];
	removed: BulkMarkupItem[];
	/** An added item lies outside what a write may add (the engine's allowlist): on an undo, markup
	 *  from before the run that it writes back. Optional: an older engine sends none. */
	addsOutsideAllowlist?: boolean | undefined;
	/** Every added item is one the engine can tell is harmless: the undo's
	 *  sentence then says only that it was there before. Absent (an older engine) reads as false. */
	addsOnlyPassive?: boolean | undefined;
	/** The value or its before-image is larger or nested deeper than the engine reads: nothing is
	 *  listed, and the note says so instead of calling the list complete. */
	unread?: boolean | undefined;
}

/** An element or comment as code text, every attribute with its whole value (sec-core M3: a
 *  rewrite must not hide what a link points to). Never markup: the page sets it as text. Hidden
 *  characters show as their marks (`bulkVisibleText`). A `"` in a value shows as `&quot;`, so a
 *  value cannot close its quote and seem to set a second attribute; an element outside HTML
 *  carries its namespace (`svg:a`), so an SVG link does not read as an HTML one. */
export function bulkMarkupItemText(item: BulkMarkupItem): string {
	if (item.kind === 'comment') return bulkVisibleText(`<!--${item.text ?? ''}-->`);
	const attrs = item.attributes.map(([name, value]) => ` ${name}="${value.replaceAll('"', '&quot;')}"`).join('');
	const name = item.namespace === 'html' ? item.element : `${item.namespace}:${item.element}`;
	const open = `<${name}${attrs}>`;
	return bulkVisibleText(item.text === null ? open : `${open}${item.text}</${name}>`);
}

/** One line of a target's markup list. */
export interface BulkMarkupLine {
	/** `added` or `removed`, by the run's kind: a write's „neu/entfernt“, an undo's „stellt wieder
	 *  her / nimmt wieder heraus“ (ux U-151). */
	label: string;
	code: string;
	/** Set where the element sits inside a `template`'s content. */
	template: string | null;
}

/** What the page lists for one field's markup change (ux U-151): a head naming the field on a
 *  write (none on an undo, whose lines say what it restores); on an undo that writes back markup
 *  outside the allowlist, the sentence that it was in the shop before the run (U-092, in a
 *  mandate's words through `i18n`); the lines; and the note that plain formatting is left out,
 *  without which the list would read as complete. */
export function bulkMarkupList(
	change: BulkFieldMarkupChange, undo: boolean, fieldName: string, i18n: BulkI18n,
): { head: string | null; restoresNote: string | null; restoresActive: boolean; lines: BulkMarkupLine[]; note: string } {
	const template = i18n.t('bulk.markup.in_template');
	const line = (key: string) => (item: BulkMarkupItem): BulkMarkupLine =>
		({ label: i18n.t(key), code: bulkMarkupItemText(item), template: item.inTemplate ? template : null });
	// Only harmless markup restored: the sentence stands neutral, not as a warning about the owner's
	// own table. An engine that does not say reads as active.
	const restoresActive = change.addsOnlyPassive !== true;
	return {
		head: undo ? null : i18n.tf('bulk.markup.head', { field: fieldName }),
		restoresNote: undo && change.addsOutsideAllowlist === true
			? i18n.t(restoresActive ? 'bulk.markup.restores_note_active' : 'bulk.markup.restores_note')
			: null,
		restoresActive,
		lines: [
			...change.added.map(line(undo ? 'bulk.markup.restores' : 'bulk.markup.added')),
			...change.removed.map(line(undo ? 'bulk.markup.removes' : 'bulk.markup.removed')),
		],
		note: i18n.t(change.unread === true ? 'bulk.markup.unread_note' : 'bulk.markup.plain_note'),
	};
}

/** How much of a long value the preview shows before „show the whole text“ (ux U-103). */
export const BULK_VALUE_SHOWN_CHARS = 1000;
export const BULK_VALUE_SHOWN_LINES = 12;

/** The part of a value the preview shows folded, and whether it was cut. The copy button never
 *  takes this: it copies the whole value. */
export function bulkFoldedValue(value: string): { shown: string; cut: boolean } {
	let shown = value.slice(0, BULK_VALUE_SHOWN_CHARS);
	const lines = shown.split('\n');
	if (lines.length > BULK_VALUE_SHOWN_LINES) shown = lines.slice(0, BULK_VALUE_SHOWN_LINES).join('\n');
	return { shown, cut: shown.length < value.length };
}

/** The external host of a run's target system, or null for a local run. */
export function bulkHostOf(targetSystem: string): string | null {
	return targetSystem.startsWith('http:') ? targetSystem.slice('http:'.length) : null;
}

/** A Shopify store's host, as the engine's preset derives it (`core/src/core/shopify-graphql.ts`):
 *  one label of at most 63 characters. */
const SHOPIFY_STORE_HOST = /^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/;

/** Whether an external run writes to a Shopify store. */
export function bulkIsShopifyHost(host: string | null): boolean {
	return host !== null && SHOPIFY_STORE_HOST.test(host);
}

/** A Shopify product's key, exactly: the number is taken from nothing else (a key in any other
 *  form gets no link). */
const SHOPIFY_PRODUCT_GID = /^gid:\/\/shopify\/Product\/(\d+)$/;

/** How a target is named to the owner. On a Shopify run with a product key: its number and the
 *  link to it in the store's admin (https, the run's own host). Anything else is named by its key
 *  alone. No product title: the before-image holds only the fields a run writes, so a title is
 *  there only on a run that rewrites it — and then it is the old one, which the diff already shows. */
export interface BulkTargetName {
	number: string | null;
	adminUrl: string | null;
}

export function bulkTargetName(targetSystem: string, target: { key: string }): BulkTargetName {
	const host = bulkHostOf(targetSystem);
	const m = bulkIsShopifyHost(host) ? SHOPIFY_PRODUCT_GID.exec(target.key) : null;
	if (m === null) return { number: null, adminUrl: null };
	return { number: m[1]!, adminUrl: `https://${host}/admin/products/${m[1]}` };
}

/** A target's name in a sentence: „Produkt <Zahl>“ for a Shopify product, else its key. */
export function bulkTargetLabel(targetSystem: string, target: { key: string }, i18n: Pick<BulkI18n, 'tf'>): string {
	const name = bulkTargetName(targetSystem, target);
	return name.number !== null ? i18n.tf('bulk.target.product', { n: name.number }) : bulkVisibleText(target.key);
}

/** The fields a Shopify run writes or its judge reads (U-140), each with the i18n key of its readable name. */
const SHOPIFY_FIELD_KEYS: Readonly<Record<string, string>> = {
	title: 'bulk.field.shopify.title',
	descriptionHtml: 'bulk.field.shopify.descriptionHtml',
	seo_title: 'bulk.field.shopify.seo_title',
	seo_description: 'bulk.field.shopify.seo_description',
	productType: 'bulk.field.shopify.productType',
	vendor: 'bulk.field.shopify.vendor',
	tags: 'bulk.field.shopify.tags',
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

/** One piece of a sentence split at a field-name slot: plain text, or the place where the field
 *  names stand. */
export type BulkSentencePart = { text: string } | { slot: true };

/** A template sentence split at its `{slot}` placeholder, every other placeholder filled from
 *  `vars` (U-333). The page renders the slot itself, so a field name the planner set can stand in
 *  its value box inside the sentence while the words around it stay lynox's, in the order the
 *  language has them. The template is split BEFORE it is filled, so a value that holds the text
 *  `{slot}` cannot open a second slot. */
export function bulkSentenceParts(template: string, slot: string, vars: Record<string, string>): BulkSentencePart[] {
	const pieces = template.split(`{${slot}}`);
	const parts: BulkSentencePart[] = [];
	pieces.forEach((piece, i) => {
		if (i > 0) parts.push({ slot: true });
		const text = fillTemplate(piece, vars);
		if (text !== '') parts.push({ text });
	});
	return parts;
}

/** The sentence key for a target refused because a field it only reads held a credential: by
 *  where the field lives (Shopify product, data-store column, any other list's entry). */
export function bulkSecretInContextKey(shopify: boolean, dataStore: boolean): string {
	return `bulk.invalid.${shopify ? 'secret_in_context' : dataStore ? 'secret_in_context_column' : 'secret_in_context_field'}`;
}

/** A field's shape in a judged rule, in words (U-333): the four shapes the engine's rule takes
 *  (text with a length, a choice, a number or whole number with bounds, yes/no). A choice says only
 *  "one of:" here: its values are the planner's text and are shown one by one by
 *  {@link bulkFieldChoices}, each in its own box, so a quote inside a value cannot end it. A shape
 *  the page does not know says nothing rather than showing the schema as JSON. */
export function bulkFieldShapeText(shape: unknown, i18n: BulkI18n): string | null {
	if (typeof shape !== 'object' || shape === null) return null;
	const s = shape as Record<string, unknown>;
	const num = (v: unknown): string | null => (typeof v === 'number' && Number.isFinite(v) ? String(v) : null);
	switch (s['type']) {
		case 'string': {
			if (bulkFieldChoices(s) !== null) return i18n.t('bulk.shape.choice');
			const max = num(s['maxLength']);
			if (max === null) return i18n.t('bulk.shape.text');
			const min = num(s['minLength']);
			return min === null || min === '0' ? i18n.tf('bulk.shape.text_max', { max }) : i18n.tf('bulk.shape.text_range', { min, max });
		}
		case 'number':
		case 'integer': {
			const kind = s['type'] === 'integer' ? 'integer' : 'number';
			const min = num(s['minimum']);
			const max = num(s['maximum']);
			if (min !== null && max !== null) return i18n.tf(`bulk.shape.${kind}_range`, { min, max });
			if (min !== null) return i18n.tf(`bulk.shape.${kind}_min`, { min });
			if (max !== null) return i18n.tf(`bulk.shape.${kind}_max`, { max });
			return i18n.t(`bulk.shape.${kind}`);
		}
		case 'boolean':
			return i18n.t('bulk.shape.boolean');
		default:
			return null;
	}
}

/** The values of a choice field in a judged rule, as the planner wrote them, or null for a field
 *  that is no choice. Shown through {@link bulkVisibleText} by the caller. */
export function bulkFieldChoices(shape: unknown): string[] | null {
	if (typeof shape !== 'object' || shape === null) return null;
	const choices = (shape as Record<string, unknown>)['enum'];
	return (shape as Record<string, unknown>)['type'] === 'string' && Array.isArray(choices) && choices.length > 0 && choices.every((c) => typeof c === 'string')
		? (choices as string[]) : null;
}

/** Why the judged run's start button is disabled, as the line under it (U-333), or null. The cost
 *  limit is named only while its field is empty: an entered, invalid amount has its own line. */
export function bulkStartHintKey(capInput: string, startDomainsValid: boolean): string | null {
	const cap = capInput === '';
	if (cap && !startDomainsValid) return 'bulk.start.hint_both';
	if (cap) return 'bulk.start.hint_cap';
	if (!startDomainsValid) return 'bulk.start.hint_domains';
	return null;
}

/** The target system as the owner reads it: the host of an external run, a name otherwise. */
export function bulkSystemName(targetSystem: string, i18n: BulkI18n): string {
	const host = bulkHostOf(targetSystem);
	if (host !== null) return host;
	const key = `bulk.system.${targetSystem}`;
	const name = i18n.t(key);
	return name === key ? targetSystem : name;
}

/** How a host the planner set stands among the page's own words: boxed as code, like a field
 *  name the planner set (U-333), so it never reads as part of the sentence. */
export const BULK_HOST_BOX = 'rounded-[var(--radius-sm)] border border-text-subtle bg-bg-muted px-1 font-mono font-normal text-text';

/** A boxed value (a host, an address) cut where it may wrap: after a dot, a slash or a space, never
 *  at a hyphen inside a name (U-423, the rule of the run page's headings): `summer-shoes-test.` /
 *  `myshopify.com`. Each piece keeps the dots, slashes and spaces that end it. */
export function bulkBoxParts(value: string): string[] {
	return value.match(/[^./\s]+[./]*\s*|[./\s]+/g) ?? [];
}

export type BulkTemplatePart = { text: string } | { slot: string };

/** A template sentence split at each of the named placeholders, every other placeholder filled from
 *  `vars`: the page renders each slot itself, so a value the planner or the owner set stands boxed
 *  and the sentence around it stays the page's. */
export function bulkTemplateParts(template: string, slots: readonly string[], vars: Record<string, string>): BulkTemplatePart[] {
	const parts: BulkTemplatePart[] = [];
	for (const piece of template.split(new RegExp(`(\\{(?:${slots.join('|')})\\})`))) {
		const slot = /^\{(\w+)\}$/.exec(piece)?.[1];
		if (slot !== undefined && slots.includes(slot)) parts.push({ slot });
		else { const text = fillTemplate(piece, vars); if (text !== '') parts.push({ text }); }
	}
	return parts;
}

/** A text split at every place it names the host as a whole name, which the page boxes: for the
 *  run page's texts that name it among other words (a halt's cause, what continuing does). The host
 *  inside a longer name (`api.shop.ch`, `shop.ch.other.example`, `myshop.ch`, `shop.ch_x`, a name in
 *  another script) stays text, so a
 *  target's key or a remote's message never gets a box that vouches for part of a foreign name.
 *  Without a host, the text whole. */
export function bulkHostSplit(text: string, host: string | null): BulkSentencePart[] {
	if (host === null || host === '') return [{ text }];
	const name = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	// A letter, mark, digit, format character or underscore beside it, or a dot that a browser reads as
	// a full stop (U+3002, U+FF0E, U+FF61) before a further label, makes it part of a longer name.
	const part = '\\p{L}\\p{M}\\p{N}\\p{Cf}_';
	const dot = '.\\u3002\\uFF0E\\uFF61';
	// A user, a port, an escape or the page's mark for a hidden character beside it (`shop.ch@other`,
	// `other%2Eshop.ch`, `shop.ch\u27e8U+200B\u27e9other`) makes it part of another address too.
	const joined = '@%:\\u27E8\\u27E9';
	const whole = new RegExp(`(?<![${part}${dot}${joined}-])${name}(?![${part}${joined}-]|[${dot}][${part}])`, 'gu');
	const parts: BulkSentencePart[] = [];
	let from = 0;
	for (const m of text.matchAll(whole)) {
		if (m.index > from) parts.push({ text: text.slice(from, m.index) });
		parts.push({ slot: true });
		from = m.index + host.length;
	}
	if (from < text.length) parts.push({ text: text.slice(from) });
	return parts;
}

/** A run's label in parts: the host of an external run is the slot the page boxes; a system lynox
 *  names itself is text. While its counts are still pending (see bulkCountsPending) the size reads
 *  "–", as the head's counts do. */
export function bulkLabelParts(run: Pick<BulkRun, 'kind' | 'total' | 'targetSystem'>, i18n: BulkI18n, countsPending = false): BulkSentencePart[] {
	if (!bulkHostOf(run.targetSystem)) return [{ text: bulkLabel(run, i18n, countsPending) }];
	const one = !countsPending && run.total === 1 ? '_one' : '';
	const n = countsPending ? i18n.t('bulk.head.counts_pending') : String(run.total);
	return bulkSentenceParts(i18n.t(run.kind === 'undo' ? `bulk.label_undo${one}` : `bulk.label${one}`), 'target', { n });
}

/** A run has no title: it is named by its size and where it writes. While its counts are still
 *  pending (see bulkCountsPending) the size reads "–", as the head's counts do. */
export function bulkLabel(run: Pick<BulkRun, 'kind' | 'total' | 'targetSystem'>, i18n: BulkI18n, countsPending = false): string {
	const one = !countsPending && run.total === 1 ? '_one' : '';
	const n = countsPending ? i18n.t('bulk.head.counts_pending') : String(run.total);
	return i18n.tf(run.kind === 'undo' ? `bulk.label_undo${one}` : `bulk.label${one}`, { n, target: bulkSystemName(run.targetSystem, i18n) });
}

/** The undo offer's sentence: written targets only, written plus targets of which it is open
 *  whether the change arrived, or only those. The open ones are named apart from the written ones
 *  (the head's count), because the undo reads them first and resets only where the run's value is. */
export function bulkUndoExplainText(run: Pick<BulkRunDetailData, 'undoableParts'>, i18n: BulkI18n): string {
	const open = run.undoableParts?.open ?? 0;
	if (open === 0) return i18n.t('bulk.undo.explain');
	const one = open === 1 ? '_one' : '';
	const key = run.undoableParts!.written > 0 ? `bulk.undo.explain_open${one}` : `bulk.undo.explain_open_only${one}`;
	return i18n.tf(key, { n: String(open) });
}

/** The undo approval's count sentence. `n` is every target the undo gives a value back; of those,
 *  `undoOpen` take back a write that was never confirmed, so they are not counted as getting a
 *  value back but named as checked first. */
export function bulkUndoApproveText(run: Pick<BulkRunDetailData, 'changes' | 'undoOpen'>, i18n: BulkI18n): string {
	const n = run.changes.update + run.changes.create;
	const open = Math.min(run.undoOpen ?? 0, n);
	if (open === 0) return i18n.tf(bulkOne('bulk.undo.approve_explain', n), { n: String(n) });
	const openOne = open === 1 ? '_one' : '';
	const written = n - open;
	if (written === 0) return i18n.tf(`bulk.undo.approve_open_only${openOne}`, { n: String(open) });
	const head = i18n.tf(written === 1 ? 'bulk.undo.approve_written_one' : 'bulk.undo.approve_written', { w: String(written) });
	return `${head} ${i18n.tf(`bulk.undo.approve_open_more${openOne}`, { n: String(open) })} ${i18n.t('bulk.undo.approve_changed_stay')}`;
}

/** The line about targets that held another value than expected when lynox last read them, or
 *  null when there are none. Worded for every case: after a send without a clear answer lynox did
 *  send to them (so not "not written"), an undo expects what its source wrote (so not "since the
 *  preview"), a later resume reads them again (so of the last read only), and a local run has no
 *  provider to name. */
export function bulkConflictsText(run: Pick<BulkRun, 'conflicts' | 'heads'>, i18n: BulkI18n): string | null {
	// The head's conflicts where the engine sends them: a target two loops raced on is written
	// and still carries the losing loop's conflict, and lynox did not leave it as it was.
	const n = run.heads?.conflict ?? run.conflicts;
	if (n <= 0) return null;
	return n === 1 ? i18n.t('bulk.conflicts_one') : i18n.tf('bulk.conflicts', { n: String(n) });
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

/** Whether the engine is moving the run on by itself right now: reading its list or judging it
 *  (planned, no halt), or writing it (approved, or writing without a halt). Every other state
 *  waits for the owner or has ended, so the page has nothing to wait for there. */
export function bulkEngineWorking(run: Pick<BulkRunDetailData, 'phase' | 'haltKey' | 'haltReason'>): boolean {
	// Any halt, by its key or by a reason this page does not know (an engine newer than the page).
	if (run.haltKey !== null || run.haltReason !== null) return false;
	return run.phase === 'planned' || run.phase === 'approved' || run.phase === 'writing';
}

/** Whether the engine is reading the run's list now, by what the runs list knows of a run: the
 *  same step as the page's {@link bulkWorkingStep} `list`, while the list is still to be read and
 *  no halt stands (a list is read before the run can be approved, so no phase needs naming). The
 *  list's title and count then read „–“ as the page's do: nothing is counted yet. */
export function bulkReadsList(run: Pick<BulkRun, 'phase' | 'haltKey' | 'haltReason' | 'list'>): boolean {
	return bulkEngineWorking(run) && run.list?.state === 'pending';
}

/** The step the engine is working on while it moves a run on by itself, for the page's working
 *  line: reading the list (its first page is set only while the list is still being read),
 *  reading the targets, judging them (a judged run reads them in the same step), writing, or
 *  taking a run back (an undo writes too). Null for a run the engine is not working on ({@link bulkEngineWorking}). */
export type BulkWorkingStep = 'list' | 'read' | 'judge' | 'write' | 'undo';

export function bulkWorkingStep(run: Pick<BulkRunDetailData, 'phase' | 'haltKey' | 'haltReason' | 'listFirstPage' | 'judge' | 'kind'>): BulkWorkingStep | null {
	if (!bulkEngineWorking(run)) return null;
	if (run.phase === 'approved' || run.phase === 'writing') return run.kind === 'undo' ? 'undo' : 'write';
	if (run.listFirstPage !== null) return 'list';
	return run.judge !== null ? 'judge' : 'read';
}

/** The working line of a step: its key and the run's numbers it names. Judging counts the
 *  verdicts out of the targets the judge reads (an engine that does not count them gets the
 *  line without numbers); writing and taking back count the targets done out of those the run
 *  plans to write. A target the read turns invalid leaves the judge's count: the targets it
 *  judges can shrink while it reads them. Reading the list or the targets names no number: the engine does not count it. */
export function bulkWorkingLine(
	step: BulkWorkingStep,
	run: Pick<BulkRun, 'judge' | 'applied' | 'changes'>,
): { key: string; params: Record<string, string> } {
	if (step === 'judge') {
		const judged = run.judge?.judged;
		if (judged === undefined) return { key: 'bulk.working.judge_open', params: {} };
		return { key: 'bulk.working.judge', params: { k: String(judged), n: String(judged + (run.judge?.unjudged ?? 0)) } };
	}
	if (step === 'write' || step === 'undo') {
		// Out of every target the run plans to write: `applied` counts each once, one found as
		// planned too, so it never passes them. Read as done, not as written: the head counts a
		// target found so as unchanged. An approval or a probe that ends the write earlier
		// halts the run, and the halt's sentence says why; the line is gone then.
		return { key: `bulk.working.${step}`, params: { a: String(run.applied), n: String(bulkWriting(run)) } };
	}
	return { key: `bulk.working.${step}`, params: {} };
}

/** Whether the run's size is not known yet: while the list is read, the targets are still being
 *  found, so the title and the head show a dash instead of a number. */
export function bulkCountsPending(step: BulkWorkingStep | null): boolean {
	return step === 'list';
}

/** Phases before the run writes: planned (reading, judging), previewed, approved. */
const BULK_BEFORE_WRITE: ReadonlySet<BulkPhase> = new Set(['planned', 'previewed', 'approved']);

/** The head's counts. While the list is read there is nothing to count yet. Until the run has
 *  begun to write (the probe or the run), only the number of targets stands: a „geschrieben 0 ·
 *  Konflikte 0 · fehlgeschlagen 0“ before any write reads as a finished run. Once a target is
 *  written, in conflict or failed, the counts stand whatever the phase: each target in one class
 *  ({@link bulkHeadParts}), so they add up to the number of targets. An engine that sends no
 *  classes gets the overlapping counts it has. */
export function bulkHeadCounts(
	step: BulkWorkingStep | null,
	run: Pick<BulkRunDetailData, 'kind' | 'phase' | 'total' | 'applied' | 'conflicts' | 'failed' | 'heads' | 'haltKey' | 'probe' | 'haltReason'>,
	i18n: BulkI18n,
): string {
	if (step === 'list') return i18n.t('bulk.head.counts_pending');
	const n = String(run.total);
	if (BULK_BEFORE_WRITE.has(run.phase) && run.applied === 0 && run.conflicts === 0 && run.failed === 0) return i18n.tf(bulkOne('bulk.heads.total', run.total), { n });
	if (run.heads === undefined) {
		return i18n.tf(run.kind === 'undo' ? 'bulk.head.counts_undo' : 'bulk.head.counts', { n, a: String(run.applied), c: String(run.conflicts), f: String(run.failed) });
	}
	return i18n.tf(bulkOne('bulk.heads.line', run.total), { n, parts: bulkHeadParts(run, run.heads, i18n).join(' · ') });
}

/** Phases after which the run writes nothing more. */
const BULK_ENDED: ReadonlySet<BulkPhase> = new Set(['done', 'aborted', 'undone']);

/** The classes the head names, in the engine's rank order, except that the written targets
 *  come before the ones taken back, and both kinds of taken back are named together. Written, conflicts and failed always
 *  stand, at 0 too: they are what the owner looks for. Every other class stands only when it
 *  holds a target. A target taken back without having been written counts with the ones taken
 *  back: for the owner the old value is back either way. An undo run's writes are what it took
 *  back, and what it in turn took back is restored. The rest is open while the run may still
 *  write it. Once the run has ended, or halted with no way on (`bulkResumeKind` `none`), lynox
 *  has no result for it: it may hold a send whose answer was never recorded, so it is not called
 *  not written. */
export function bulkHeadParts(run: Pick<BulkRunDetailData, 'kind' | 'phase' | 'haltKey' | 'probe' | 'haltReason'>, heads: BulkHeads, i18n: BulkI18n): string[] {
	const undo = run.kind === 'undo';
	const noWayOn = BULK_ENDED.has(run.phase) || ((run.phase === 'approved' || run.phase === 'writing')
		&& run.haltKey !== null && BULK_RESUME_NONE.has(run.haltKey) && !bulkAtProbe(run));
	const parts: [key: string, n: number, always: boolean][] = [
		['bulk.heads.deselected', heads.deselected, false],
		['bulk.heads.invalid', heads.invalid, false],
		['bulk.heads.unchanged', heads.unchanged, false],
		[undo ? 'bulk.heads.undone' : 'bulk.heads.written', heads.written, true],
		[undo ? 'bulk.heads.restored' : 'bulk.heads.undone', heads.takenBack + heads.settled, false],
		[bulkOne('bulk.heads.conflict', heads.conflict), heads.conflict, true],
		[bulkOne('bulk.heads.unclear', heads.unclear), heads.unclear, false],
		['bulk.heads.failed', heads.failed, true],
		[noWayOn ? 'bulk.heads.no_result' : 'bulk.heads.open', heads.open, false],
	];
	return parts.filter(([, n, always]) => always || n > 0).map(([key, n]) => i18n.tf(key, { n: String(n) }));
}

/** How the page follows a run the engine is moving on: it asks for the run every `BULK_FOLLOW_MS`
 *  while the tab is visible, loads it whole once the run stopped working, and gives up after
 *  `BULK_FOLLOW_MAX_MS` (a run still working then is reloaded by the owner). The engine allows a
 *  client (by IP) 120 requests a minute, and an idle tab already asks about 28 (active runs every
 *  4 s, the status bar every 30 s): one ask every 5 s adds 12. A refused ask (429 or any failure)
 *  waits longer each time — twice as long, at least as long as Retry-After says, at most
 *  `BULK_FOLLOW_BACKOFF_MAX_MS` — and never turns the page into an error. */
export const BULK_FOLLOW_MS = 5000;
export const BULK_FOLLOW_MAX_MS = 10 * 60 * 1000;
export const BULK_FOLLOW_BACKOFF_MAX_MS = 60_000;

/** The next wait of a follow loop after an ask: back to the base after a good answer, longer
 *  after a refused one (`retryAfterS` from a 429's Retry-After, when it names seconds). */
export function bulkFollowDelay(prev: number, ok: boolean, retryAfterS: number | null): number {
	if (ok) return BULK_FOLLOW_MS;
	const asked = retryAfterS !== null && Number.isFinite(retryAfterS) && retryAfterS > 0 ? retryAfterS * 1000 : 0;
	return Math.min(Math.max(prev * 2, asked), BULK_FOLLOW_BACKOFF_MAX_MS);
}

/** Whether the run can be taken back now: an apply run that stopped, has something an undo
 *  would take back, and is not at its probe (that has its own way back). An atomic run is taken
 *  back whole or not at all, so only once it finished: the engine refuses any other
 *  (`atomic_partial`), and one that aborted has already rolled back what it could. */
export function bulkCanUndo(run: Pick<BulkRunDetailData, 'kind' | 'phase' | 'haltReason' | 'undoable' | 'probe' | 'atomic'> & Partial<Pick<BulkRunDetailData, 'undoableParts'>>): boolean {
	if (run.kind !== 'apply' || run.undoable <= 0 || bulkAtProbe(run)) return false;
	// Only what the head shows as written, or a send of which it is open whether it arrived: a run
	// whose every other send the host refused changed nothing an undo could take back. This trusts
	// the engine's reading of a refusal: a send counts as refused only on an answer that says the
	// host did not act; a timeout or an unreadable answer stays open.
	if (run.undoableParts !== undefined && run.undoableParts.written + run.undoableParts.open === 0) return false;
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
export function bulkRollbackText(run: Pick<BulkRun, 'phase' | 'haltKey'> & Partial<Pick<BulkRun, 'kind'>>, i18n: BulkI18n): { cause: string; incomplete: boolean } | null {
	const key = run.haltKey;
	if (run.phase !== 'aborted' || key === null) return null;
	const incomplete = BULK_ROLLBACK_INCOMPLETE.has(key);
	if (!incomplete && !BULK_ROLLED_BACK.has(key)) return null;
	// An undo's names the run it takes back: the page links those words ({@link bulkRolledBackParts}).
	return { cause: i18n.tf(bulkHaltKeyOf(run, `bulk.halt.${key}`), { link: i18n.t('bulk.resume.none_undo_link') }), incomplete };
}

/** An atomic undo that rolled back says to start it again from the page of the run it undoes:
 *  its sentence split around the words the page links to that run. Null for any other run, and
 *  for an undo that names no run (its sentence then stands as {@link bulkRollbackText} words it). */
export function bulkRolledBackParts(
	run: Pick<BulkRun, 'phase' | 'haltKey' | 'kind' | 'sourceRunId'>,
	i18n: Pick<BulkI18n, 't'>,
): { before: string; link: string; after: string } | null {
	if (run.kind !== 'undo' || run.phase !== 'aborted' || run.sourceRunId === null) return null;
	if (run.haltKey !== 'atomicRolledBack' && run.haltKey !== 'atomicTimeRolledBack') return null;
	const [before = '', after = ''] = i18n.t(`bulk.halt.${run.haltKey}_undo`).split('{link}');
	return { before, link: i18n.t('bulk.resume.none_undo_link'), after };
}

/** The halts that end an unapproved run before it wrote anything: another judged run took its
 *  place, or the access that planned it ended. Both leave the run aborted. */
const BULK_ENDED_UNAPPROVED = new Set(['superseded', 'mandateEnded', 'discarded']);

/** The label key of the button that starts a run waiting for its start, exactly as the page
 *  shows it; null where the page shows no button (a judge it cannot use, or a list or judge
 *  the run lacks the data to show). */
export function bulkStartButtonKey(
	run: Pick<BulkRunDetailData, 'listFirstPage' | 'judgeServedBy' | 'judgeRule'>,
	kind: BulkStartKind | null,
	supersedable: boolean,
): string | null {
	if (kind === 'read') return 'bulk.start.read';
	if (kind === 'list') return run.listFirstPage ? 'bulk.start.list' : null;
	if (kind === 'judge') return run.judgeServedBy && run.judgeRule ? (supersedable ? 'bulk.start.supersede_yes' : 'bulk.start.judge') : null;
	return null;
}

/** The page's own sentences for the halts that neither a restart nor writing on moves past: a
 *  run waiting for its start, one at a probe it may not write past yet, and one ended before it
 *  was approved. `cause` replaces the engine's reason; `step` says what the owner does next.
 *  `startButton`: the label of the start button the page shows ({@link bulkStartButtonKey}),
 *  null when it shows none. Null on any other halt. */
export function bulkStateText(
	run: Pick<BulkRunDetailData, 'phase' | 'haltKey' | 'probe' | 'haltReason' | 'listFirstPage' | 'judge' | 'judgeServedBy' | 'judgeOwnKey'> & Partial<Pick<BulkRunDetailData, 'kind'>>,
	startButton: string | null,
	i18n: BulkI18n,
): { cause: string; step: string | null } | null {
	const key = run.haltKey;
	if (key === null) return null;
	if (bulkWaitsForStart(run)) {
		if (startButton !== null) return { cause: i18n.tf(`bulk.halt.${key}_start`, { button: startButton }), step: null };
		// No button: a judge the run cannot use has its note on the page; a judge it can use but
		// no button means the rule went only to the owner, and someone else is looking.
		return { cause: i18n.t(bulkStartKind(run) === 'judge' ? 'bulk.halt.wait_owner_only' : 'bulk.halt.wait_no_start'), step: null };
	}
	// Set only while writing (bulk-apply), where the probe panel can stand.
	if (key === 'probeRequired' && run.phase === 'writing') {
		// The probe panel stands only where the server offers a probe confirming can file.
		return { cause: i18n.t('bulk.halt.probeRequired'), step: i18n.t(bulkAtProbe(run) ? 'bulk.halt.probeRequired_confirm' : 'bulk.halt.probeRequired_replan') };
	}
	if (run.phase === 'aborted' && BULK_ENDED_UNAPPROVED.has(key)) return { cause: i18n.t(bulkHaltKeyOf(run, `bulk.halt.${key}`)), step: null };
	return null;
}

/** What the page says under "halted because": its own sentence where it has one, else the
 *  engine's reason. `startButton` as for {@link bulkStateText}. `mandate`: a session the page
 *  offers no act (a mandate's, or one whose owner is not known yet) is shown no step that names a
 *  button it does not see: a run waiting for its start says who starts it. */
export function bulkHaltCause(
	run: Parameters<typeof bulkHaltText>[0] & Parameters<typeof bulkResumeText>[0] & Parameters<typeof bulkStateText>[0],
	managed: boolean | null,
	startButton: string | null,
	i18n: BulkI18n,
	mandate = false,
): string {
	if (bulkAtProbe(run) && run.haltKey === 'maxTargets') return i18n.t('bulk.halted_after_probe');
	const own = bulkHaltText(run, managed, i18n, false)?.cause ?? bulkResumeText(run, managed, i18n, false)?.cause ?? bulkRollbackText(run, i18n)?.cause
		// A store's own cause has the page's sentence in every phase, never the engine's reason.
		?? (run.haltKey !== null && (BULK_STORE_CAUSES_NO_WAY_ON.has(run.haltKey) || BULK_STORE_CAUSES_GOING_ON.has(run.haltKey)) ? i18n.t(`bulk.halt.${run.haltKey}`) : undefined);
	if (own !== undefined) {
		// A mandate sees no step to go on with: it reads that the owner can, where the page offers the owner that.
		const key = run.haltKey;
		if (mandate && key !== null && BULK_STORE_CAUSES_GOING_ON.has(key) && bulkOwnerGoesOn(run)) return `${own} ${i18n.t(`bulk.halt.${key}_before_mandate`)}`;
		return own;
	}
	if (mandate && bulkWaitsForStart(run)) return i18n.t('bulk.halt.wait_owner_only');
	const state = bulkStateText(run, startButton, i18n);
	if (state !== null) return state.step === null || mandate ? state.cause : `${state.cause} ${state.step}`;
	return run.haltReason ?? '';
}

/** The page's sentence for a start check's refusal on a store's own cause (the engine's code
 *  `reach_approve_<cause>` or `reach_resume_<cause>`, U-232): approving says to approve again once
 *  the cause is gone, writing on says the halt's cause. Null for any other code. */
export function bulkReachRefusalKey(code: string): string | null {
	const m = /^reach_(approve|resume)_([A-Za-z]+)$/.exec(code);
	if (m === null || !(BULK_STORE_CAUSES_GOING_ON.has(m[2]!) || BULK_STORE_CAUSES_NO_WAY_ON.has(m[2]!))) return null;
	return m[1] === 'approve' ? `bulk.reach.approve.${m[2]!}` : `bulk.halt.${m[2]!}`;
}

/** Whether a start check refused approving or writing on, on a store's cause that no wait and no
 *  retry clears (the instance is self-hosted; the store's preset pins no API version): the page then
 *  offers neither for that run, and the cause stands as the reason. */
export function bulkReachHopeless(code: string | undefined): boolean {
	const m = code === undefined ? null : /^reach_(?:approve|resume)_([A-Za-z]+)$/.exec(code);
	return m !== null && BULK_STORE_CAUSES_NO_WAY_ON.has(m[1]!);
}

/** Whether the page offers the owner to continue the run from this halt: a restart for a planned
 *  run, writing on for one that wrote. Not checking: that is not continuing the run, and the
 *  mandate's sentence says the owner can continue it. */
function bulkOwnerGoesOn(run: Parameters<typeof bulkHaltText>[0] & Parameters<typeof bulkResumeText>[0]): boolean {
	if (run.phase === 'planned') {
		const restart = bulkRestartKind(run);
		return restart !== null && !BULK_NO_RESTART_BUTTON.has(restart);
	}
	const resume = bulkResumeKind(run);
	return resume === 'write' || resume === 'max';
}

/** The address the support halts point to. */
export const BULK_SUPPORT_EMAIL = 'support@lynox.ai';

/** The halts whose sentence on a managed instance sends the owner to support. */
const BULK_SUPPORT_HALTS = new Set(['blocked', 'shopifyWriteOff']);

/** A `mailto:` link to support for a halt whose sentence names support, with a subject naming
 *  the run and its host and nothing else from the run; null on any other halt, on a
 *  self-hosted instance, and where the page shows no such sentence. */
export function bulkSupportMailto(
	run: Pick<BulkRunDetailData, 'id' | 'phase' | 'haltKey' | 'targetSystem' | 'probe' | 'haltReason' | 'probeConfirmed' | 'maxTargets' | 'changes' | 'listFirstPage' | 'judge' | 'judgeServedBy' | 'judgeOwnKey' | 'sentUnknown' | 'resumeSends' | 'resumeTries' | 'resumeOpen' | 'conflicts'>,
	managed: boolean | null,
	i18n: BulkI18n,
): string | null {
	if (managed === false || run.haltKey === null || !BULK_SUPPORT_HALTS.has(run.haltKey)) return null;
	// The sentence stands with the way on: a restart for a planned run, writing on for one that wrote.
	// `nothing` leaves the halt's own sentence out, so the link has nothing to stand with.
	const resumeKind = run.phase === 'planned' ? null : bulkResumeKind(run);
	// A planned run the page offers no restart for shows no step that promises one (ux U-105 L1),
	// so no sentence for the link either.
	const restartKind = run.phase === 'planned' ? bulkRestartKind(run) : null;
	const shown = run.phase === 'planned' ? restartKind !== null && !BULK_NO_RESTART_BUTTON.has(restartKind)
		: resumeKind !== null && resumeKind !== 'nothing';
	if (!shown) return null;
	const subject = i18n.tf('bulk.halt.support_subject', { run: run.id, host: bulkSystemName(run.targetSystem, i18n) });
	return `mailto:${BULK_SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}`;
}

/** Whether an atomic run's rollback did not complete, so the page has targets to mark. The page
 *  then loads every target: a mark on a page the owner never opens would not be seen. */
export function bulkRollbackIncomplete(run: Pick<BulkRun, 'phase' | 'haltKey'>): boolean {
	return run.phase === 'aborted' && run.haltKey !== null && BULK_ROLLBACK_INCOMPLETE.has(run.haltKey);
}

/** Whether the page marks this target: the run's rollback did not complete, and this is a
 *  target it wrote, or sent to without recording it, and did not take back. */
export function bulkRollbackLeft(run: Pick<BulkRun, 'phase' | 'haltKey'>, target: Pick<BulkTarget, 'written' | 'undone'>): boolean {
	return bulkRollbackIncomplete(run) && target.written === true && target.undone !== true;
}

/** How many targets the owner still writes whose SEO text gains an `&`: the products
 *  the preview's line names. One the owner took out is not counted. */
export function bulkSeoEntityCount(targets: readonly Pick<BulkTarget, 'seoEntityFields' | 'deselected'>[]): number {
	return targets.filter((x) => (x.seoEntityFields?.length ?? 0) > 0 && x.deselected !== true).length;
}

export const BULK_STEPS = ['planned', 'preview', 'approval', 'probe', 'run', 'done'] as const;
export type BulkStepName = (typeof BULK_STEPS)[number];

type BulkStepRun = Pick<BulkRunDetailData, 'probe' | 'haltReason' | 'phase' | 'targetSystem' | 'probeConfirmed' | 'probeOwn' | 'changes'>
	& Partial<Pick<BulkRunDetailData, 'haltKey' | 'applied' | 'conflicts' | 'failed' | 'sentUnknown'>>;

/** Whether the run has a probe step: two or more targets to write (counted as the write counts
 *  them), and its probe does not hold yet or it confirmed one of its own. A run at its probe is
 *  the first: the server names a probe only for an external run whose probe does not hold.
 *  With one target the one write is the whole run, also where the engine files it as a probe. */
export function bulkHasProbeStep(run: BulkStepRun): boolean {
	if (bulkWriting(run) < 2) return false;
	return (bulkHostOf(run.targetSystem) !== null && !run.probeConfirmed) || run.probeOwn === true;
}

/** The steps the run shows: {@link BULK_STEPS}, without the probe where it has none. */
export function bulkSteps(run: BulkStepRun): readonly BulkStepName[] {
	return bulkHasProbeStep(run) ? BULK_STEPS : BULK_STEPS.filter((s) => s !== 'probe');
}

/** Which of {@link BULK_STEPS} the run is at, or null where the page cannot know. A run without
 *  a probe step writes its one target under "run", though the engine may hold it there as at a
 *  probe. The chip marks the step the run stands at, not how it ended (U-342): an approved run
 *  that halted before it sent anything still stands at its approval; an aborted run stands where
 *  it was writing; a run that ended before its approval may never have been previewed, so no
 *  step is marked, except a discarded one, whose last step reads „verworfen“. */
export function bulkStep(run: BulkStepRun): BulkStepName | null {
	if (run.phase === 'planned') return 'planned';
	if (run.phase === 'previewed') return 'approval';
	if (bulkAtProbe(run) && bulkHasProbeStep(run)) return 'probe';
	if (run.phase === 'approved' && run.haltReason !== null && bulkSentNothing(run)) return 'approval';
	if (run.phase === 'approved' || run.phase === 'writing') return 'run';
	if (run.phase === 'aborted') {
		if (run.haltKey === 'discarded') return 'done';
		return run.haltKey !== null && run.haltKey !== undefined && BULK_ENDED_UNAPPROVED.has(run.haltKey) ? null : 'run';
	}
	return 'done';
}

/** Whether the run has sent nothing yet: nothing written, in conflict, failed or sent unknown. A
 *  count the page was not given does not count as none: the run then stands at its run. */
function bulkSentNothing(run: BulkStepRun): boolean {
	return [run.applied, run.conflicts, run.failed, run.sentUnknown].every((n) => n === 0);
}

/** The i18n key of a step's chip. An undone run's last step reads as the list reads its phase
 *  („zurückgenommen“), not „fertig“: its values are no longer live. A discarded run's reads
 *  „verworfen“ the same way: it was never written. */
export function bulkStepLabelKey(run: Pick<BulkRun, 'phase'> & Partial<Pick<BulkRun, 'haltKey'>>, step: BulkStepName): string {
	if (step === 'done' && run.phase === 'undone') return 'bulk.phase.undone';
	if (step === 'done' && run.phase === 'aborted' && run.haltKey === 'discarded') return 'bulk.phase.discarded';
	return `bulk.step.${step}`;
}

/** Whether a target's after-value is shown as not live: an undo or a rollback took it back, or, on
 *  a run taken back, the owner took it out before the write, so it never was. */
export function bulkAfterTakenBack(run: Pick<BulkRun, 'phase'>, target: Pick<BulkTarget, 'undone' | 'deselected'>): boolean {
	return target.undone === true || (run.phase === 'undone' && target.deselected === true);
}

/** The sentence over an undone run: when it was taken back and how many targets have their value
 *  back. Null for a run that is not undone, or an engine that does not name its undo. */
export function bulkUndoneText(
	run: Pick<BulkRunDetailData, 'phase' | 'undone' | 'undoneBy'>, locale: string, i18n: BulkI18n,
): string | null {
	if (run.phase !== 'undone' || !run.undoneBy) return null;
	const d = new Date(run.undoneBy.at);
	if (Number.isNaN(d.getTime())) return null;
	const loc = locale === 'de' ? 'de-CH' : 'en-US';
	const date = d.toLocaleDateString(loc, { day: '2-digit', month: '2-digit', year: 'numeric' });
	const time = d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
	return run.undone === 1
		? i18n.tf('bulk.undone.sentence_one', { date, time })
		: i18n.tf('bulk.undone.sentence', { date, time, n: String(run.undone) });
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
	not_in_filter: 'not_in_filter',
	cut_off: 'cut_off', verdict_invalid: 'verdict_invalid', verdict_without_after: 'verdict_without_after',
	markup_in_text: 'markup_in_text', hidden_char: 'hidden_char', seo_text_refused: 'seo_text_refused', shop_added_markup: 'shop_added_markup',
	// The HTML check's refusals reach a Shopify owner since descriptions are written.
	element_not_allowed: 'markup_not_allowed', attribute_not_allowed: 'markup_not_allowed', content_changed: 'content_changed',
	new_img: 'new_img', not_canonical: 'not_canonical',
	comment_added: 'comment_added_shopify', html_too_long: 'html_too_long',
};
/** The rule a model's answer broke, as the engine keeps it with `verdict_invalid`. */
export interface BulkRefusalDetail {
	field: string;
	kind: string;
	limit?: number | undefined;
}
/** The rule kinds the page words; a kind it does not know reads as the sentence without a field. */
export const BULK_REFUSAL_KINDS: readonly string[] = ['required', 'type', 'enum', 'pattern', 'maxLength', 'minLength', 'minimum', 'maximum', 'maxItems'];
/** Kinds whose sentence names the rule's bound. */
const BULK_REFUSAL_BOUNDED: ReadonlySet<string> = new Set(['maxLength', 'minLength', 'minimum', 'maximum', 'maxItems']);

/**
 * The sentence for an answer the rule refused, unfilled, and the rule it broke (with its bound)
 * as the text for its `{rule}`; null where the engine kept no such detail or its kind is not one
 * the page words: the caller then reads the sentence without a field. The page splits the
 * sentence at `{field}` before anything is filled ({@link bulkSentenceParts}) and puts the field
 * in as it names fields elsewhere (a readable name, or the rule's own name set apart).
 */
export function bulkRefusalSentence(
	detail: BulkRefusalDetail | undefined, shopify: boolean, i18n: BulkI18n,
): { template: string; rule: string } | null {
	if (detail === undefined || !BULK_REFUSAL_KINDS.includes(detail.kind)) return null;
	const bounded = BULK_REFUSAL_BOUNDED.has(detail.kind);
	if (bounded && (detail.limit === undefined || !Number.isFinite(detail.limit))) return null;
	const rule = bounded ? i18n.tf(`bulk.invalid.refusal.${detail.kind}`, { n: String(detail.limit) }) : i18n.t(`bulk.invalid.refusal.${detail.kind}`);
	return { template: i18n.t(shopify ? 'bulk.invalid.verdict_refused' : 'bulk.invalid.verdict_refused_target'), rule };
}

/** {@link bulkRefusalSentence} as text: the field by its readable name, or the rule's own name. */
export function bulkRefusalText(
	detail: BulkRefusalDetail | undefined, shopify: boolean, host: string | null, i18n: BulkI18n,
): string | null {
	const sentence = bulkRefusalSentence(detail, shopify, i18n);
	if (sentence === null || detail === undefined) return null;
	return fillTemplate(sentence.template, { field: bulkFieldNamesText(host, [detail.field], (k) => i18n.t(k)), rule: sentence.rule });
}

/** Reasons with a sentence of their own on every run, not only on Shopify: the HTML check's refusals
 *  of tags the page reads, whose way out differs from planning again, and of links, in a
 *  shortcode as much as in HTML. */
const BULK_INVALID_ANY_FORM: Readonly<Record<string, string>> = {
	markup_dropped: 'markup_dropped', markup_dropped_before: 'markup_dropped_before',
	shortcode_changed: 'shortcode_changed',
	new_link_domain: 'new_link_domain', url_scheme: 'url_scheme', url_control_char: 'url_control_char',
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
export function bulkInvalidText(
	reason: string, shopify: boolean, managed: boolean | null, i18n: BulkI18n,
	/** With `secret_in_context`: the field that held it, and whether the run is a data-store run's.
	 *  With `before_has_shop_markup`: the date of the earlier write, already formatted, or null.
	 *  `listForm`: the stored list form; `judgesHtml`: the run's rule decides an HTML field;
	 *  `startDomains`: the run takes allowed link domains at the start of judging ({@link bulkTakesStartDomains});
	 *  `linkDomain`: with `new_link_domain`, the domain the refused link points to;
	 *  `refusal`: with `verdict_invalid`, the field and rule the answer broke ({@link bulkRefusalText}). */
	context?: {
		field: string | undefined; host: string | null; dataStore: boolean; markedDate?: string | null | undefined;
		listForm?: string | null | undefined; judgesHtml?: boolean | undefined; startDomains?: boolean; linkDomain?: string | undefined;
		refusal?: BulkRefusalDetail | undefined;
	},
): string {
	// An answer the rule refused names the field and the rule it broke, on every run.
	if (reason === 'verdict_invalid') {
		const refused = bulkRefusalText(context?.refusal, shopify, context?.host ?? null, i18n);
		if (refused !== null) return refused;
	}
	// The description an earlier run wrote and the store added markup to: named
	// by that run's date, so the owner can find it; without the date where the run is gone.
	if (reason === 'before_has_shop_markup') {
		const date = context?.markedDate ?? null;
		return date === null ? i18n.t('bulk.invalid.before_has_shop_markup_undated') : i18n.tf('bulk.invalid.before_has_shop_markup', { date });
	}
	// The field the judge only reads that held a credential, named so the owner knows which one to
	// clean (U-140): on Shopify by its readable name, in the data store by the owner's column name,
	// on any other list by the field's name as the list has it. The engine records the field with
	// the reason, in one write; a target without it (none today) still reads as the sentence, with
	// a dash where the name would be.
	if (reason === 'secret_in_context') {
		const name = context?.field;
		const field = name === undefined ? '—' : shopify ? bulkFieldNamesText(context?.host ?? null, [name], (k) => i18n.t(k)) : bulkVisibleText(name);
		return i18n.tf(bulkSecretInContextKey(shopify, context?.dataStore === true), { field });
	}
	// A WooCommerce run has two HTML fields and the ledger names neither: its own sentence (U-186).
	if (reason === 'html_too_long' && context?.listForm === 'woocommerce') return i18n.t('bulk.invalid.html_too_long_woocommerce');
	// WooCommerce's block editor reads a comment as a block: its own sentence there.
	if (reason === 'comment_added' && context?.listForm === 'woocommerce') return i18n.t('bulk.invalid.comment_added_woocommerce');
	// A description cut off is one the owner may keep by hand, where the products are managed (U-101).
	if (reason === 'cut_off' && context?.judgesHtml === true) {
		const where = shopify ? 'where_shopify' : context.listForm === 'woocommerce' ? 'where_woocommerce' : 'where_other';
		return i18n.tf('bulk.invalid.cut_off_html', { where: i18n.t(`bulk.invalid.${where}`) });
	}
	const anyForm = BULK_INVALID_ANY_FORM[reason];
	if (anyForm !== undefined) {
		// A run that takes allowed link domains at the start of judging names that field as a way out,
		// for a domain the field takes (not an address, not a name without a dot); the list is fixed
		// from the first start, so the way is to plan the run again. Every other run, and a domain the
		// page was not told, reads the sentence without it.
		const addable = context?.linkDomain !== undefined && startDomainOf(context.linkDomain) !== null;
		const key = anyForm === 'new_link_domain' && context?.startDomains === true && addable ? 'new_link_domain_judged' : anyForm;
		const where = i18n.t(shopify ? 'bulk.invalid.where_shopify' : 'bulk.invalid.where_other');
		// The refused domain by name where the engine may show it (U-311): written by the model, so
		// shown as text only and cut to a length; without it, the sentence that names none.
		if (anyForm === 'new_link_domain' && context?.linkDomain !== undefined && context.linkDomain !== '') {
			const domain = bulkLinkDomainShown(context.linkDomain);
			// The judged sentence asks the owner to enter this domain: a cut one would be entered cut.
			if (key !== 'new_link_domain_judged' || domain === bulkVisibleText(context.linkDomain)) {
				return i18n.tf(`bulk.invalid.${key}_named`, { domain, where });
			}
		}
		return i18n.tf(`bulk.invalid.${key}`, { where });
	}
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
		const text = n > 0 && m === 0 && run.changes.unchanged === 0 ? i18n.tf(bulkOne(`bulk.nothing.all_skipped_${noun}`, n), { n: String(n) }) : i18n.t(`bulk.nothing.${noun}`);
		return { text: text + judged, nothing: true };
	}
	if (n > 0 && m > 0) return { text: i18n.tf(bulkOne(`bulk.skipped.both_${noun}`, n), { n: String(n), m: String(m) }) + judged, nothing: false };
	if (n > 0) return { text: i18n.tf(bulkOne(`bulk.skipped.${noun}`, n), { n: String(n) }) + judged, nothing: false };
	if (m > 0) return { text: i18n.tf('bulk.skipped.taken_out', { m: String(m) }), nothing: false };
	return { text: null, nothing: false };
}

/** A value of a target as the preview shows it: text as it is, anything else as JSON. */
export function bulkValueText(v: unknown): string {
	if (v === undefined || v === null || v === '') return '';
	return bulkVisibleText(typeof v === 'string' ? v : JSON.stringify(v));
}

/** A piece of a value as the preview shows it: text, or the mark behind a character the run adds
 *  and the text would not show ({@link bulkHiddenSegments}). */
export type BulkValueSegment = { text: string } | { mark: string; label: string };

/** The kind of a hidden character a run may add in place, by the key of its name. */
const HIDDEN_KIND_KEYS: Readonly<Record<number, string>> = {
	0x00ad: 'bulk.hidden.kind.soft_hyphen',
	0x200c: 'bulk.hidden.kind.zwnj',
	0x200e: 'bulk.hidden.kind.direction',
	0x200f: 'bulk.hidden.kind.direction',
	0x061c: 'bulk.hidden.kind.direction',
	0x200d: 'bulk.hidden.kind.zwj',
	0xfe0f: 'bulk.hidden.kind.vs16',
};

/** `text` cut into graphemes; where the browser has no `Intl.Segmenter`, into code points, so a
 *  mark may then stand inside an emoji but is never left out. */
function graphemes(text: string): string[] {
	if (typeof Intl.Segmenter !== 'function') return Array.from(text);
	return Array.from(new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(text), (s) => s.segment);
}

function codePointName(cp: number): string {
	return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * A value as the preview shows it, with a mark behind each character of `codePoints` the text
 * would not show: hidden characters the engine counted more of in this field than its
 * before-image holds (`hiddenAdds`). Every occurrence is marked, not
 * only the new ones. A mark stands behind the whole grapheme, so an emoji is never cut, and names
 * the kind and code point only in its label. A character the page already shows as its code point
 * gets no mark. In an HTML field (`html`), a character reference that stands for one (`&shy;`) is
 * marked behind it too: the source shows it as text, the store's page carries the character. The
 * segments' text, joined, is the value as {@link bulkValueText} shows it: the mark is the page's,
 * never part of the value.
 */
export function bulkHiddenSegments(text: string, codePoints: readonly number[], i18n: BulkI18n, html = false): BulkValueSegment[] {
	const shown = new Set(hiddenCharIndexes(text));
	const marked = new Set(codePoints);
	// Where a marked reference ends, by its UTF-16 offset: its mark follows the grapheme it ends in.
	const references = html ? inPlaceReferences(text).filter((r) => marked.has(r.cp)) : [];
	const out: BulkValueSegment[] = [];
	let pending = '';
	let at = 0;
	let offset = 0;
	for (const segment of graphemes(text)) {
		const kinds: number[] = [];
		for (const c of segment) {
			const cp = c.codePointAt(0)!;
			if (shown.has(at)) pending += `⟨${codePointName(cp)}⟩`;
			else {
				pending += c;
				if (marked.has(cp) && !kinds.includes(cp)) kinds.push(cp);
			}
			at++;
		}
		const end = offset + segment.length;
		for (const r of references) if (r.end > offset && r.end <= end && !kinds.includes(r.cp)) kinds.push(r.cp);
		offset = end;
		if (kinds.length === 0) continue;
		out.push({ text: pending });
		pending = '';
		const names = kinds.map((cp) => `${i18n.t(HIDDEN_KIND_KEYS[cp] ?? 'bulk.hidden.kind.other')} (${codePointName(cp)})`);
		out.push({ mark: i18n.t('bulk.hidden.mark'), label: i18n.tf('bulk.hidden.label', { kind: names.join(', ') }) });
	}
	if (pending !== '' || out.length === 0) out.push({ text: pending });
	return out;
}

/** A value as text before its hidden characters are shown: text as it is, anything else as JSON,
 *  the text {@link bulkValueText} shows and {@link bulkHiddenSegments} marks. */
export function bulkRawText(v: unknown): string {
	if (v === undefined || v === null || v === '') return '';
	return typeof v === 'string' ? v : JSON.stringify(v);
}

/** The code points a target's field adds that the preview marks; none for a field it does not name. */
export function bulkHiddenAddsOf(target: Pick<BulkTarget, 'hiddenAdds'>, field: string): number[] {
	return target.hiddenAdds?.find((h) => h.field === field)?.codePoints ?? [];
}

/** Whether the engine counted a target's field as HTML, whose character references are marked too. */
export function bulkHiddenHtml(target: Pick<BulkTarget, 'hiddenAdds'>, field: string): boolean {
	return target.hiddenAdds?.find((h) => h.field === field)?.html === true;
}

/** Why a verdict is listed first (engine `bulk-outliers.ts`). */
export type BulkOutlierReason = 'changed_fields' | 'length_jump' | 'new_link' | 'new_email' | 'new_phone' | 'new_script' | 'rare_value';
export type BulkMarkerKind = 'link' | 'email' | 'phone' | 'script';

export interface BulkJudgeOutliers {
	decided: number;
	measured: boolean;
	flagged: { seq: number; reasons: BulkOutlierReason[] }[];
	/** `marked`: how many of `hosts`, at its start, mark a row; absent counts as none. `seqs`: the
	 *  verdicts that add the kind, in plan order; absent, the line offers no way to show them. */
	spread: { kind: BulkMarkerKind; count: number; hosts: string[]; marked?: number; seqs?: number[] }[];
}

/** How many flagged verdicts the view lists first; the count line names the rest (U-387). */
export const BULK_OUTLIERS_FIRST = 50;

/** The targets in the order the approval view lists them: the first {@link BULK_OUTLIERS_FIRST}
 *  flagged ones in their own order, then every other in its own order (U-387). */
export function bulkOutlierOrder<T extends { seq: number }>(targets: readonly T[], outliers: BulkJudgeOutliers | null | undefined): T[] {
	if (!outliers || outliers.flagged.length === 0) return [...targets];
	const first = new Set(outliers.flagged.slice(0, BULK_OUTLIERS_FIRST).map((f) => f.seq));
	return [...targets.filter((t) => first.has(t.seq)), ...targets.filter((t) => !first.has(t.seq))];
}

/** Each flagged target's reasons by its seq, looked up once per row. */
export function bulkOutlierReasonMap(outliers: BulkJudgeOutliers | null | undefined): Map<number, BulkOutlierReason[]> {
	return new Map((outliers?.flagged ?? []).map((f) => [f.seq, f.reasons]));
}

/** The line over the list (U-387): how many verdicts differ, that they come first, and that one
 *  that does not stand out can still be wrong. Under 20 verdicts: read every one. */
export function bulkOutlierCountText(outliers: BulkJudgeOutliers | null | undefined, i18n: BulkI18n): string | null {
	if (!outliers) return null;
	if (!outliers.measured) return i18n.t('bulk.outliers.small');
	const n = outliers.flagged.length;
	if (n === 0) return i18n.t('bulk.outliers.none');
	if (n > BULK_OUTLIERS_FIRST) return i18n.tf('bulk.outliers.over', { n: String(n), first: String(BULK_OUTLIERS_FIRST) });
	return i18n.tf(bulkOne('bulk.outliers.count', n), { n: String(n) });
}

/** How many hosts that mark no row a line names; the rest it counts. */
export const BULK_SPREAD_UNMARKED_SHOWN = 5;
/** How many hosts that mark a row a line names; the rest it counts in a sentence of its own: past
 *  this many, a host planted among throwaway ones hides by their number, not by a fold. */
export const BULK_SPREAD_MARKED_SHOWN = 20;

/** The lines for a kind of marker many verdicts add (U-387): count, kind and hosts as text,
 *  never as a link. The way out stands once below them ({@link bulkOutlierSpreadClosing}, U-417). The hosts that mark a row come first, up to twenty, the rarest
 *  first: past the first fifty flagged rows the line is the one place they show. Then up to five of the
 *  others and how many more, and how many more marking hosts there are, in a sentence of its own. */
export function bulkOutlierSpreadTexts(outliers: BulkJudgeOutliers | null | undefined, i18n: BulkI18n): string[] {
	if (!outliers) return [];
	return outliers.spread.map((s) => {
		const n = String(s.count);
		// A host is not running text: every hidden character in it is shown (`inPlace: false`).
		const marked = Math.min(Math.max(s.marked ?? 0, 0), s.hosts.length);
		const others = s.hosts.slice(marked);
		const shownMarked = Math.min(marked, BULK_SPREAD_MARKED_SHOWN);
		const listed = [...s.hosts.slice(0, shownMarked), ...others.slice(0, BULK_SPREAD_UNMARKED_SHOWN)].map((h) => visibleText(h, { inPlace: false }));
		const rest = others.length - Math.min(others.length, BULK_SPREAD_UNMARKED_SHOWN);
		const markedRest = marked - shownMarked;
		const hosts = s.kind === 'link' || s.kind === 'email'
			? (rest > 0
				? i18n.tf(`bulk.outliers.spread.${s.kind}_hosts_more`, { hosts: listed.join(', '), k: String(rest) })
				: i18n.tf(`bulk.outliers.spread.${s.kind}_hosts`, { hosts: listed.join(', ') }))
				+ (markedRest > 0 ? i18n.tf(bulkOne(`bulk.outliers.spread.${s.kind}_marked_more`, markedRest), { m: String(markedRest) }) : '')
			: '';
		return i18n.tf(bulkOne(`bulk.outliers.spread.${s.kind}`, s.count), { n, hosts });
	});
}

/** The sentence below the lines of {@link bulkOutlierSpreadTexts}, once however many there are (U-417),
 *  or null for none. */
export function bulkOutlierSpreadClosing(outliers: BulkJudgeOutliers | null | undefined, i18n: BulkI18n): string | null {
	return outliers && outliers.spread.length > 0 ? i18n.t('bulk.outliers.spread.closing') : null;
}

/** The verdicts a run line shows the table on, or null where no kind is chosen or the server named none. */
export function bulkOutlierSpreadSeqs(outliers: BulkJudgeOutliers | null | undefined, kind: BulkMarkerKind | null): Set<number> | null {
	if (!outliers || kind === null) return null;
	const seqs = outliers.spread.find((s) => s.kind === kind)?.seqs;
	return seqs === undefined ? null : new Set(seqs);
}

/** The button at the end of a line: the table on that line's verdicts alone, or back to all (U-417). */
export function bulkOutlierShowText(count: number, shown: boolean, i18n: BulkI18n): string {
	return shown ? i18n.t('bulk.outliers.spread.show_all') : i18n.tf(bulkOne('bulk.outliers.spread.show', count), { n: String(count) });
}

/** The line over a table shown on one line's verdicts alone (U-417): without it, a reader in the table
 *  takes it for the whole run, and the approval is for the whole run. */
export function bulkOutlierFilteredText(kind: BulkMarkerKind, count: number, i18n: BulkI18n): string {
	return i18n.tf(bulkOne(`bulk.outliers.filtered.${kind}`, count), { n: String(count) });
}

/** The line an approval and a probe's confirmation show when targets add hidden characters, or
 *  null for none (a mark among hundreds of targets is not left to be found). */
export function bulkHiddenCountText(n: number | null | undefined, shopify: boolean, i18n: BulkI18n): string | null {
	if (n === null || n === undefined || n <= 0) return null;
	// Products on Shopify, targets elsewhere, as every count beside it (U-218).
	return i18n.tf(bulkOne(shopify ? 'bulk.hidden.count_products' : 'bulk.hidden.count', n), { n: String(n) });
}

/** The line beside it for targets with a field lynox could not check for hidden characters, or
 *  null for none: a missing mark there says nothing (U-294). */
export function bulkUncheckedCountText(n: number | null | undefined, shopify: boolean, i18n: BulkI18n): string | null {
	if (n === null || n === undefined || n <= 0) return null;
	return i18n.tf(bulkOne(shopify ? 'bulk.unchecked.count_products' : 'bulk.unchecked.count', n), { n: String(n) });
}

/** Whether the engine could not check this field of a target for hidden characters. */
export function bulkHiddenUnchecked(target: Pick<BulkTarget, 'hiddenUnchecked'>, field: string): boolean {
	return target.hiddenUnchecked?.includes(field) === true;
}
