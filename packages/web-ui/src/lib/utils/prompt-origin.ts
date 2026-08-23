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
 * A workflow name and a step id come from a manifest, and a manifest can be
 * model-authored: `validateManifest` requires `min(1)` and imposes no ceiling.
 * This label sits directly above Allow/Deny, so an unbounded string would push
 * the buttons out of the viewport — and "the user cannot see what they are
 * agreeing to" is the actual failure this whole feature exists to prevent.
 */
const MAX_LABEL = 80;
/** The task is prose on its own line, so it may run longer than a label. */
const MAX_TASK = 160;

/** C0/C1 controls — a newline would turn one label into several lines. */
// eslint-disable-next-line no-control-regex -- removing them is the point
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;
/**
 * Bidi marks and overrides — they render text in an order it is not written in —
 * plus the zero-width formatters, which fill a label that looks empty. This
 * field is a workflow label and never a person's name, so unlike the shared
 * `sanitizeFramingField` it can afford to drop LRM/RLM as well.
 */
const BIDI_CHARS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069\u200B-\u200D\uFEFF]/g;

/**
 * Strip what can forge a label rather than fill it, then bound the length.
 *
 * This does NOT try to defeat lookalike quotes — a name containing
 * `" - Schritt "` can still read like two fields. That is handled where it
 * belongs: the renderer puts the workflow and the step in SEPARATE elements, so
 * the separator between them is structure the content cannot reach, not
 * punctuation it can imitate.
 */
function clean(value: string, max: number): string {
	const stripped = value.replace(CONTROL_CHARS, '').replace(BIDI_CHARS, '').trim();
	if (stripped.length <= max) return stripped;
	// Cut on CODE POINTS, not UTF-16 units: `slice` on a string whose (max-1)th
	// unit is a lead surrogate splits the pair and leaves a lone half, which
	// renders as U+FFFD. An emoji in a workflow name is ordinary, not exotic.
	return `${[...stripped].slice(0, max - 1).join('')}…`;
}

/**
 * Build an origin from three loosely-typed fields, or `undefined` when none of
 * them carries anything. Empty counts as absent: a prompt with no origin must
 * render NO origin line, and an empty frame is worse than none — it claims a
 * workflow asked and then fails to name it. A value that is nothing BUT control
 * characters cleans down to empty and is therefore absent too.
 */
export function toPromptOrigin(workflowName: unknown, stepId: unknown, stepTask: unknown): PromptOrigin | undefined {
	const name = typeof workflowName === 'string' ? clean(workflowName, MAX_LABEL) : '';
	const step = typeof stepId === 'string' ? clean(stepId, MAX_LABEL) : '';
	const task = typeof stepTask === 'string' ? clean(stepTask, MAX_TASK) : '';
	if (!name && !step && !task) return undefined;
	const o: PromptOrigin = {};
	if (name) o.workflowName = name;
	if (step) o.stepId = step;
	if (task) o.stepTask = task;
	return o;
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
