// Shapes and pure helpers for the bulk-run surface (BulkRunsView, BulkRunDetail). The shapes
// mirror what core's `/api/bulk/runs…` routes return; only the fields the surface reads.
// The translator comes in as an argument: i18n is a Svelte module, and these stay testable
// without the Svelte plugin.

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

/** Characters that show nothing or reorder what is shown: invisible format characters, the bidi
 *  overrides and isolates, the tag block, the supplementary variation selectors (a run of them
 *  carries arbitrary bytes a model can decode), and the control characters but tab, newline and
 *  carriage return. The ones a language needs are not here: ZWJ and ZWNJ, the direction marks
 *  (LRM, RLM, ALM), the soft hyphen, and the variation selectors U+FE00–FE0F an emoji is drawn by.
 *
 *  A copy of core's `HIDDEN_CHARS` (`src/core/hidden-chars.ts`), which refuses the same set in a
 *  judge rule at planning: the web UI is a package of its own. `tests/hidden-chars-drift.test.ts`
 *  holds the two equal, code point by code point. */
export const BULK_HIDDEN_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u180E\u200B\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\u3164\uFEFF\uFFF9-\uFFFB\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

/** Text the owner reads before a run acts on it, with every hidden character shown as its code
 *  point. Not removed: the run reads the text as it is, so what the owner reads must be that
 *  text too — a removed character would be one the owner never saw and the model still reads. */
export function bulkVisibleText(text: string): string {
	return text.replace(BULK_HIDDEN_CHARS, (c) => `⟨U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩`);
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
