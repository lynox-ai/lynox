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
	return typeof v === 'string' ? v : JSON.stringify(v);
}
