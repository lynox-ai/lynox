/**
 * The shape of a workflow step's id. An id reaches the model wherever a run, a diagnosis or an edit
 * names its step, and the owner needs it to repair a plan, so it cannot be left out. Its shape is
 * therefore limited: free text in an id would read as lynox's own words next to it (U-204).
 *
 * A new id (saved, run inline, added or renamed by an edit) must have this shape. An id stored
 * before the limit is shown by its position instead of its text (U-314), and a run still runs it.
 */

/** The longest a step id may be. */
export const STEP_ID_MAX = 40;

const STEP_ID_SHAPE = new RegExp(`^[a-z0-9_-]{1,${String(STEP_ID_MAX)}}$`);

/** Whether `id` is a step id in the allowed shape: 1 to 40 characters from a-z, 0-9, `_` and `-`. */
export function isStepIdShape(id: unknown): id is string {
  return typeof id === 'string' && STEP_ID_SHAPE.test(id);
}

/**
 * Why a step id outside the shape is refused, naming where it is (`steps[2].id`) and never the id
 * itself: the model reads this text, so it carries no stored or typed text back (U-314). Where the
 * model writes the whole step list (a save, an inline run), the last sentence asks it to carry the new
 * id into the steps that read this one: their `input_from` is checked against the ids, so a missed one
 * is refused, while a `{{<id>.result}}` in a task is not. An edit's `rename_step` carries the
 * references itself, and an `add_step` has none, so `refs: false` leaves the sentence out there.
 */
export function stepIdRefusal(where: string, { refs = true }: { refs?: boolean } = {}): string {
  return `${where}: a step id is 1 to ${String(STEP_ID_MAX)} characters, lowercase a-z, digits 0-9, _ or -, for example fetch_orders. `
    + 'Choose an id in that form.' + (refs ? ' If other steps refer to this step, use the new id there too.' : '');
}

/** The first step whose id is outside the shape, as `stepIdRefusal` names it, or null. */
export function stepIdIssue(steps: ReadonlyArray<{ id?: unknown }>, path = 'steps'): string | null {
  const at = steps.findIndex(s => !isStepIdShape(s.id));
  return at === -1 ? null : stepIdRefusal(`${path}[${String(at)}].id`);
}

/** What stands in for a stored id outside the shape where the model reads it. */
export const OUTSIDE_SHAPE = '(id outside the allowed form)';

/**
 * A stored step id as the model reads it: the id itself when it has the shape, otherwise its position
 * (`#2`, as `update_workflow_steps` takes it) with a note, or the note alone where no position is known.
 */
export function shownStepId(id: string, index?: number): string {
  if (isStepIdShape(id)) return id;
  return index === undefined ? OUTSIDE_SHAPE : `#${String(index + 1)} ${OUTSIDE_SHAPE}`;
}

/** The step ids of a stored workflow row in their stored order, or undefined when there is no row or
 *  its definition does not parse: the positions {@link shownStepId} names. */
export function storedStepOrder(row: { manifest_json: string } | undefined): string[] | undefined {
  if (!row) return undefined;
  try {
    const steps = (JSON.parse(row.manifest_json) as { steps?: unknown }).steps;
    return Array.isArray(steps) ? steps.map(s => String((s as { id?: unknown } | null)?.id ?? '')) : undefined;
  } catch {
    return undefined;
  }
}
