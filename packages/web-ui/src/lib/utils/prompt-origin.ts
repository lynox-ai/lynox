/**
 * Who asked. A confirmation raised from inside a workflow step has no visible
 * cause in the transcript — the step's tool calls never enter it — so the engine
 * ships the origin on the prompt itself and the dialog renders it.
 *
 * Lives here rather than in `chat.svelte.ts` so it can be tested: that module is
 * a Svelte rune file and the root vitest config carries no svelte plugin, so
 * importing it throws `$state is not defined`.
 */

export interface PromptOrigin {
	workflowName?: string;
	stepId?: string;
	stepTask?: string;
}

/**
 * Build an origin from three loosely-typed fields, or `undefined` when none of
 * them carries anything. Empty strings count as absent: a prompt with no origin
 * must render NO origin line, and an empty frame is worse than none — it claims
 * a workflow asked and then fails to name it.
 */
export function toPromptOrigin(workflowName: unknown, stepId: unknown, stepTask: unknown): PromptOrigin | undefined {
	const o: PromptOrigin = {};
	if (typeof workflowName === 'string' && workflowName) o.workflowName = workflowName;
	if (typeof stepId === 'string' && stepId) o.stepId = stepId;
	if (typeof stepTask === 'string' && stepTask) o.stepTask = stepTask;
	return o.workflowName ?? o.stepId ?? o.stepTask ? o : undefined;
}

/** Origin off a live SSE prompt event — flat, snake_case wire fields. */
export function originFromEvent(data: Record<string, unknown>): PromptOrigin | undefined {
	return toPromptOrigin(data['workflow_name'], data['step_id'], data['step_task']);
}

/** Origin off `GET /pending-prompt` — the nested object persisted in v52. */
export function originFromPending(raw: unknown): PromptOrigin | undefined {
	if (typeof raw !== 'object' || raw === null) return undefined;
	const o = raw as Record<string, unknown>;
	return toPromptOrigin(o['workflowName'], o['stepId'], o['stepTask']);
}
