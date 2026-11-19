/**
 * The button under an answer that opens the bulk run its `bulk_plan` call recorded — a PURE module
 * (no runes), so it is unit-testable like ./follow-ups.ts.
 *
 * The run id comes from the engine's `bulk_run_planned` stream event, which carries the id the
 * ledger minted, never text the model wrote. It is taken only in the ledger's form (a UUID), so
 * nothing else can become part of the address, and the address itself is fixed here: the run's page
 * under Activity › Bulk runs.
 */

import type { FollowUpSuggestion } from './follow-ups.js';

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The run id of a `bulk_run_planned` event, or null when it is not in the ledger's form. */
export function plannedBulkRunId(data: Record<string, unknown>): string | null {
	const id = data['runId'];
	return typeof id === 'string' && RUN_ID.test(id) ? id : null;
}

/** The page of one bulk run: Activity › Bulk runs, with the run open. */
export function bulkRunHref(runId: string): string {
	return `/app/activity?tab=bulk&run=${encodeURIComponent(runId)}`;
}

/**
 * The model's follow-up chips without the ones that name the planned run's id: the button opens the
 * run, and a chip would show the raw id to the user (U-361). A chip counts as naming it when it holds
 * the whole id or its first group, the eight characters a model shortens it to. Other chips stay.
 */
export function followUpsWithoutRun(followUps: FollowUpSuggestion[], runId: string | undefined): FollowUpSuggestion[] {
	if (runId === undefined) return followUps;
	const short = runId.toLowerCase().split('-')[0]!;
	return followUps.filter((f) => !f.label.toLowerCase().includes(short) && !f.task.toLowerCase().includes(short));
}

interface RunBearer {
	role: string;
	content: string;
	toolCalls?: ReadonlyArray<{ name: string; result?: string | undefined }> | undefined;
	plannedBulkRunId?: string | undefined;
}

/**
 * Keeps the button when the chat takes the server's transcript in place of its own: the server's
 * messages never carry the run id, which reached this browser on the stream only. Each local
 * message's id goes to its counterpart in the adopted list (same role and text, in order, as for the
 * knowledge chips). A message whose text differs from the server's (a reload while the answer was
 * still streaming keeps a longer local text) has no counterpart; its id then goes to the server's
 * answer whose bulk_plan call reported that very run, in the status line the engine writes for it
 * ("Bulk run <id> (…"). A refusal that repeats a string the caller passed matches only if that string
 * holds the whole line with this run's id, and the first match in the transcript, the plan's own
 * answer, is taken. The id stays the one this browser got from the stream; the server's text only
 * says where it belongs. Without either, the id is dropped.
 */
export function carryPlannedBulkRuns(local: readonly RunBearer[], adopted: readonly RunBearer[]): void {
	if (!local.some((m) => m.plannedBulkRunId !== undefined)) return;
	let cursor = 0;
	for (const src of local) {
		let target: RunBearer | undefined;
		for (let j = cursor; j < adopted.length; j++) {
			const cand = adopted[j]!;
			if (cand.role === src.role && cand.content === src.content) {
				target = cand;
				cursor = j + 1;
				break;
			}
		}
		const id = src.plannedBulkRunId;
		if (id === undefined) continue;
		target ??= adopted.find((m) => m.role === 'assistant'
			&& m.toolCalls?.some((tc) => tc.name === 'bulk_plan' && (tc.result ?? '').includes(`Bulk run ${id} (`)) === true);
		if (target && target.plannedBulkRunId === undefined) target.plannedBulkRunId = id;
	}
}
